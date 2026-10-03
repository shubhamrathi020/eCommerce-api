import jwt from 'jsonwebtoken';
import { ORIGIN, type TestApp, createTestApp, refreshCookie, resetDatabase } from './test-app';

const register = (t: TestApp, over: Record<string, string> = {}) => t.http().post('/auth/register').send({ name: 'Asha Rao', email: 'asha@example.com', password: 'Str0ngPass', ...over });
const login = (t: TestApp, email = 'asha@example.com', password = 'Str0ngPass') => t.http().post('/auth/login').send({ email, password });
const refresh = (t: TestApp, cookie: string) => t.http().post('/auth/refresh').set('cookie', cookie).set('x-csrf', '1');

describe('auth API', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());
  beforeEach(() => resetDatabase(t.db));

  it('registers with the same validation messages as the mock, and never returns the password', async () => {
    const bad = await register(t, { name: ' ', email: 'nope', password: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'validation', message: 'Please check the highlighted fields.', fields: { name: 'Name is required', email: 'Enter a valid email address', password: 'Use at least 8 characters.' } });
    expect(bad.body.requestId).toEqual(expect.any(String));

    const ok = await register(t, { email: 'Asha@Example.com' });
    expect(ok.status).toBe(201);
    expect(ok.body.session.user).toMatchObject({ name: 'Asha Rao', email: 'asha@example.com', roles: ['customer'], emailVerified: false });
    expect(ok.body.session.user.permissions).toContain('address:write:own');
    expect(ok.body.accessToken).toEqual(expect.any(String));
    expect(JSON.stringify(ok.body)).not.toMatch(/Str0ngPass|passwordHash|argon2/);

    const cookie = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rt='));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const row = await t.db.user.findUniqueOrThrow({ where: { email: 'asha@example.com' } });
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(t.mail.list()[0]).toMatchObject({ to: 'asha@example.com', subject: 'Verify your email address' });
  });

  it('does not reveal that an address is already registered', async () => {
    await register(t);
    const again = await register(t);
    expect(again.status).toBe(400);
    expect(again.body.message).toContain('We could not create the account with these details');
  });

  it('gives one generic message for a wrong password or an unknown email, then locks out after 5 failures', async () => {
    await register(t);
    const unknown = await login(t, 'nobody@example.com', 'Whatever1');
    const wrong = await login(t, 'asha@example.com', 'Wrong1234');
    expect(unknown.body.message).toBe('Incorrect email or password.');
    expect(wrong.body).toMatchObject({ code: 'unauthorized', message: 'Incorrect email or password.' });
    for (let i = 0; i < 4; i++) await login(t, 'asha@example.com', 'Wrong1234');
    const locked = await login(t); // right password, but locked
    expect(locked.status).toBe(403);
    expect(locked.body.message).toMatch(/Too many failed attempts\. Try again in 15 minutes\./);
  });

  it('refresh needs the CSRF header, rotates the token, and a reused token revokes the whole sign-in', async () => {
    const first = refreshCookie((await register(t)).headers['set-cookie']);
    expect((await t.http().post('/auth/refresh').set('cookie', first)).body).toMatchObject({ code: 'forbidden', message: 'Missing CSRF header.' });

    const rotated = await refresh(t, first);
    expect(rotated.status).toBe(200);
    expect(rotated.body.session.user.email).toBe('asha@example.com');
    const second = refreshCookie(rotated.headers['set-cookie']);
    expect(second).not.toBe(first);

    // An attacker replays the old token: rejected, and the legitimate new one dies with it.
    const replay = await refresh(t, first);
    expect(replay.status).toBe(401);
    expect(replay.body.message).toContain('For your safety');
    expect((await refresh(t, second)).status).toBe(401);
  });

  it('logout ends the sign-in and clears the cookie; me() needs a valid access token', async () => {
    const res = await register(t);
    const cookie = refreshCookie(res.headers['set-cookie']);
    const me = await t.http().get('/auth/me').set('authorization', `Bearer ${res.body.accessToken}`);
    expect(me.body.user.email).toBe('asha@example.com');
    expect((await t.http().get('/auth/me').set('authorization', 'Bearer not-a-token')).status).toBe(401);

    const out = await t.http().post('/auth/logout').set('cookie', cookie).set('x-csrf', '1');
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/rt=;/);
    expect((await refresh(t, cookie)).status).toBe(401);
  });

  it('rejects access tokens signed with another secret or already expired', async () => {
    const forged = jwt.sign({ sub: 'x', roles: ['admin'], permissions: ['product:write'] }, 'some-other-secret-that-is-at-least-32-characters', { audience: 'ecom-api', issuer: 'ecom-api' });
    expect((await t.http().get('/auth/me').set('authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = jwt.sign({ sub: 'x', roles: [], permissions: [], exp: Math.floor(Date.now() / 1000) - 10 }, 'test-access-secret-that-is-at-least-32-chars', { audience: 'ecom-api', issuer: 'ecom-api' });
    expect((await t.http().get('/auth/me').set('authorization', `Bearer ${expired}`)).body.message).toContain('expired');
  });

  it('verifies an email once', async () => {
    await register(t);
    const token = new URL(t.mail.list()[0].link ?? '', 'http://x').searchParams.get('token');
    expect((await t.http().post('/auth/verify-email').send({ token })).status).toBe(204);
    expect((await t.db.user.findUniqueOrThrow({ where: { email: 'asha@example.com' } })).emailVerified).toBe(true);
    expect((await t.http().post('/auth/verify-email').send({ token })).body.message).toContain('invalid or has already been used');
  });

  it('password reset: same answer for unknown emails, works once, and signs out every device', async () => {
    const cookie = refreshCookie((await register(t)).headers['set-cookie']);
    const before = t.mail.list().length;
    expect((await t.http().post('/auth/password-reset/request').send({ email: 'nobody@example.com' })).status).toBe(204);
    expect(t.mail.list()).toHaveLength(before);

    await t.http().post('/auth/password-reset/request').send({ email: 'asha@example.com' });
    const token = new URL(t.mail.list()[0].link ?? '', 'http://x').searchParams.get('token');
    expect((await t.http().post('/auth/password-reset').send({ token, password: 'weak' })).body.fields).toEqual({ password: 'Use at least 8 characters.' });
    expect((await t.http().post('/auth/password-reset').send({ token, password: 'N3wPassword' })).status).toBe(204);
    expect((await t.http().post('/auth/password-reset').send({ token, password: 'N3wPassword' })).status).toBe(400);
    expect((await refresh(t, cookie)).status).toBe(401);
    expect((await login(t, 'asha@example.com', 'N3wPassword')).status).toBe(200);
  });

  it('answers our own origins with credentialed CORS, and nobody else', async () => {
    const ours = await t.http().options('/auth/login').set('origin', ORIGIN).set('access-control-request-method', 'POST');
    expect(ours.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ours.headers['access-control-allow-credentials']).toBe('true');
    const theirs = await t.http().options('/auth/login').set('origin', 'https://evil.example').set('access-control-request-method', 'POST');
    expect(theirs.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects malformed bodies in the standard error shape, with security headers and a request id', async () => {
    const res = await t.http().post('/auth/login').set('x-request-id', 'client-supplied-id-123').send({ email: 42, password: ['x'], extra: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'validation', message: 'The request was not valid.', requestId: 'client-supplied-id-123' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // A request id that is not id-shaped is replaced, so clients cannot inject text into our logs.
    const odd = await t.http().get('/healthz').set('x-request-id', 'not an id <script>alert(1)</script>');
    expect(odd.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('auth rate limiting', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp({ rateLimit: true })));
  afterAll(() => t.close());

  it('stops an 11th login attempt within a minute from the same client', async () => {
    await resetDatabase(t.db);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await t.http().post('/auth/login').send({ email: `x${i}@example.com`, password: 'Whatever1' })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    const last = await t.http().post('/auth/login').send({ email: 'x@example.com', password: 'Whatever1' });
    expect(last.status).toBe(429);
    expect(last.body.message).toContain('Too many requests');
  });
});
