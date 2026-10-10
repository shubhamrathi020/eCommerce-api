import { createHmac } from 'node:crypto';
import { type TestApp, createTestApp, resetDatabase } from './test-app';

const WEBHOOK_SECRET = 'test-webhook-secret';
const contact = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };
const address = { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
const PRODUCT = '/catalog/products/northline-signature-linen-relaxed-t-shirt-1';
const VARIANT = 'p-0001-v3';

/** A guest that keeps its cart cookie between requests, like one browser. */
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

/**
 * Razorpay's webhook (BRD 21, CM21-05) is the safety net for a payment the browser never reported (closed tab, lost connection,
 * a UPI request approved later). Razorpay sends `payment.failed` for every failed attempt, even while its window stays open and
 * the shopper tries again, so a failed attempt must not give the order's stock back; and a captured payment must do everything
 * the browser's confirm does.
 */
describe('payments: Razorpay webhook', () => {
  let t: TestApp;

  beforeAll(async () => (t = await createTestApp({ razorpayWebhookSecret: WEBHOOK_SECRET })));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  const stock = async () => (await t.http().get(PRODUCT)).body.product.variants.find((v: { id: string }) => v.id === VARIANT).stock as number;

  const webhook = (event: 'payment.captured' | 'payment.failed', providerOrderId: string, paymentId: string, secret = WEBHOOK_SECRET) => {
    const body = JSON.stringify({
      entity: 'event',
      event,
      payload: { payment: { entity: { id: paymentId, order_id: providerOrderId, status: event === 'payment.captured' ? 'captured' : 'failed' } } },
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    return t.http().post('/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', signature).send(body);
  };

  /** Places an online-payment order as a guest and gives it the Razorpay order id that initiate would have stored. */
  async function placeOnlineOrder() {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: VARIANT, quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `wh-${Date.now()}-${Math.random()}`, contact, address, paymentMethod: 'razorpay' });
    expect(placed.status).toBe(201);
    const providerOrderId = `order_TEST${Date.now().toString(36)}`;
    await t.db.order.update({ where: { id: placed.body.id }, data: { providerOrderId } });
    return { guest, orderId: placed.body.id as string, providerOrderId };
  }

  const confirmedEvents = async (orderId: string) =>
    (await t.db.outboxEvent.findMany({ where: { routingKey: 'payment.confirmed' } })).filter((row) => {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      return (payload as { orderId?: string }).orderId === orderId;
    });

  it('a failed attempt keeps the stock hold; a later captured payment confirms the order exactly once', async () => {
    const before = await stock();
    const { guest, orderId, providerOrderId } = await placeOnlineOrder();
    expect(await stock()).toBe(before - 1);

    expect((await webhook('payment.failed', providerOrderId, 'pay_TESTfirst')).status).toBe(200);
    const afterFailed = await guest.get(`/orders/${orderId}`);
    expect(afterFailed.body).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
    expect(await stock()).toBe(before - 1); // still held: the shopper may be retrying in Razorpay's window

    expect((await webhook('payment.captured', providerOrderId, 'pay_TESTsecond')).status).toBe(200);
    const paid = await guest.get(`/orders/${orderId}`);
    expect(paid.body).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    expect(paid.body.timeline.map((e: { status: string }) => e.status)).toEqual(expect.arrayContaining(['paid', 'confirmed']));
    expect(await stock()).toBe(before - 1);
    expect(await confirmedEvents(orderId)).toHaveLength(1); // the confirmation email goes out, as for the browser's confirm

    // Razorpay retries deliveries: a replay changes nothing.
    expect((await webhook('payment.captured', providerOrderId, 'pay_TESTsecond')).status).toBe(200);
    expect(await confirmedEvents(orderId)).toHaveLength(1);
    expect(await stock()).toBe(before - 1);

    await guest.post(`/orders/${orderId}/cancel`);
    expect(await stock()).toBe(before);
  });

  it('a payment captured after the browser reported a failure takes the released stock again', async () => {
    const before = await stock();
    const { guest, orderId, providerOrderId } = await placeOnlineOrder();
    await guest.post(`/orders/${orderId}/payment/fail`, { reason: 'window closed' });
    expect(await stock()).toBe(before); // the browser's report released the hold

    expect((await webhook('payment.captured', providerOrderId, 'pay_TESTlate')).status).toBe(200);
    const paid = await guest.get(`/orders/${orderId}`);
    expect(paid.body).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    expect(await stock()).toBe(before - 1);

    await guest.post(`/orders/${orderId}/cancel`);
    expect(await stock()).toBe(before);
  });

  it('a webhook with a wrong signature is acknowledged but changes nothing', async () => {
    const before = await stock();
    const { guest, orderId, providerOrderId } = await placeOnlineOrder();
    expect((await webhook('payment.captured', providerOrderId, 'pay_TESTforged', 'not-the-secret')).status).toBe(200);
    expect((await guest.get(`/orders/${orderId}`)).body).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
    expect((await webhook('payment.failed', providerOrderId, 'pay_TESTforged', 'not-the-secret')).status).toBe(200);
    expect(await stock()).toBe(before - 1);

    await guest.post(`/orders/${orderId}/cancel`);
    expect(await stock()).toBe(before);
  });
});
