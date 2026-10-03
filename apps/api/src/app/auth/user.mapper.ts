import type { Session, User } from '@ecom/contracts';
import { permissionsFor } from '@ecom/contracts';
import type { User as UserRow } from '../../../generated/prisma';

/** Database row -> the public `User` contract. Password hashes and token hashes never leave this function. */
export function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    ...(row.phone ? { phone: row.phone } : {}),
    roles: row.roles,
    permissions: permissionsFor(row.roles),
    emailVerified: row.emailVerified,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSession(row: UserRow, expiresAt: Date): Session {
  return { user: toUser(row), expiresAt: expiresAt.toISOString() };
}
