import type { Prisma } from '../../../generated/prisma';

/** Reads a Prisma `Json` column back as its real shared-model type (`CartLine[]`, `TimelineEntry[]`, ...).
 * `unknown` is the honest type of anything read out of a schemaless column; this is the one place that
 * trusts it, since every write of that column goes through `toJson()` below and matches the model. */
export function fromJson<T>(value: unknown): T {
  return value as T;
}

/** Writes a typed value into a Prisma `Json` column. Needed because e.g. `TimelineEntry[]` has no index
 * signature, so TypeScript won't accept it as `Prisma.InputJsonValue` directly. */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
