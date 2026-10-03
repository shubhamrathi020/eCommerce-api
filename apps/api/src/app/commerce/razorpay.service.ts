import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import RazorpayClient from 'razorpay';
import { API_CONFIG, type ApiConfig } from '../config';
import { AppError } from '../common/app-error';
import { CircuitBreaker, CircuitOpenError, type CircuitStats } from '../resilience/circuit-breaker';
import { withRetry } from '../resilience/retry';

/**
 * Real Razorpay integration (BRD 21, CM21-05) — test mode only, gated on your own keys in
 * `apps/api/.env` (never committed, never pasted anywhere by an assistant). With no keys set, the API
 * still starts and cash-on-delivery still works; `PaymentApi.initiate` refuses with a clear message.
 *
 * Resilience (BRD 24, OB-05): every provider call is timed out, retried once on a transient blip, and
 * counted by a circuit breaker — after 3 consecutive failures the breaker opens for 30 seconds and
 * `initiate`/refund calls fail fast with a clear "temporarily unavailable" message instead of hanging or
 * retrying into an already-struggling provider. Cash on delivery is a completely separate code path
 * (`OrderService`, no Razorpay involved at all), so a Razorpay outage never blocks placing an order.
 */
@Injectable()
export class RazorpayService {
  private readonly client: RazorpayClient | null;
  private readonly breaker = new CircuitBreaker('razorpay', { failureThreshold: 3, cooldownMs: 30_000, timeoutMs: 8_000 });
  private readonly logger = new Logger('RazorpayService');

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.client = config.razorpayEnabled ? new RazorpayClient({ key_id: config.razorpayKeyId, key_secret: config.razorpayKeySecret }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  breakerStats(): CircuitStats {
    return this.breaker.stats();
  }

  private requireClient(): RazorpayClient {
    if (!this.client) throw new AppError('validation', 'Online payment is not set up on this server yet. Please choose cash on delivery, or ask the site owner to add Razorpay test keys.');
    return this.client;
  }

  /** Every failure here — one call that failed even after retrying, or the breaker already open —
   * surfaces as the same friendly `AppError`, never the raw Razorpay SDK/HTTP exception (which
   * `ApiErrorFilter` would otherwise turn into an opaque generic 500 instead of a clear, actionable 503
   * that also reminds the shopper cash on delivery still works). */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.breaker.exec(() => withRetry(fn, { attempts: 2, baseDelayMs: 300 }));
    } catch (error) {
      if (!(error instanceof CircuitOpenError)) this.logger.warn(`razorpay call failed: ${(error as Error).message}`);
      throw new AppError('network', 'Online payment is temporarily unavailable. Please choose cash on delivery, or try again in a minute.');
    }
  }

  /** Creates the provider-side order Razorpay's checkout widget needs. `receipt` is our own order id. */
  async createOrder(amountPaise: number, receipt: string): Promise<{ id: string }> {
    const client = this.requireClient();
    const order = await this.guarded(() => client.orders.create({ amount: amountPaise, currency: 'INR', receipt }));
    return { id: order.id };
  }

  /** The signature the checkout widget hands back after a successful payment: HMAC-SHA256 of
   * "<order_id>|<payment_id>" keyed with the account secret (Razorpay's documented scheme). Verified
   * server-side with a constant-time comparison — the secret never reaches the browser. */
  verifyPaymentSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean {
    if (!this.config.razorpayKeySecret) return false;
    const expected = createHmac('sha256', this.config.razorpayKeySecret).update(`${providerOrderId}|${providerPaymentId}`).digest('hex');
    return safeEqual(expected, signature);
  }

  /** Webhook calls (payment.captured, payment.failed, refund.processed, ...) carry this header, an
   * HMAC-SHA256 of the raw request body keyed with the separate webhook secret set in the dashboard. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.config.razorpayWebhookSecret) return false;
    const expected = createHmac('sha256', this.config.razorpayWebhookSecret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  /** Refunds a captured payment (CM21-05, CM21-09's refund side); `amountPaise` omitted refunds in full. */
  async refund(providerPaymentId: string, amountPaise?: number): Promise<{ id: string; status: string }> {
    const client = this.requireClient();
    const refund = await this.guarded(() => client.payments.refund(providerPaymentId, amountPaise !== undefined ? { amount: amountPaise } : {}));
    return { id: refund.id, status: refund.status ?? 'processed' };
  }
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
