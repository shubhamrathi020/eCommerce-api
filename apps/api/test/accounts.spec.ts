import jwt from 'jsonwebtoken';
import { type TestApp, createTestApp, refreshCookie, resetDatabase } from './test-app';

const address = (over: Record<string, unknown> = {}) => ({ label: 'Home', name: 'Asha Rao', phone: '9876543210', address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' }, ...over });

async function signUp(t: TestApp, email = 'asha@example.com') {
  const res = await t.http().post('/auth/register').send({ name: 'Asha Rao', email, password: 'Str0ngPass' });
  return { token: res.body.accessToken as string, cookie: refreshCookie(res.headers['set-cookie']), id: res.body.session.user.id as string };
}

describe('accounts and addresses API', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  const as = (token: string) => ({
    get: (path: string) => t.http().get(path).set('authorization', `Bearer ${token}`),
    post: (path: string, body?: object) => t.http().post(path).set('authorization', `Bearer ${token}`).send(body),
    put: (path: string, body: object) => t.http().put(path).set('authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) => t.http().patch(path).set('authorization', `Bearer ${token}`).send(body),
    del: (path: string) => t.http().delete(path).set('authorization', `Bearer ${token}`),
  });

  it('everything needs a signed-in user', async () => {
    for (const res of [await t.http().get('/account/addresses'), await t.http().patch('/account/profile').send({ name: 'x' }), await t.http().get('/account/export')]) {
      expect(res.body.code).toBe('unauthorized');
    }
  });

  it('enforces permissions on the server, not just in the browser', async () => {
    const noPermissions = jwt.sign({ sub: 'someone', roles: [], permissions: [] }, 'test-access-secret-that-is-at-least-32-chars', { audience: 'ecom-api', issuer: 'ecom-api', expiresIn: '5m' });
    const res = await as(noPermissions).get('/account/addresses');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'forbidden', message: 'You do not have permission to do that.' });
  });

  it('address book: validation, first address is the default, promotion on delete, ten at most', async () => {
    const me = as((await signUp(t)).token);
    const bad = await me.post('/account/addresses', address({ phone: '123', address: { line1: ' ', city: 'B', state: 'K', pincode: '0000' } }));
    expect(bad.body.fields).toEqual({ phone: 'Enter a valid 10-digit mobile number', line1: 'Address is required', pincode: 'Enter a valid 6-digit pin code' });

    await me.post('/account/addresses', address());
    let list = (await me.post('/account/addresses', address({ label: 'Office' }))).body;
    expect(list.map((a: { label: string; isDefault: boolean }) => [a.label, a.isDefault])).toEqual([['Home', true], ['Office', false]]);

    list = (await me.post(`/account/addresses/${list[1].id}/default`)).body;
    expect(list.find((a: { isDefault: boolean }) => a.isDefault).label).toBe('Office');
    list = (await me.del(`/account/addresses/${list[1].id}`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ label: 'Home', isDefault: true });

    list = (await me.put(`/account/addresses/${list[0].id}`, address({ label: 'Parents', address: { line1: '1 Park St', line2: 'Flat 2', city: 'Kolkata', state: 'West Bengal', pincode: '700016' } }))).body;
    expect(list[0]).toMatchObject({ label: 'Parents', address: { line2: 'Flat 2', pincode: '700016' } });

    for (let i = 0; i < 9; i++) await me.post('/account/addresses', address({ label: `A${i}` }));
    expect((await me.post('/account/addresses', address())).body.message).toBe('You can save up to 10 addresses.');
  });

  it("one customer can never read or change another customer's addresses", async () => {
    const asha = as((await signUp(t)).token);
    const ravi = as((await signUp(t, 'ravi@example.com')).token);
    const [mine] = (await asha.post('/account/addresses', address())).body;
    expect((await ravi.get('/account/addresses')).body).toEqual([]);
    expect((await ravi.put(`/account/addresses/${mine.id}`, address({ label: 'Hacked' }))).status).toBe(404);
    expect((await ravi.post(`/account/addresses/${mine.id}/default`)).status).toBe(404);
    await ravi.del(`/account/addresses/${mine.id}`);
    expect((await asha.get('/account/addresses')).body[0].label).toBe('Home');
  });

  it('profile update validates and returns the updated user', async () => {
    const me = as((await signUp(t)).token);
    expect((await me.patch('/account/profile', { name: '', phone: '123' })).body.fields).toEqual({ name: 'Name is required', phone: 'Enter a valid 10-digit mobile number' });
    const ok = await me.patch('/account/profile', { name: 'Asha R', phone: '9876543210' });
    expect(ok.body).toMatchObject({ name: 'Asha R', phone: '9876543210', email: 'asha@example.com' });
  });

  it('changing the password keeps this device signed in and signs out the others', async () => {
    const { token, cookie: thisDevice } = await signUp(t);
    const otherDevice = refreshCookie((await t.http().post('/auth/login').send({ email: 'asha@example.com', password: 'Str0ngPass' })).headers['set-cookie']);
    const wrong = await t.http().post('/auth/change-password').set('authorization', `Bearer ${token}`).set('cookie', thisDevice).send({ currentPassword: 'nope', newPassword: 'N3wPassword' });
    expect(wrong.body.fields).toEqual({ currentPassword: 'Incorrect password' });
    const ok = await t.http().post('/auth/change-password').set('authorization', `Bearer ${token}`).set('cookie', thisDevice).send({ currentPassword: 'Str0ngPass', newPassword: 'N3wPassword' });
    expect(ok.status).toBe(204);
    expect((await t.http().post('/auth/refresh').set('cookie', thisDevice).set('x-csrf', '1')).status).toBe(200);
    expect((await t.http().post('/auth/refresh').set('cookie', otherDevice).set('x-csrf', '1')).status).toBe(401);
  });

  it('exports the data without secrets, and deleting the account removes it and its addresses', async () => {
    const { token, cookie } = await signUp(t);
    const me = as(token);
    await me.post('/account/addresses', address());
    const exported = (await me.get('/account/export')).body;
    expect(exported.profile).toMatchObject({ email: 'asha@example.com' });
    expect(exported.addresses).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toMatch(/passwordHash|permissions|TokenHash/);

    expect((await me.post('/account/delete', { password: 'wrong' })).body.fields).toEqual({ password: 'Incorrect password' });
    expect((await me.post('/account/delete', { password: 'Str0ngPass' })).status).toBe(204);
    expect(await t.db.user.count()).toBe(0);
    expect(await t.db.savedAddress.count()).toBe(0);
    expect((await t.http().post('/auth/refresh').set('cookie', cookie).set('x-csrf', '1')).status).toBe(401);
    // A still-valid access token for a deleted account gets nothing.
    expect((await me.get('/account/export')).body.code).toBe('unauthorized');
  });

  it('health and readiness answer without authentication', async () => {
    expect((await t.http().get('/healthz')).text).toBe('ok');
    expect((await t.http().get('/readyz')).text).toBe('ok');
  });
});
