import { createHmac } from 'node:crypto';
import { loadConfig } from '../config';
import { RazorpayService } from './razorpay.service';

const base = { DATABASE_URL: 'postgresql://x', MONGODB_URL: 'mongodb://x', MEILI_URL: 'http://x', REDIS_URL: 'redis://x', RABBITMQ_URL: 'amqp://x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) };

/** The signature math itself (BRD 21, CM21-05) needs no live Razorpay account to verify: it is a plain
 * HMAC-SHA256 the server computes and compares, exactly what the SDK's checkout widget hands back. */
describe('RazorpayService signature verification', () => {
  it('is disabled with no key configured, and every signature check fails closed', () => {
    const service = new RazorpayService(loadConfig(base));
    expect(service.enabled).toBe(false);
    expect(service.verifyPaymentSignature('order_1', 'pay_1', 'anything')).toBe(false);
    expect(service.verifyWebhookSignature('{}', 'anything')).toBe(false);
  });

  it('accepts a correctly computed payment signature and rejects a wrong one', () => {
    const secret = 'rzp-test-secret-value';
    const service = new RazorpayService(loadConfig({ ...base, RAZORPAY_KEY_ID: 'rzp_test_abc123', RAZORPAY_KEY_SECRET: secret }));
    const good = createHmac('sha256', secret).update('order_abc|pay_xyz').digest('hex');
    expect(service.verifyPaymentSignature('order_abc', 'pay_xyz', good)).toBe(true);
    expect(service.verifyPaymentSignature('order_abc', 'pay_xyz', `${good.slice(0, -1)}0`)).toBe(false);
    expect(service.verifyPaymentSignature('order_other', 'pay_xyz', good)).toBe(false);
  });

  it('accepts a correctly computed webhook signature and rejects a wrong one', () => {
    const webhookSecret = 'rzp-webhook-secret';
    const service = new RazorpayService(loadConfig({ ...base, RAZORPAY_WEBHOOK_SECRET: webhookSecret }));
    const body = JSON.stringify({ event: 'payment.captured' });
    const good = createHmac('sha256', webhookSecret).update(body).digest('hex');
    expect(service.verifyWebhookSignature(body, good)).toBe(true);
    expect(service.verifyWebhookSignature(body, 'not-a-real-signature-at-all')).toBe(false);
    expect(service.verifyWebhookSignature(`${body} `, good)).toBe(false);
  });

  it('refuses to load a live-mode key (never real money in this project)', () => {
    expect(() => loadConfig({ ...base, RAZORPAY_KEY_ID: 'rzp_live_shouldnotwork', RAZORPAY_KEY_SECRET: 'x' })).toThrow(/test-mode key/);
  });
});
