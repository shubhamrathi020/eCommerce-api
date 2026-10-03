import { Injectable } from '@nestjs/common';
import type { RegisterRequest, Session } from '@ecom/contracts';
import { passwordProblem } from '@ecom/contracts';
import { AppError, assertNoFieldErrors } from '../common/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { PasswordService } from './password.service';
import { type IssuedRefresh, TokenService, randomToken, sha256 } from './tokens';
import { toSession } from './user.mapper';

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Same brute-force policy as the mock adapter (`MAX_FAILED_ATTEMPTS`, `LOCKOUT_MINUTES`). */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
const RESET_MINUTES = 30;
const MINUTE = 60_000;

/** What a successful sign-in hands to the controller: the public session plus the two tokens. */
export interface SignedIn {
  session: Session;
  accessToken: string;
  refresh: IssuedRefresh;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
  ) {}

  async register(request: RegisterRequest): Promise<SignedIn> {
    const name = request.name.trim();
    const email = request.email.trim().toLowerCase();
    const fields: Record<string, string> = {};
    if (!name) fields['name'] = 'Name is required';
    else if (name.length > 80) fields['name'] = 'Use 80 characters or fewer';
    if (!EMAIL.test(email) || email.length > 254) fields['email'] = 'Enter a valid email address';
    const problem = passwordProblem(request.password);
    if (problem) fields['password'] = problem;
    assertNoFieldErrors(fields);
    if (await this.db.user.findUnique({ where: { email } })) {
      // Neutral wording, identical to the mock: never confirm that an address is registered.
      throw new AppError('validation', 'We could not create the account with these details. If you already have an account, sign in or reset your password.');
    }
    const verifyToken = randomToken();
    const user = await this.db.user.create({ data: { name, email, passwordHash: await this.passwords.hash(request.password), verifyTokenHash: sha256(verifyToken) } });
    this.mail.send({ to: user.email, subject: 'Verify your email address', body: `Hi ${user.name}, please confirm your email address to finish setting up your account.`, link: `/account/verify-email?token=${verifyToken}` });
    return this.signIn(user.id);
  }

  async login(rawEmail: string, password: string): Promise<SignedIn> {
    const email = rawEmail.trim().toLowerCase();
    const now = Date.now();
    const attempts = await this.db.loginAttempt.findUnique({ where: { email } });
    if (attempts?.lockedUntil && attempts.lockedUntil.getTime() > now) {
      const minutes = Math.max(1, Math.ceil((attempts.lockedUntil.getTime() - now) / MINUTE));
      throw new AppError('forbidden', `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    const user = await this.db.user.findUnique({ where: { email } });
    // Verify even when the account does not exist, so response time does not reveal it.
    const ok = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !ok) {
      const fresh = !attempts || now - attempts.firstAt.getTime() > LOCKOUT_MINUTES * MINUTE;
      const count = fresh ? 1 : attempts.count + 1;
      const data = { count, firstAt: fresh ? new Date(now) : attempts.firstAt, lockedUntil: count >= MAX_FAILED_ATTEMPTS ? new Date(now + LOCKOUT_MINUTES * MINUTE) : null };
      await this.db.loginAttempt.upsert({ where: { email }, create: { email, ...data }, update: data });
      throw new AppError('unauthorized', 'Incorrect email or password.');
    }
    await this.db.loginAttempt.deleteMany({ where: { email } });
    return this.signIn(user.id);
  }

  /** Exchanges the refresh cookie for a new access token, a rotated refresh token and the current session. */
  async refresh(refreshToken: string | undefined): Promise<SignedIn> {
    const { userId, refresh } = await this.tokens.rotate(refreshToken);
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    return { session: toSession(user, refresh.expiresAt), accessToken: this.tokens.accessToken(user.id, user.roles), refresh };
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const family = await this.tokens.familyOf(refreshToken);
    if (family) await this.tokens.revokeFamily(family);
  }

  async session(userId: string, refreshExpiresAt?: Date): Promise<Session> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    return toSession(user, refreshExpiresAt ?? new Date(Date.now() + 15 * MINUTE));
  }

  async verifyEmail(token: string): Promise<void> {
    const user = token ? await this.db.user.findUnique({ where: { verifyTokenHash: sha256(token) } }) : null;
    if (!user) throw new AppError('validation', 'This verification link is invalid or has already been used.');
    await this.db.user.update({ where: { id: user.id }, data: { emailVerified: true, verifyTokenHash: null } });
  }

  /** Always succeeds, so the response never reveals whether the address has an account. */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { email: rawEmail.trim().toLowerCase() } });
    if (!user) return;
    const token = randomToken();
    await this.db.user.update({ where: { id: user.id }, data: { resetTokenHash: sha256(token), resetExpires: new Date(Date.now() + RESET_MINUTES * MINUTE) } });
    this.mail.send({ to: user.email, subject: 'Reset your password', body: `Use this link within ${RESET_MINUTES} minutes to choose a new password. If you did not ask for it, ignore this email.`, link: `/account/reset-password?token=${token}` });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const problem = passwordProblem(newPassword);
    if (problem) throw new AppError('validation', problem, { password: problem });
    const user = token ? await this.db.user.findUnique({ where: { resetTokenHash: sha256(token) } }) : null;
    if (!user?.resetExpires || user.resetExpires.getTime() < Date.now()) throw new AppError('validation', 'This reset link is invalid or has expired.');
    await this.db.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(newPassword), resetTokenHash: null, resetExpires: null } });
    await this.db.loginAttempt.deleteMany({ where: { email: user.email } });
    // A password reset signs out every device (the old password may have been stolen).
    await this.tokens.revokeAllForUser(user.id);
  }

  private async signIn(userId: string): Promise<SignedIn> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const refresh = await this.tokens.issueRefresh(user.id);
    return { session: toSession(user, refresh.expiresAt), accessToken: this.tokens.accessToken(user.id, user.roles), refresh };
  }
}
