import type { Request, Response } from 'express';
import type { IssuedRefresh } from './tokens';

export const REFRESH_COOKIE = 'rt';
/** Scoped to the auth routes, so the refresh token is never sent with ordinary API calls. */
const PATH = '/auth';

export function setRefreshCookie(res: Response, refresh: IssuedRefresh, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, refresh.token, { httpOnly: true, secure, sameSite: 'lax', path: PATH, expires: refresh.expiresAt });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: PATH });
}

export function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}
