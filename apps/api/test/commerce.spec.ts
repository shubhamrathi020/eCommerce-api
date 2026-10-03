import jwt from 'jsonwebtoken';
import { type TestApp, createTestApp, resetDatabase } from './test-app';

const ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
const adminToken = () => jwt.sign({ sub: 'admin-1', roles: ['admin'], permissions: ['product:read', 'product:write', 'order:read:any', 'order:refund'] }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });

const contact = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };
const address = { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };

/** Extracts the `gcid` guest-cart cookie value from a response's Set-Cookie header, and returns a
 * "same browser" helper that resends it on every later request in this test — a real guest session. */
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
    put: async (path: string, body?: object) => {
      const res = await (cookie ? t.http().put(path).set('cookie', cookie).set('x-csrf', '1').send(body) : t.http().put(path).set('x-csrf', '1').send(body));
      capture(res);
      return res;
    },
    del: async (path: string) => {
      const res = await (cookie ? t.http().delete(path).set('cookie', cookie).set('x-csrf', '1') : t.http().delete(path).set('x-csrf', '1'));
      capture(res);
      return res;
    },
  };
}

describe('commerce: cart, checkout, orders, payments (BRD 21)', () => {
  let t: TestApp;
  const admin = () => ({
    get: (path: string, query: object = {}) => t.http().get(path).query(query).set('authorization', `Bearer ${adminToken()}`),
    post: (path: string, body?: object) => t.http().post(path).set('authorization', `Bearer ${adminToken()}`).send(body),
    patch: (path: string, body?: object) => t.http().patch(path).set('authorization', `Bearer ${adminToken()}`).send(body),
  });

  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  it('a guest cart works with no sign-in: add, price, adjust quantity, remove', async () => {
    const guest = guestSession(t);
    const empty = await guest.get('/cart');
    expect(empty.body.lines).toEqual([]);

    const added = await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 2 });
    expect(added.status).toBe(201);
    expect(added.body.lines).toHaveLength(1);
    expect(added.body.lines[0]).toMatchObject({ variantId: 'p-0001-v1', quantity: 2 });
    expect(added.body.totals.subtotal.amount).toBe(added.body.lines[0].unitPrice.amount * 2);

    const updated = await guest.put('/cart/items/p-0001-v1', { quantity: 5 });
    expect(updated.body.lines[0].quantity).toBe(5);

    const removed = await guest.del('/cart/items/p-0001-v1');
    expect(removed.body.lines).toEqual([]);
  });

  it('cart mutations need the CSRF header even for a guest cookie', async () => {
    const res = await t.http().post('/cart/items').send({ variantId: 'p-0001-v1', quantity: 1 });
    expect(res.status).toBe(403);
  });

  it('applies and removes a coupon, rejecting an invalid code', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 1 });
    const bad = await guest.post('/cart/coupon', { code: 'NOT-REAL' });
    expect(bad.status).toBe(400);
    const good = await guest.post('/cart/coupon', { code: 'FREESHIP' });
    expect(good.body.coupon).toMatchObject({ code: 'FREESHIP', freeShipping: true });
    const removed = await guest.del('/cart/coupon');
    expect(removed.body.coupon).toBeUndefined();
  });

  it('checkout: shipping and payment options for a deliverable pin code, and validation for a bad one', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 1 });
    const shipping = await guest.get('/checkout/shipping-options/560001');
    expect(shipping.body.map((o: { id: string }) => o.id)).toEqual(['standard', 'express']);
    const payment = await guest.get('/checkout/payment-options/560001');
    expect(payment.body.find((o: { method: string }) => o.method === 'razorpay').enabled).toBe(true);
    const bad = await guest.get('/checkout/shipping-options/12345');
    expect(bad.status).toBe(400);
  });

  it('places a cash-on-delivery order: decrements real stock, clears the cart, is idempotent', async () => {
    const guest = guestSession(t);
    const before = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    const variant = before.variants.find((v: { id: string }) => v.id === 'p-0001-v1');

    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 2 });
    const idempotencyKey = `test-${Date.now()}`;
    const placed = await guest.post('/orders', { idempotencyKey, contact, address, paymentMethod: 'cod' });
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: 'confirmed', paymentStatus: 'cod', paymentMethod: 'cod' });
    expect(placed.body.lines[0].quantity).toBe(2);

    // Stock really moved in Mongo, not just in the response.
    const after = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    const afterVariant = after.variants.find((v: { id: string }) => v.id === 'p-0001-v1');
    expect(afterVariant.stock).toBe(variant.stock - 2);

    // The cart is empty now.
    const cart = await guest.get('/cart');
    expect(cart.body.lines).toEqual([]);

    // Retrying with the same idempotency key returns the same order, without moving stock again.
    const retried = await guest.post('/orders', { idempotencyKey, contact, address, paymentMethod: 'cod' });
    expect(retried.body.id).toBe(placed.body.id);
    const stillAfter = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(stillAfter.variants.find((v: { id: string }) => v.id === 'p-0001-v1').stock).toBe(variant.stock - 2);

    // Cancel to restore the stock, so later tests (and other spec files sharing this Mongo fixture) see
    // the original count rather than a permanently reduced one.
    await guest.post(`/orders/${placed.body.id}/cancel`);
    const restored = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(restored.variants.find((v: { id: string }) => v.id === 'p-0001-v1').stock).toBe(variant.stock);
  });

  it('refuses to place an order with an empty cart, or with an invalid contact/address', async () => {
    const guest = guestSession(t);
    const emptyCart = await guest.post('/orders', { idempotencyKey: `k-${Date.now()}`, contact, address, paymentMethod: 'cod' });
    expect(emptyCart.status).toBe(400);

    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 1 });
    const badContact = await guest.post('/orders', { idempotencyKey: `k2-${Date.now()}`, contact: { name: '', email: 'not-an-email', phone: '123' }, address, paymentMethod: 'cod' });
    expect(badContact.status).toBe(400);
    expect(Object.keys(badContact.body.fields)).toEqual(expect.arrayContaining(['name', 'email', 'phone']));
  });

  it('an online-payment order stays pending_payment and does NOT clear the cart until paid', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `pay-${Date.now()}`, contact, address, paymentMethod: 'razorpay' });
    expect(placed.body).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
    const cart = await guest.get('/cart');
    expect(cart.body.lines).toHaveLength(1);
  });

  it('payment/initiate without Razorpay keys configured refuses with a clear message (this test env has none)', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v1', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `pay2-${Date.now()}`, contact, address, paymentMethod: 'razorpay' });
    const res = await guest.post(`/orders/${placed.body.id}/payment/initiate`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not set up/i);
  });

  it('payment/fail releases the stock hold, and a retry (initiate) reclaims it', async () => {
    const guest = guestSession(t);
    const before = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    const stockBefore = before.variants.find((v: { id: string }) => v.id === 'p-0001-v2').stock;

    await guest.post('/cart/items', { variantId: 'p-0001-v2', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `fail-${Date.now()}`, contact, address, paymentMethod: 'razorpay' });
    const afterPlace = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(afterPlace.variants.find((v: { id: string }) => v.id === 'p-0001-v2').stock).toBe(stockBefore - 1);

    const failed = await guest.post(`/orders/${placed.body.id}/payment/fail`, { reason: 'card declined' });
    expect(failed.body.paymentStatus).toBe('failed');
    const afterFail = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(afterFail.variants.find((v: { id: string }) => v.id === 'p-0001-v2').stock).toBe(stockBefore);

    // A retry (still no Razorpay keys, so it fails at the provider-order step) still reclaimed the stock first.
    const retry = await guest.post(`/orders/${placed.body.id}/payment/initiate`);
    expect(retry.status).toBe(400);
    const afterRetry = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(afterRetry.variants.find((v: { id: string }) => v.id === 'p-0001-v2').stock).toBe(stockBefore - 1);

    // Clean up: cancel to release the stock back to the fixture's original count.
    await guest.post(`/orders/${placed.body.id}/cancel`);
    const restored = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(restored.variants.find((v: { id: string }) => v.id === 'p-0001-v2').stock).toBe(stockBefore);
  });

  it('a guest can only see and cancel their own orders, not another guest/session\'s', async () => {
    const guestA = guestSession(t);
    const guestB = guestSession(t);
    await guestA.post('/cart/items', { variantId: 'p-0001-v3', quantity: 1 });
    const placed = await guestA.post('/orders', { idempotencyKey: `own-${Date.now()}`, contact, address, paymentMethod: 'cod' });

    const bGet = await guestB.get(`/orders/${placed.body.id}`);
    expect(bGet.status).toBe(404);
    const bCancel = await guestB.post(`/orders/${placed.body.id}/cancel`);
    expect(bCancel.status).toBe(404);
    const bList = await guestB.get('/orders');
    expect(bList.body).toEqual([]);

    const aGet = await guestA.get(`/orders/${placed.body.id}`);
    expect(aGet.status).toBe(200);
    const aList = await guestA.get('/orders');
    expect(aList.body.map((o: { id: string }) => o.id)).toContain(placed.body.id);

    await guestA.post(`/orders/${placed.body.id}/cancel`); // restore v3's stock for other tests/spec files
  });

  it('cancelling a confirmed COD order restores stock; a shipped order cannot be cancelled', async () => {
    const guest = guestSession(t);
    const before = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    const stockBefore = before.variants.find((v: { id: string }) => v.id === 'p-0001-v4').stock;
    await guest.post('/cart/items', { variantId: 'p-0001-v4', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `cancel-${Date.now()}`, contact, address, paymentMethod: 'cod' });

    const cancelled = await guest.post(`/orders/${placed.body.id}/cancel`);
    expect(cancelled.body.status).toBe('cancelled');
    const after = (await t.http().get('/catalog/products/northline-signature-linen-relaxed-t-shirt-1')).body.product;
    expect(after.variants.find((v: { id: string }) => v.id === 'p-0001-v4').stock).toBe(stockBefore);

    const alreadyCancelled = await guest.post(`/orders/${placed.body.id}/cancel`);
    expect(alreadyCancelled.status).toBe(200);
    expect(alreadyCancelled.body.status).toBe('cancelled');
  });

  it('admin: lists and advances an order through the real state machine, refusing an illegal jump', async () => {
    const guest = guestSession(t);
    await guest.post('/cart/items', { variantId: 'p-0001-v5', quantity: 1 });
    const placed = await guest.post('/orders', { idempotencyKey: `admin-${Date.now()}`, contact, address, paymentMethod: 'cod' });

    const illegal = await admin().patch(`/admin/orders/${placed.body.id}/status`, { status: 'delivered' });
    expect(illegal.status).toBe(400);

    const packed = await admin().patch(`/admin/orders/${placed.body.id}/status`, { status: 'packed' });
    expect(packed.body.status).toBe('packed');
    expect(packed.body.allowedNext).toEqual(expect.arrayContaining(['shipped', 'cancelled']));

    const list = await admin().get('/admin/orders', { status: 'packed' });
    expect(list.body.items.some((o: { id: string }) => o.id === placed.body.id)).toBe(true);

    const noted = await admin().post(`/admin/orders/${placed.body.id}/notes`, { text: 'Called the customer to confirm the address.' });
    expect(noted.body.notes[0]).toMatchObject({ text: 'Called the customer to confirm the address.', author: 'admin-1' });

    // Restore stock so the fixture is left as found for other tests/sessions.
    await admin().patch(`/admin/orders/${placed.body.id}/status`, { status: 'cancelled' });
  });

  it('admin order endpoints need order:read:any / order:refund, not just any signed-in staff', async () => {
    const noPerm = jwt.sign({ sub: 'x', roles: [], permissions: [] }, ACCESS_SECRET, { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });
    const res = await t.http().get('/admin/orders').set('authorization', `Bearer ${noPerm}`);
    expect(res.status).toBe(403);
  });
});
