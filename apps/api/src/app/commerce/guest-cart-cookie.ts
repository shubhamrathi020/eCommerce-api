import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

/** Identifies an anonymous shopper's cart across requests (BRD 21, CM21-01) — not a secret, just an
 * opaque per-browser id, so unlike the refresh-token cookie this one is readable by scripts and long-lived. */
export const GUEST_CART_COOKIE = 'gcid';
const ONE_YEAR_MS = 365 * 86_400_000;

export function readGuestCartToken(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[GUEST_CART_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}

/** Returns the guest cart token, creating and setting a fresh cookie the first time one is needed. */
export function ensureGuestCartToken(req: Request, res: Response, secure: boolean): string {
  const existing = readGuestCartToken(req);
  if (existing) return existing;
  const token = randomBytes(16).toString('base64url');
  res.cookie(GUEST_CART_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ONE_YEAR_MS });
  return token;
}

export function clearGuestCartCookie(res: Response, secure: boolean): void {
  res.clearCookie(GUEST_CART_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

/** The Cart/Order row key for whoever is making this request: the signed-in user if there is one
 * (from `AuthGuard`, when the route allows optional auth), otherwise the guest cart cookie. */
export function ownerKeyFor(userId: string | undefined, guestToken: string): string {
  return userId ? `user:${userId}` : `guest:${guestToken}`;
}
