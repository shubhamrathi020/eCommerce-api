import { type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@ecom/contracts';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { API_CONFIG, type ApiConfig } from '../config';
import { AppError } from './app-error';

/** What an authenticated request knows about its caller (from the short-lived access token). */
export interface AuthUser {
  id: string;
  roles: Role[];
  permissions: string[];
}

export interface AccessTokenPayload {
  sub: string;
  roles: Role[];
  permissions: string[];
}

export type AuthedRequest = Request & { user?: AuthUser };

const PERMISSIONS_KEY = 'permissions';
/** Every listed permission is required (BF-04). Implies authentication. */
export const RequirePermissions = (...permissions: string[]) => SetMetadata(PERMISSIONS_KEY, permissions);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new AppError('unauthorized', 'Please sign in.');
  return user;
});

/**
 * Bearer access-token check plus permission enforcement. Applied per controller; the browser-side guards
 * are only a convenience, this is the real boundary.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AppError('unauthorized', 'Please sign in.');
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, this.config.jwtAccessSecret, { algorithms: ['HS256'], audience: 'ecom-api', issuer: 'ecom-api' }) as AccessTokenPayload;
    } catch {
      throw new AppError('unauthorized', 'Your session has expired. Please sign in again.');
    }
    req.user = { id: payload.sub, roles: payload.roles, permissions: payload.permissions };
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
    if (required.some((p) => !payload.permissions.includes(p))) throw new AppError('forbidden', 'You do not have permission to do that.');
    return true;
  }
}

/**
 * For routes usable both signed in and as a guest (cart, checkout, orders — BRD 21). Decodes a bearer
 * token when one is present and valid, setting `req.user`; never refuses the request either way, so
 * `@CurrentUser()` cannot be used here — read `req.user` via `@OptionalUser()` instead.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return true;
    try {
      const payload = jwt.verify(token, this.config.jwtAccessSecret, { algorithms: ['HS256'], audience: 'ecom-api', issuer: 'ecom-api' }) as AccessTokenPayload;
      req.user = { id: payload.sub, roles: payload.roles, permissions: payload.permissions };
    } catch {
      // An expired/invalid token on an optional-auth route is treated the same as no token: still a guest.
    }
    return true;
  }
}

export const OptionalUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

/**
 * CSRF protection for the endpoints that act on the refresh-token cookie (refresh, logout). The cookie is
 * `SameSite=Lax`, and these endpoints additionally require a custom header: a cross-site page cannot send
 * one without a CORS preflight, which only our own origins pass. Bearer-token endpoints do not need this.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.headers['x-csrf'] !== '1') throw new AppError('forbidden', 'Missing CSRF header.');
    return true;
  }
}
