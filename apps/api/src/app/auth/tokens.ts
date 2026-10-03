import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@ecom/contracts';
import { permissionsFor } from '@ecom/contracts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AccessTokenPayload } from '../common/auth';
import { AppError } from '../common/app-error';
import { API_CONFIG, type ApiConfig } from '../config';
import { PrismaService } from '../prisma/prisma.service';

/** SHA-256 is right for high-entropy random tokens (unlike passwords, they cannot be guessed). */
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
}

/**
 * Access tokens are short-lived JWTs held in memory by the client. Refresh tokens are random, stored only as
 * hashes, rotated on every use, and grouped in a "family" per sign-in. Presenting a refresh token that was
 * already rotated means it was copied: the whole family is revoked (BF-03, reuse detection).
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly db: PrismaService,
  ) {}

  accessToken(userId: string, roles: Role[]): string {
    const payload: AccessTokenPayload = { sub: userId, roles, permissions: permissionsFor(roles) };
    return jwt.sign(payload, this.config.jwtAccessSecret, { algorithm: 'HS256', expiresIn: `${this.config.accessTokenMinutes}m`, audience: 'ecom-api', issuer: 'ecom-api', jwtid: randomUUID() });
  }

  /** Starts a new family (a fresh sign-in). */
  issueRefresh(userId: string): Promise<IssuedRefresh> {
    return this.create(userId, randomUUID());
  }

  /** Exchanges a refresh token for a new one. Throws `unauthorized` when missing, expired, revoked or reused. */
  async rotate(token: string | undefined): Promise<{ userId: string; refresh: IssuedRefresh }> {
    if (!token) throw new AppError('unauthorized', 'Please sign in.');
    const row = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row) throw new AppError('unauthorized', 'Please sign in.');
    const now = new Date();
    // Atomically claim the token: only one request can turn it from live into rotated.
    const claimed = await this.db.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: now } });
    if (claimed.count !== 1) {
      await this.revokeFamily(row.family);
      throw new AppError('unauthorized', 'For your safety you have been signed out. Please sign in again.');
    }
    if (row.expiresAt <= now) throw new AppError('unauthorized', 'Your session has expired. Please sign in again.');
    const refresh = await this.create(row.userId, row.family);
    await this.db.refreshToken.update({ where: { id: row.id }, data: { replacedBy: sha256(refresh.token) } });
    return { userId: row.userId, refresh };
  }

  /** The family of a presented refresh token, if it is known (used to keep "this device" signed in). */
  async familyOf(token: string | undefined): Promise<string | undefined> {
    if (!token) return undefined;
    return (await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, select: { family: true } }))?.family;
  }

  async revokeFamily(family: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { family, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  /** Signs the user out everywhere, optionally keeping one family (the device making the change). */
  async revokeAllForUser(userId: string, exceptFamily?: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { userId, revokedAt: null, ...(exceptFamily ? { family: { not: exceptFamily } } : {}) }, data: { revokedAt: new Date() } });
  }

  private async create(userId: string, family: string): Promise<IssuedRefresh> {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTokenDays * 86_400_000);
    await this.db.refreshToken.create({ data: { userId, family, tokenHash: sha256(token), expiresAt } });
    return { token, expiresAt };
  }
}
