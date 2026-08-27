/**
 * Per-provider token-bucket rate limiter + jitter.
 *
 * Workers isolates are stateless across requests, so this limiter is
 * per-isolate (approximate). In practice a single isolate handles many
 * sequential requests, so the bucket is effective for the common case of
 * a batch sweep arriving on one isolate. The edge's own connection reuse
 * means a given caller usually lands on the same isolate.
 *
 * @module ratelimit
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Module-global: one bucket per provider name. */
const buckets = new Map<string, Bucket>();

/** Default: 1 request per second, burst of 2. */
const DEFAULT_RATE = 1; // tokens/sec
const DEFAULT_BURST = 2;

/**
 * Wait until a token is available, then consume one.
 * Returns the delay (ms) that was slept, or 0 if immediate.
 *
 * @param provider  Provider name (e.g. "ipinfo", "amap")
 * @param rate      Refill rate in tokens/sec (default 1)
 * @param burst     Bucket capacity (default 2)
 * @returns Delay in ms that was slept (0 = no wait)
 */
export async function acquireToken(
  provider: string,
  rate: number = DEFAULT_RATE,
  burst: number = DEFAULT_BURST,
): Promise<number> {
  const now = Date.now();
  let bucket = buckets.get(provider);

  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    buckets.set(provider, bucket);
  }

  // Refill
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return 0;
  }

  // Need to wait for a token
  const deficit = 1 - bucket.tokens;
  const waitMs = Math.ceil((deficit / rate) * 1000);
  // Add small random jitter (0-100ms) to desynchronise patterns
  const jitter = Math.floor(Math.random() * 100);
  const totalWait = waitMs + jitter;

  await new Promise<void>((resolve) => setTimeout(resolve, totalWait));

  // After sleeping, consume the token
  bucket.tokens -= 1;
  return totalWait;
}

/** Reset a provider's bucket (useful for testing). */
export function resetLimiter(provider?: string): void {
  if (provider) {
    buckets.delete(provider);
  } else {
    buckets.clear();
  }
}
