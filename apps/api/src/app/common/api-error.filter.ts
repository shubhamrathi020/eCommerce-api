import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiError, ApiErrorCode } from '@ecom/contracts';
import type { Request, Response } from 'express';
import { AppError } from './app-error';

const CODE_FOR_STATUS: Record<number, ApiErrorCode> = { 400: 'validation', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'validation', 429: 'forbidden' };

/**
 * Turns every error into the `ApiError` JSON shape the frontend already handles. Unexpected errors are
 * logged in full with the request id and returned as a generic message: no stack traces or internals leak.
 */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const requestId = String(req.headers['x-request-id'] ?? '');
    let status = 500;
    let body: ApiError;

    if (error instanceof AppError) {
      status = error.status;
      body = { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const code = CODE_FOR_STATUS[status] ?? (status >= 500 ? 'unknown' : 'validation');
      const message = status === 429 ? 'Too many requests. Please wait a moment and try again.' : status === 404 ? 'Not found' : this.messageOf(error);
      body = { code, message };
    } else {
      this.logger.error(JSON.stringify({ requestId, method: req.method, path: req.path, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }));
      body = { code: 'unknown', message: 'Something went wrong. Please try again.' };
    }
    res.status(status).json({ ...body, ...(requestId ? { requestId } : {}) });
  }

  private messageOf(error: HttpException): string {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    // class-validator lists: keep the response shape simple and never echo raw input back.
    if (Array.isArray(message)) return 'The request was not valid.';
    return typeof message === 'string' ? message : 'The request was not valid.';
  }
}
