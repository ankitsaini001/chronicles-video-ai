import { ProviderError } from "./errors";

/**
 * Bounded retry for provider calls (PIPELINE_DESIGN.md §8): transient failures get at most
 * `maxRetries` (default 2) more attempts, honoring the server's Retry-After when supplied.
 * Anything not transient is thrown immediately. A wait longer than `maxWaitMs` is not attempted:
 * the error is turned into a "quota" error so the run stops with a clear message instead of hanging.
 */

export interface RetryOptions {
  maxRetries?: number;
  /** Backoff used when the server gives no Retry-After: delays[n] for retry n (ms). */
  backoffMs?: readonly number[];
  /** Longest wait we are willing to honor. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; waitMs: number; error: ProviderError }) => void;
}

export const DEFAULT_RETRY = { maxRetries: 2, backoffMs: [2_000, 5_000], maxWaitMs: 60_000 } as const;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetries<T>(call: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_RETRY.maxRetries;
  const backoff = options.backoffMs ?? DEFAULT_RETRY.backoffMs;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_RETRY.maxWaitMs;
  const sleep = options.sleep ?? realSleep;

  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      if (attempt > maxRetries) throw error;
      const waitMs = error.retryAfterMs ?? backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 2_000;
      if (waitMs > maxWaitMs) {
        throw new ProviderError({
          provider: error.provider,
          kind: "quota",
          status: error.status,
          retryAfterMs: error.retryAfterMs,
          message: `${error.message} (the provider asked to wait ${Math.ceil(waitMs / 1000)} s, longer than the ${maxWaitMs / 1000} s we wait automatically)`,
        });
      }
      options.onRetry?.({ attempt, waitMs, error });
      await sleep(waitMs);
    }
  }
}
