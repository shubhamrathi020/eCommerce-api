import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Session } from '@ecom/contracts';
import type { Request, Response } from 'express';
import { AuthGuard, type AuthUser, CsrfGuard, CurrentUser } from '../common/auth';
import { API_CONFIG, type ApiConfig } from '../config';
import { CartService } from '../commerce/cart.service';
import { readGuestCartToken } from '../commerce/guest-cart-cookie';
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto } from './auth.dto';
import { AuthService, type SignedIn } from './auth.service';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

/** Response body of every sign-in style endpoint. The refresh token only ever travels as an HttpOnly cookie. */
export interface SignInResponse {
  session: Session;
  accessToken: string;
}

/** Strict limits on the endpoints worth brute-forcing (BF-09); the global limit covers the rest. */
const STRICT = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly carts: CartService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('register')
  @Throttle(STRICT)
  async register(@Body() body: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SignInResponse> {
    const signedIn = await this.auth.register(body);
    await this.mergeGuestCart(req, signedIn);
    return this.respond(res, signedIn);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(STRICT)
  async login(@Body() body: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SignInResponse> {
    const signedIn = await this.auth.login(body.email, body.password);
    await this.mergeGuestCart(req, signedIn);
    return this.respond(res, signedIn);
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'x-csrf', description: 'Must be "1" (CSRF protection for cookie-authenticated calls)' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SignInResponse> {
    try {
      return this.respond(res, await this.auth.refresh(readRefreshCookie(req)));
    } catch (error) {
      clearRefreshCookie(res, this.config.production);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CsrfGuard)
  @ApiHeader({ name: 'x-csrf', description: 'Must be "1"' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, this.config.production);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  me(@CurrentUser() user: AuthUser): Promise<Session> {
    return this.auth.session(user.id);
  }

  @Post('verify-email')
  @HttpCode(204)
  @Throttle(STRICT)
  verifyEmail(@Body() body: TokenDto): Promise<void> {
    return this.auth.verifyEmail(body.token);
  }

  @Post('password-reset/request')
  @HttpCode(204)
  @Throttle(STRICT)
  requestReset(@Body() body: EmailDto): Promise<void> {
    return this.auth.requestPasswordReset(body.email);
  }

  @Post('password-reset')
  @HttpCode(204)
  @Throttle(STRICT)
  resetPassword(@Body() body: ResetPasswordDto): Promise<void> {
    return this.auth.resetPassword(body.token, body.password);
  }

  private respond(res: Response, signedIn: SignedIn): SignInResponse {
    setRefreshCookie(res, signedIn.refresh, this.config.production);
    return { session: signedIn.session, accessToken: signedIn.accessToken };
  }

  /** BRD 21's cart merge: whatever was in the guest cart (identified by the `gcid` cookie, if any)
   * moves into the now-signed-in user's own cart — the server-side version of the mock's
   * `MockCartState.mergeGuestIntoUser`, called from the same place the frontend used to call it. */
  private async mergeGuestCart(req: Request, signedIn: SignedIn): Promise<void> {
    const guestToken = readGuestCartToken(req);
    if (guestToken) await this.carts.mergeGuestIntoUser(`guest:${guestToken}`, signedIn.session.user.id);
  }
}
