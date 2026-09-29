import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { retry, exponentialBackoff, noBackoff } from '../src/index.js';

/**
 * A fake clock that records every sleep call without actually waiting.
 * Tests must be deterministic, so we never touch the real timer.
 */
function makeFakeClock() {
  const sleeps = [];
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    elapsed: () => now,
  };
}

describe('retry', () => {
  test('returns the value when fn succeeds on the first try', () => {
    const clock = makeFakeClock();
    const result = retry(
      () => 42,
      { maxAttempts: 3, backoff: () => 0, retryOn: () => true },
      { clock }
    );
    assert.equal(result, 42);
    assert.deepEqual(clock.sleeps, []);
  });

  test('retries until success', () => {
    const clock = makeFakeClock();
    let calls = 0;
    const result = retry(
      () => {
        calls++;
        if (calls < 3) throw new Error('not yet');
        return 'ok';
      },
      { maxAttempts: 5, backoff: () => 10, retryOn: () => true },
      { clock }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    // Two failures means two sleeps (before attempt 2 and attempt 3).
    assert.deepEqual(clock.sleeps, [10, 10]);
  });

  test('rethrows immediately when retryOn returns false', () => {
    const clock = makeFakeClock();
    let calls = 0;
    assert.throws(
      () =>
        retry(
          () => {
            calls++;
            throw new TypeError('bad type');
          },
          { maxAttempts: 5, backoff: () => 10, retryOn: () => false },
          { clock }
        ),
      (err) => err instanceof TypeError && err.message === 'bad type'
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('rethrows the last error when attempts are exhausted', () => {
    const clock = makeFakeClock();
    let calls = 0;
    assert.throws(
      () =>
        retry(
          () => {
            calls++;
            throw new RangeError(`call ${calls}`);
          },
          { maxAttempts: 3, backoff: () => 5, retryOn: () => true },
          { clock }
        ),
      (err) => err instanceof RangeError && err.message === 'call 3'
    );
    assert.equal(calls, 3);
    // Two sleeps: after attempt 1 and after attempt 2. No sleep after the
    // final failed attempt.
    assert.deepEqual(clock.sleeps, [5, 5]);
  });

  test('maxAttempts = 1 means no retries', () => {
    const clock = makeFakeClock();
    let calls = 0;
    assert.throws(
      () =>
        retry(
          () => {
            calls++;
            throw new Error('nope');
          },
          { maxAttempts: 1, backoff: () => 100, retryOn: () => true },
          { clock }
        ),
      /nope/
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.sleeps, []);
  });

  test('passes the 0-based attempt index to backoff', () => {
    const clock = makeFakeClock();
    const attempts = [];
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 4) throw new Error('again');
        return 'done';
      },
      {
        maxAttempts: 10,
        backoff: (n) => {
          attempts.push(n);
          return 0;
        },
        retryOn: () => true,
      },
      { clock }
    );
    // Three failures -> three backoff calls with indices 0, 1, 2.
    assert.deepEqual(attempts, [0, 1, 2]);
  });

  test('clamps non-finite backoff to zero', () => {
    const clock = makeFakeClock();
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 3) throw new Error('retry');
        return 'ok';
      },
      { maxAttempts: 5, backoff: () => NaN, retryOn: () => true },
      { clock }
    );
    // NaN should be clamped to 0, not cause an infinite or undefined sleep.
    assert.deepEqual(clock.sleeps, [0, 0]);
  });

  test('clamps negative backoff to zero', () => {
    const clock = makeFakeClock();
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 2) throw new Error('retry');
        return 'ok';
      },
      { maxAttempts: 5, backoff: () => -50, retryOn: () => true },
      { clock }
    );
    assert.deepEqual(clock.sleeps, [0]);
  });

  test('predicate that throws causes immediate re-throw of the original error', () => {
    const clock = makeFakeClock();
    let calls = 0;
    const original = new SyntaxError('original');
    assert.throws(
      () =>
        retry(
          () => {
            calls++;
            throw original;
          },
          {
            maxAttempts: 5,
            backoff: () => 0,
            retryOn: () => {
              throw new Error('predicate broke');
            },
          },
          { clock }
        ),
      (err) => err === original
    );
    assert.equal(calls, 1);
  });

  test('throws TypeError when fn is not a function', () => {
    assert.throws(
      () => retry(null, { maxAttempts: 1, backoff: () => 0, retryOn: () => true }),
      /fn must be a function/
    );
  });

  test('throws TypeError when maxAttempts is not a positive integer', () => {
    assert.throws(
      () => retry(() => 1, { maxAttempts: 0, backoff: () => 0, retryOn: () => true }),
      /maxAttempts/
    );
    assert.throws(
      () => retry(() => 1, { maxAttempts: 1.5, backoff: () => 0, retryOn: () => true }),
      /maxAttempts/
    );
  });

  test('throws TypeError when backoff is not a function', () => {
    assert.throws(
      () => retry(() => 1, { maxAttempts: 1, backoff: 'no', retryOn: () => true }),
      /backoff/
    );
  });

  test('throws TypeError when retryOn is not a function', () => {
    assert.throws(
      () => retry(() => 1, { maxAttempts: 1, backoff: () => 0, retryOn: null }),
      /retryOn/
    );
  });

  test('retryOn receives the thrown error', () => {
    const clock = makeFakeClock();
    const seen = [];
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 2) throw new Error('first');
        return 'ok';
      },
      {
        maxAttempts: 3,
        backoff: () => 0,
        retryOn: (err) => {
          seen.push(err);
          return true;
        },
      },
      { clock }
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0] instanceof Error);
    assert.equal(seen[0].message, 'first');
  });
});

