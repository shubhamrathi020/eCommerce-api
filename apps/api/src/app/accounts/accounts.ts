import { Body, Controller, Get, HttpCode, Inject, Injectable, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { AccountExport, User } from '@ecom/contracts';
import { passwordProblem } from '@ecom/contracts';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AppError, assertNoFieldErrors } from '../common/app-error';
import { AuthGuard, type AuthUser, CurrentUser, RequirePermissions } from '../common/auth';
import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from '../auth/password.service';
import { clearRefreshCookie, readRefreshCookie } from '../auth/refresh-cookie';
import { TokenService } from '../auth/tokens';
import { toUser } from '../auth/user.mapper';
import { toSavedAddress } from '../addresses/addresses';

const PHONE = /^[6-9][0-9]{9}$/;

export class ProfileDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
}

export class ChangePasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) currentPassword!: string;
  @ApiProperty() @IsString() @MaxLength(200) newPassword!: string;
}

export class PasswordDto {
  @ApiProperty() @IsString() @MaxLength(200) password!: string;
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly db: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  private async user(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    return user;
  }

  async updateProfile(userId: string, changes: ProfileDto): Promise<User> {
    await this.user(userId);
    const fields: Record<string, string> = {};
    const name = changes.name.trim();
    if (!name) fields['name'] = 'Name is required';
    else if (name.length > 80) fields['name'] = 'Use 80 characters or fewer';
    if (changes.phone && !PHONE.test(changes.phone)) fields['phone'] = 'Enter a valid 10-digit mobile number';
    assertNoFieldErrors(fields);
    return toUser(await this.db.user.update({ where: { id: userId }, data: { name, phone: changes.phone || null } }));
  }

  /** Signs out every other device; the one making the change (identified by its refresh cookie) stays signed in. */
  async changePassword(userId: string, current: string, next: string, refreshToken: string | undefined): Promise<void> {
    const user = await this.user(userId);
    if (!(await this.passwords.verify(user.passwordHash, current))) throw new AppError('validation', 'Your current password is incorrect.', { currentPassword: 'Incorrect password' });
    const problem = passwordProblem(next);
    if (problem) throw new AppError('validation', problem, { newPassword: problem });
    await this.db.user.update({ where: { id: userId }, data: { passwordHash: await this.passwords.hash(next) } });
    await this.tokens.revokeAllForUser(userId, await this.tokens.familyOf(refreshToken));
  }

  async exportData(userId: string): Promise<AccountExport> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: { addresses: { orderBy: { createdAt: 'asc' } } } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    const { permissions: _p, ...profile } = toUser(user);
    // Orders still live in the frontend mock until BRD 21 moves them to this API.
    return { exportedAt: new Date().toISOString(), profile, addresses: user.addresses.map(toSavedAddress), orderIds: [] };
  }

  /** Deletes the account and everything that belongs only to it (addresses, sessions) in one step. */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.user(userId);
    if (!(await this.passwords.verify(user.passwordHash, password))) throw new AppError('validation', 'That password is not correct.', { password: 'Incorrect password' });
    await this.db.$transaction([this.db.loginAttempt.deleteMany({ where: { email: user.email } }), this.db.user.delete({ where: { id: userId } })]);
  }
}

@ApiTags('account')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Patch('account/profile')
  @RequirePermissions('profile:write:own')
  updateProfile(@CurrentUser() user: AuthUser, @Body() body: ProfileDto): Promise<User> {
    return this.accounts.updateProfile(user.id, body);
  }

  /** Under `/auth` so the browser sends the refresh cookie, which identifies the device to keep signed in. */
  @Post('auth/change-password')
  @HttpCode(204)
  @RequirePermissions('profile:write:own')
  changePassword(@CurrentUser() user: AuthUser, @Body() body: ChangePasswordDto, @Req() req: Request): Promise<void> {
    return this.accounts.changePassword(user.id, body.currentPassword, body.newPassword, readRefreshCookie(req));
  }

  @Get('account/export')
  exportData(@CurrentUser() user: AuthUser): Promise<AccountExport> {
    return this.accounts.exportData(user.id);
  }

  @Post('account/delete')
  @HttpCode(204)
  @RequirePermissions('profile:write:own')
  async deleteAccount(@CurrentUser() user: AuthUser, @Body() body: PasswordDto, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.accounts.deleteAccount(user.id, body.password);
    clearRefreshCookie(res, this.config.production);
  }
}
