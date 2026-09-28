/**
 * Core retry executor.
 *
 * Design decisions, stated plainly:
 *
 * 1. Synchronous functions only. Supporting async would mean either a separate
 *    API or returning a Promise from a function that might be sync, which makes
 *    the common case awkward. Callers who need async can wrap the call in
 *    Promise.resolve().then(() => retry(...)).
 *
 * 2. The backoff function receives the attempt number (0-based: the attempt that
 *    just failed) and returns a delay in milliseconds. The executor sleeps that
 *    long before the next attempt. If the backoff returns a non-finite or
 *    negative number, it is clamped to zero — a backoff that returns NaN should
 *    not silently produce an infinite wait.
 *
 * 3. The clock is injectable. Tests must be deterministic, so any code that
 *    reads the wall clock or sleeps must go through a function the caller
 *    provides. The default clock uses Date.now and setTimeout, but tests pass a
 *    fake that records sleeps without actually waiting.
 *
 * 4. Retry happens only when the predicate returns true. A thrown error that the
 *    predicate rejects is re-thrown immediately. This lets callers distinguish
 *    "retry this" from "give up now" without catching inside their function.
 *
 * 5. On exhaustion, the last error is re-thrown. There is no wrapper exception
 *    type — the caller sees the real error that the real function produced.
 */

/**
 * @typedef {(attempt: number) => number} BackoffFn
 *   Given the 0-based index of the attempt that just failed, return milliseconds
 *   to wait before the next attempt. Attempt 0 is the first failure.
 */

/**
 * @typedef {(error: unknown) => boolean} RetryPredicate
 *   Return true if the executor should retry after this error, false if it
 *   should re-throw immediately.
 */

/**
 * @typedef {object} Clock
 * @property {() => number} now  Returns a millisecond timestamp.
 * @property {(ms: number) => void} sleep  Blocks for the given milliseconds.
 */

/**
 * @typedef {object} RetryPolicy
 * @property {number} maxAttempts
 *   Total number of times the function will be called. Must be >= 1.
 *   maxAttempts = 1 means "try once, never retry."
 * @property {BackoffFn} backoff
 *   Computes the delay before each retry.
 * @property {RetryPredicate} retryOn
 *   Decides whether a thrown error warrants another attempt.
 */

/**
 * @typedef {object} RetryOptions
 * @property {Clock} [clock]
 *   Optional clock for timing. Defaults to a real clock using Date.now and
 *   setTimeout. Inject a fake in tests.
 */

const realClock = {
  now: () => Date.now(),
  sleep: (ms) => {
    // setTimeout with a 0 delay still yields to the event loop, which is the
    // closest thing to a synchronous sleep in standard JS. For real delays we
    // use Atomics.wait on a shared buffer when available because it is truly
    // synchronous; otherwise we fall back to a busy-wait bounded by the
    // requested delay. The busy-wait is a last resort and only used when
    // Atomics.wait is unavailable (old runtimes without SharedArrayBuffer).
    if (ms <= 0) return;
    if (typeof Atomics !== 'undefined' && typeof SharedArrayBuffer !== 'undefined') {
      const buf = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buf, 0, 0, ms);
      return;
    }
    // Busy-wait fallback. Bounded by ms so we cannot spin forever.
    const target = Date.now() + ms;
    while (Date.now() < target) {
      // intentionally empty
    }
  },
};

/**
 * Run `fn` according to `policy`, retrying on errors the policy says are
 * retryable.
 *
 * @template T
 * @param {() => T} fn
 * @param {RetryPolicy} policy
 * @param {RetryOptions} [options]
 * @returns {T} The value returned by `fn` on its first successful call.
 * @throws {unknown} The first non-retryable error, or the last error if
 *   attempts are exhausted.
 */
export function retry(fn, policy, options) {
  if (typeof fn !== 'function') {
    throw new TypeError('fn must be a function');
  }
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('policy must be an object');
  }
  const { maxAttempts, backoff, retryOn } = policy;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('policy.maxAttempts must be an integer >= 1');
  }
  if (typeof backoff !== 'function') {
    throw new TypeError('policy.backoff must be a function');
  }
  if (typeof retryOn !== 'function') {
    throw new TypeError('policy.retryOn must be a function');
  }

  const clock = options?.clock ?? realClock;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;

      // If the predicate says "don't retry this," re-throw immediately so the
      // caller sees the real error type and message, not a wrapped one.
      let shouldRetry;
      try {
        shouldRetry = retryOn(err);
      } catch (predicateErr) {
 // If the predicate itself throws, we treat that as "do not retry" and
 // re-throw the original error. Throwing the predicate's error would
 // confuse callers who expect errors to come from their own function.
        throw err;
      }

      if (!shouldRetry) {
        throw err;
      }

      // If this was the last allowed attempt, fall through to the exhaustion
      // throw below. We do not sleep before giving up.
      if (attempt === maxAttempts - 1) {
        break;
      }

      let delay = backoff(attempt);
      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
        // A backoff that returns NaN, Infinity, or a negative number is a bug
        // in the caller's policy. Rather than fail open (infinite sleep) or
        // fail closed (throw), we clamp to zero so retries proceed promptly.
        // This is the least surprising option for a misconfigured policy.
        delay = 0;
      }

      clock.sleep(delay);
    }
  }

  // We only reach here if every attempt threw a retryable error.
  throw lastError;
}

/**
 * Build a backoff function for exponential delay with optional jitter.
 *
 * @param {object} opts
 * @param {number} opts.baseMs  Delay for the first retry (attempt 0 failed).
 * @param {number} opts.factor  Multiplier applied per attempt. 2 means double.
 * @param {number} [opts.maxMs]  Cap on the computed delay.
 * @returns {BackoffFn}
 */
export function exponentialBackoff({ baseMs, factor, maxMs }) {
  if (typeof baseMs !== 'number' || !Number.isFinite(baseMs) || baseMs < 0) {
    throw new TypeError('baseMs must be a non-negative finite number');
  }
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) {
    throw new TypeError('factor must be a non-negative finite number');
  }
  if (maxMs !== undefined && (typeof maxMs !== 'number' || !Number.isFinite(maxMs) || maxMs < 0)) {
    throw new TypeError('maxMs must be a non-negative finite number when provided');
  }
  return (attempt) => {
    // attempt is 0-based: the first retry uses baseMs * factor^0 = baseMs.
    let delay = baseMs * Math.pow(factor, attempt);
    if (maxMs !== undefined && delay > maxMs) {
      delay = maxMs;
    }
    return delay;
  };
}

/**
 * A backoff that always returns zero. Useful when you want retry-without-delay
 * and do not want to write a lambda everywhere.
 *
 * @returns {BackoffFn}
 */
export function noBackoff() {
  return () => 0;
}
