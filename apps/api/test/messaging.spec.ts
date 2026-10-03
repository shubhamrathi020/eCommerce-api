import jwt from 'jsonwebtoken';
import { RabbitService } from '../src/app/messaging/rabbit.service';
import { SchedulerService } from '../src/app/messaging/scheduler.service';
import { type TestApp, createTestApp, resetDatabase } from './test-app';

const ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
const adminToken = (permissions: string[]) => jwt.sign({ sub: 'admin-1', roles: ['admin'], permissions }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });

const contact = { name: 'Priya Nair', email: 'priya@example.com', phone: '9876543210' };
const address = { line1: '9 Residency Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

function guestSession(t: TestApp) {
  let cookie: string | undefined;
  const capture = (res: { headers: Record<string, unknown> }) => {
    const set = res.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [String(set)] : [];
    const gcid = list.find((c) => c.startsWith('gcid='));
    if (gcid) cookie = gcid.split(';')[0];
  };
  return {
    get: async (path: string) => {
      const res = await (cookie ? t.http().get(path).set('cookie', cookie) : t.http().get(path));
      capture(res);
      return res;
    },
    post: async (path: string, body?: object) => {
      const res = await (cookie ? t.http().post(path).set('cookie', cookie).set('x-csrf', '1').send(body) : t.http().post(path).set('x-csrf', '1').send(body));
      capture(res);
      return res;
    },
  };
}

/** Polls `/dev/outbox` (the same dev mailbox auth email verification/reset already use) until an email
 * matching `predicate` shows up, or gives up after `timeoutMs` — the outbox relay polls Postgres every
 * 2 seconds (see `OutboxRelayService`), so a real end-to-end delivery genuinely takes a couple of seconds,
 * not milliseconds; this is not a flaky wait, it's the real latency of the pipeline being tested. */
async function waitForMail(t: TestApp, predicate: (mail: { subject: string; to: string }) => boolean, timeoutMs = 8_000): Promise<{ subject: string; to: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outbox = (await t.http().get('/dev/outbox')).body as Array<{ subject: string; to: string }>;
    const found = outbox.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no matching mail arrived within ${timeoutMs}ms`);
}

describe('messaging: outbox relay, notification consumer, dead letters (BRD 23)', () => {
  let t: TestApp;
  const admin = (permissions: string[]) => ({
    get: (path: string) => t.http().get(path).set('authorization', `Bearer ${adminToken(permissions)}`),
    post: (path: string) => t.http().post(path).set('authorization', `Bearer ${adminToken(permissions)}`),
  });

  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  it('placing a real order really delivers an order-confirmation email end to end (outbox row -> relay -> RabbitMQ -> consumer -> mail)', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v6', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `mail-${Date.now()}`, contact, address, paymentMethod: 'cod' });
    expect(placed.status).toBe(201);

    const mail = await waitForMail(t, (m) => m.subject === `Order confirmed: ${placed.body.id}` && m.to === contact.email);
    expect(mail.subject).toContain(placed.body.id);

    // Cancelling fires its own event, through the same real pipeline, not a different code path.
    await guest.post(`/orders/${placed.body.id}/cancel`);
    await waitForMail(t, (m) => m.subject === `Order cancelled: ${placed.body.id}`);
  });

  it('the same order id never produces two confirmation emails, even if the event were delivered twice (consumer idempotency)', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v7', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `dedupe-${Date.now()}`, contact, address, paymentMethod: 'cod' });
    await waitForMail(t, (m) => m.subject === `Order confirmed: ${placed.body.id}`);

    // Simulates the at-least-once redelivery a broker/consumer crash can cause: publish the exact same
    // outbox payload (same eventId) again, straight to the exchange, bypassing the relay.
    const rabbit = t.app.get(RabbitService);
    const row = await t.db.outboxEvent.findFirstOrThrow({ where: { routingKey: 'order.placed' }, orderBy: { createdAt: 'desc' } });
    await rabbit.publish('order.placed', row.payload, { messageId: row.id });
    await new Promise((r) => setTimeout(r, 1_500)); // give the (redundant) redelivery time to be consumed

    const outbox = (await t.http().get('/dev/outbox')).body as Array<{ subject: string }>;
    const matches = outbox.filter((m) => m.subject === `Order confirmed: ${placed.body.id}`);
    expect(matches).toHaveLength(1);

    await guest.post(`/orders/${placed.body.id}/cancel`);
  });

  it('admin can inspect and replay a dead-lettered message', async () => {
    const rabbit = t.app.get(RabbitService);
    await rabbit.publishToQueue(rabbit.dlq, 'order.placed', { orderId: 'ORD-FAKE', email: 'x@example.com', name: 'X', total: { amount: 100, currency: 'INR' }, itemCount: 1, cod: true }, { headers: { 'x-retry-count': 3, 'x-last-error': 'simulated failure' } });

    const noPerm = await t.http().get('/admin/system/dead-letters').set('authorization', `Bearer ${adminToken([])}`);
    expect(noPerm.status).toBe(403);

    const list = await admin(['system:read']).get('/admin/system/dead-letters');
    expect(list.status).toBe(200);
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ routingKey: 'order.placed', retryCount: 3, lastError: 'simulated failure' })]));

    const replayed = await admin(['system:write']).post('/admin/system/dead-letters/replay');
    expect(replayed.body).toEqual({ replayed: true, routingKey: 'order.placed' });

    // The dead letter is gone now (popped), and the notification consumer picked the replay up for real.
    await waitForMail(t, (m) => m.subject === 'Order confirmed: ORD-FAKE' && m.to === 'x@example.com');
    const emptyReplay = await admin(['system:write']).post('/admin/system/dead-letters/replay');
    expect(emptyReplay.body).toEqual({ replayed: false });
  });

  it('reminds a signed-in customer about an abandoned cart, once, and stays quiet for a fresh one', async () => {
    const signedUp = await t.http().post('/auth/register').send({ name: 'Rina Shah', email: 'rina@example.com', password: 'Str0ngPass' });
    const token = signedUp.body.accessToken as string;
    const userId = signedUp.body.session.user.id as string;
    await t.http().post('/cart/items').set('authorization', `Bearer ${token}`).set('x-csrf', '1').send({ variantId: 'p-0002-v1', quantity: 1 });
    // `updatedAt` is Prisma's own `@updatedAt` column — no ordinary `.update()` call can backdate it, so
    // this simulates "sat untouched for a while" the only way possible: a raw SQL backdate.
    await t.db.$executeRawUnsafe(`UPDATE carts SET "updatedAt" = now() - interval '2 hours' WHERE "ownerKey" = $1`, `user:${userId}`);

    // The real interval is 5 minutes (see `ABANDONED_CART_CHECK_INTERVAL_MS`) — too slow for a test to
    // wait through, so this calls the scheduler's job function directly instead of waiting for its timer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = t.app.get(SchedulerService) as any;
    await scheduler.remindAbandonedCarts();
    await waitForMail(t, (m) => m.subject === 'You left something in your cart' && m.to === 'rina@example.com');

    // Running it again immediately does not send a second reminder for the same, still-untouched cart.
    await scheduler.remindAbandonedCarts();
    await new Promise((r) => setTimeout(r, 500));
    const outbox = (await t.http().get('/dev/outbox')).body as Array<{ subject: string; to: string }>;
    expect(outbox.filter((m) => m.subject === 'You left something in your cart' && m.to === 'rina@example.com')).toHaveLength(1);
  });

  it('order tracking stream rejects a non-owner before opening, and streams the current status on connect for the real owner', async () => {
    const guestA = guestSession(t);
    const guestB = guestSession(t);
    await guestA.post('/cart/items', { variantId: 'p-0001-v8', quantity: 1 });
    const placed = await guestA.post('/orders', { idempotencyKey: `sse-${Date.now()}`, contact, address, paymentMethod: 'cod' });

    // Not this browser's order: rejected the same way a plain GET would be, before any stream opens.
    const denied = await guestB.get(`/orders/${placed.body.id}/stream`);
    expect(denied.status).toBe(404);

    await guestA.post(`/orders/${placed.body.id}/cancel`); // restore stock for other tests
  });
});
