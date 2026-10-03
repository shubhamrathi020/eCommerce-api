import { CircuitBreaker, CircuitOpenError, TimeoutError } from './circuit-breaker';
import { withRetry } from './retry';

describe('CircuitBreaker', () => {
  it('stays closed and passes through results while calls succeed', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, cooldownMs: 1000, timeoutMs: 100 });
    await expect(breaker.exec(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.stats()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('opens after the configured number of consecutive failures, then rejects immediately without calling fn again', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 2, cooldownMs: 1000, timeoutMs: 100 });
    const fail = () => Promise.reject(new Error('boom'));
    await expect(breaker.exec(fail)).rejects.toThrow('boom');
    expect(breaker.stats().state).toBe('closed'); // 1st failure: still under the threshold
    await expect(breaker.exec(fail)).rejects.toThrow('boom');
    expect(breaker.stats().state).toBe('open'); // 2nd failure: threshold reached

    const fn = vi.fn(fail);
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled(); // never even attempted the real call while open
  });

  it('a call that never settles counts as a failure via the timeout, not by hanging the caller', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 1000, timeoutMs: 30 });
    const neverResolves = () => new Promise<never>(() => undefined);
    await expect(breaker.exec(neverResolves)).rejects.toBeInstanceOf(TimeoutError);
    expect(breaker.stats().state).toBe('open');
  });

  it('after the cooldown, allows exactly one probe through; success closes the circuit again', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 20, timeoutMs: 100 });
    await expect(breaker.exec(() => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(breaker.stats().state).toBe('open');

    await new Promise((r) => setTimeout(r, 25)); // let the cooldown elapse
    await expect(breaker.exec(() => Promise.resolve('recovered'))).resolves.toBe('recovered');
    expect(breaker.stats()).toMatchObject({ state: 'closed', consecutiveFailures: 0 });
  });

  it('a failed probe reopens the circuit for another full cooldown', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 20, timeoutMs: 100 });
    await expect(breaker.exec(() => Promise.reject(new Error('down')))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 25));
    await expect(breaker.exec(() => Promise.reject(new Error('still down')))).rejects.toThrow('still down');
    expect(breaker.stats().state).toBe('open');

    // Immediately after the failed probe, still within the new cooldown: rejected without calling fn.
    const fn = vi.fn();
    await expect(breaker.exec(fn)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 5 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and succeeds once the dependency recovers', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce('ok');
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 5 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up and throws the last error after exhausting every attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down for good'));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 5 })).rejects.toThrow('down for good');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
