/**
 * A textbook circuit breaker (BRD 24, OB-05) around calls to one external dependency (Razorpay,
 * Meilisearch): timeout every call, count consecutive failures, and once too many happen in a row, stop
 * even trying for a cooldown period — so a struggling dependency isn't also hammered with retries while
 * it recovers, and callers fail fast (a clear, immediate error) instead of piling up behind a slow one.
 *
 * States: `closed` (normal — calls go through) → `open` (too many recent failures — calls are rejected
 * immediately with `CircuitOpenError`, no network call is even attempted) → after `cooldownMs`,
 * `half_open` (exactly one probe call is allowed through; success closes the circuit again, failure
 * reopens it for another full cooldown).
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`circuit "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

export class TimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`"${name}" timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures (closed state) before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before allowing one probe call through. */
  cooldownMs: number;
  /** Every call is raced against this; a call that doesn't settle in time counts as a failure. */
  timeoutMs: number;
}

export interface CircuitStats {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastError?: string;
  openedAt?: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private lastError: string | undefined;
  private halfOpenProbeInFlight = false;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitBreakerOptions,
  ) {}

  stats(): CircuitStats {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.state === 'open' ? { openedAt: new Date(this.openedAt).toISOString() } : {}),
    };
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.opts.cooldownMs) throw new CircuitOpenError(this.name);
      // Cooldown elapsed: let exactly one caller probe the dependency; everyone else still gets rejected
      // immediately until that probe settles, so a burst of concurrent requests doesn't all hit a
      // dependency that has only *just* started to recover.
      if (this.halfOpenProbeInFlight) throw new CircuitOpenError(this.name);
      this.state = 'half_open';
      this.halfOpenProbeInFlight = true;
    }
    try {
      const result = await this.withTimeout(fn());
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    } finally {
      this.halfOpenProbeInFlight = false;
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError(this.name, this.opts.timeoutMs)), this.opts.timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.state = 'closed';
  }

  private onFailure(error: Error): void {
    this.consecutiveFailures++;
    this.lastError = error.message;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}
