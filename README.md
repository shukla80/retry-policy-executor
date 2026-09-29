# Retry Policy Executor

A small, dependency-free library that runs a function and retries it on failure according to a caller-supplied policy: a maximum number of attempts, a backoff function, and a predicate that decides which errors are worth retrying.

## Usage

```js
import { retry, exponentialBackoff } from 'retry-policy-executor';

class NetworkError extends Error {}

function fetchData() {
  throw new NetworkError('transient');
}

try {
  const result = retry(
    () => fetchData(),
    {
      maxAttempts: 4,
      backoff: exponentialBackoff({ baseMs: 100, factor: 2, maxMs: 1000 }),
      retryOn: (err) => err instanceof NetworkError,
    }
  );
} catch (err) {
  // err is the last NetworkError after 4 attempts
}
```

The exports are `retry`, `exponentialBackoff`, and `noBackoff`.

`retry(fn, policy, options?)` calls `fn`. If it throws and `policy.retryOn(err)` returns true, it sleeps for `policy.backoff(attempt)` milliseconds (where `attempt` is the 0-based index of the attempt that just failed) and tries again, up to `policy.maxAttempts` total calls. On success it returns the value. On a non-retryable error it re-throws immediately. On exhaustion it re-throws the last error.

`exponentialBackoff({ baseMs, factor, maxMs? })` returns a backoff function computing `baseMs * factor^attempt`, capped at `maxMs`.

`noBackoff()` returns a backoff function that always returns 0.

## Why this exists

Network calls fail transiently, and hand-rolled retry loops tend to grow ad-hoc sleep logic and error filtering that is hard to test. This library isolates those three concerns — attempt count, delay schedule, error filtering — behind a single function with an injectable clock so the behaviour is fully deterministic in tests.

The trade-off: this is a synchronous executor. It does not return a Promise. If you need async retry, wrap the call yourself. Keeping it synchronous means the default sleep can block the thread (via `Atomics.wait` where available), which is what you want in a CLI or test harness and not what you want in an event-loop-bound server. That scope is deliberate.

## Edge cases you will hit

- **`maxAttempts` is total calls, not retries.** `maxAttempts: 1` means try once and never retry. There is no off-by-one here.
- **The backoff function receives a 0-based attempt index.** The first failure is attempt 0, so `exponentialBackoff({ baseMs: 100, factor: 2 })` sleeps 100ms before the first retry, not 200ms.
- **A backoff returning `NaN`, `Infinity`, or a negative number is clamped to zero**, not thrown. A misconfigured policy should not hang forever.
- **If `retryOn` itself throws**, the original error from your function is re-thrown. The predicate's error is swallowed. This keeps the error type predictable.
- **The clock is injectable** via `options.clock`. The default clock uses `Date.now()` and a synchronous sleep (`Atomics.wait` when available, busy-wait otherwise). In tests, pass a fake clock that records sleeps without waiting.

## Running the tests

```
node --test
```

All tests use `node:test` and `node:assert/strict` and make no network calls and no real sleeps.
