import type { ApiErrorCode } from '@ecom/contracts';

const STATUS: Record<ApiErrorCode, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  network: 503,
  unknown: 500,
};

/**
 * The only error services throw on purpose. It carries the same `code` and `fields` the frontend's
 * `ApiException` already understands, so the HTTP adapter can rebuild it one-to-one (BF-01).
 */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** Throws a `validation` error when `fields` has any entry (the "check the highlighted fields" pattern). */
export function assertNoFieldErrors(fields: Record<string, string>): void {
  if (Object.keys(fields).length) throw new AppError('validation', 'Please check the highlighted fields.', fields);
}