describe('exponentialBackoff', () => {
  test('returns baseMs for the first failed attempt (index 0)', () => {
    const b = exponentialBackoff({ baseMs: 100, factor: 2 });
    assert.equal(b(0), 100);
  });

  test('multiplies by factor for each subsequent attempt', () => {
    const b = exponentialBackoff({ baseMs: 100, factor: 2 });
    assert.equal(b(0), 100);
    assert.equal(b(1), 200);
    assert.equal(b(2), 400);
    assert.equal(b(3), 800);
  });

  test('respects maxMs cap', () => {
    const b = exponentialBackoff({ baseMs: 100, factor: 2, maxMs: 500 });
    assert.equal(b(0), 100);
    assert.equal(b(1), 200);
    assert.equal(b(2), 400);
    assert.equal(b(3), 500);
    assert.equal(b(4), 500);
  });

  test('throws on invalid baseMs', () => {
    assert.throws(
      () => exponentialBackoff({ baseMs: -1, factor: 2 }),
      /baseMs/
    );
    assert.throws(
      () => exponentialBackoff({ baseMs: NaN, factor: 2 }),
      /baseMs/
    );
  });

  test('throws on invalid factor', () => {
    assert.throws(
      () => exponentialBackoff({ baseMs: 100, factor: -1 }),
      /factor/
    );
  });

  test('throws on invalid maxMs', () => {
    assert.throws(
      () => exponentialBackoff({ baseMs: 100, factor: 2, maxMs: -1 }),
      /maxMs/
    );
  });

  test('works with factor 1 (constant backoff)', () => {
    const b = exponentialBackoff({ baseMs: 50, factor: 1 });
    assert.equal(b(0), 50);
    assert.equal(b(5), 50);
  });
});

describe('noBackoff', () => {
  test('always returns zero', () => {
    const b = noBackoff();
    assert.equal(b(0), 0);
    assert.equal(b(10), 0);
  });

  test('produces zero-length sleeps when used in retry', () => {
    const clock = makeFakeClock();
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 3) throw new Error('again');
        return 'ok';
      },
      { maxAttempts: 5, backoff: noBackoff(), retryOn: () => true },
      { clock }
    );
    assert.deepEqual(clock.sleeps, [0, 0]);
  });
});

describe('retry integration with exponentialBackoff', () => {
  test('sleeps follow the exponential schedule', () => {
    const clock = makeFakeClock();
    let calls = 0;
    retry(
      () => {
        calls++;
        if (calls < 4) throw new Error('retry');
        return 'done';
      },
      {
        maxAttempts: 10,
        backoff: exponentialBackoff({ baseMs: 10, factor: 2 }),
        retryOn: () => true,
      },
      { clock }
    );
    // Three failures -> sleeps of 10, 20, 40.
    assert.deepEqual(clock.sleeps, [10, 20, 40]);
  });
});
