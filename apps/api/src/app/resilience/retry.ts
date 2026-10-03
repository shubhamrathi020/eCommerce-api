/**
 * Retries `fn` up to `attempts` times with exponential backoff (BRD 24, OB-05), for a call that might
 * have failed on a transient blip rather than a real outage. Deliberately NOT used together with a
 * `CircuitBreaker` retrying the *same* call on the *same* dependency — that would multiply load on a
 * struggling dependency right when it least needs it. `RazorpayService`/`SearchService` retry a call
 * a couple of times *inside* one circuit-breaker attempt (a blip counts as one failure toward the
 * breaker, not several), not the other way around.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts: number; baseDelayMs: number }): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < opts.attempts - 1) await new Promise((r) => setTimeout(r, opts.baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}
