/**
 * Two-tier cache: isolate-local Map (instant reads, per-isolate) + KV
 * write-through (cross-isolate persistence, survives restarts).
 *
 * IP geolocation is effectively immutable over weeks/months, so a long TTL
 * is appropriate. KV write-through ensures a cold isolate or a redeploy
 * doesn't re-pay third-party API quota.
 *
 * @module cache
 */

import type { LookupResult } from './types.ts';

/** In-memory cache, keyed by normalised IP. Module-global → per-isolate. */
const memCache = new Map<string, { result: LookupResult; expiresAt: number }>();

/** In-flight dedup: collapses concurrent lookups for the same IP into one. */
const inFlight = new Map<string, Promise<unknown>>();

/** Maximum entries in the isolate Map (prevents unbounded growth). */
const MEM_CACHE_MAX = 2000;

interface CacheRow {
  result: LookupResult;
  expiresAt: number;
}

function pruneMemCache(): void {
  if (memCache.size <= MEM_CACHE_MAX) return;
  // Evict ~10% of entries, preferring expired ones first, then oldest.
  const now = Date.now();
  for (const [key, entry] of memCache) {
    if (entry.expiresAt < now) memCache.delete(key);
  }
  if (memCache.size <= MEM_CACHE_MAX) return;
  // Still over — evict the earliest-expiring entries
  const entries = [...memCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = memCache.size - Math.floor(MEM_CACHE_MAX * 0.9);
  for (let i = 0; i < toRemove; i++) {
    const entry = entries[i];
    if (entry) memCache.delete(entry[0]);
  }
}

/** Read-through: isolate Map → KV. Returns `null` on miss / expiry. */
export async function cacheGet(
  ip: string,
  kv: KVNamespace,
): Promise<LookupResult | null> {
  const now = Date.now();

  // Tier 1: isolate Map
  const mem = memCache.get(ip);
  if (mem && mem.expiresAt > now) {
    return mem.result;
  }

  // Tier 2: KV (v2 key prefix — result schema versions invalidate cleanly)
  const raw = await kv.get(`geo:v2:${ip}`, 'json');
  if (raw) {
    const row = raw as CacheRow;
    if (row.expiresAt > now) {
      // Backfill isolate Map
      memCache.set(ip, row);
      pruneMemCache();
      return row.result;
    }
  }

  return null;
}

/** Write to both tiers. Fire-and-forget KV write (awaitable if needed). */
export async function cacheSet(
  ip: string,
  result: LookupResult,
  kv: KVNamespace,
  ttlMs: number,
): Promise<void> {
  const expiresAt = Date.now() + ttlMs;
  const row: CacheRow = { result, expiresAt };
  memCache.set(ip, row);
  pruneMemCache();
  await kv.put(`geo:v2:${ip}`, JSON.stringify(row), { expirationTtl: Math.ceil(ttlMs / 1000) });
}

/** Clear the isolate memory cache (for testing). */
export function resetMemCache(): void {
  memCache.clear();
}

/**
 * Single-flight: ensures only one lookup per IP is in-flight at a time
 * within this isolate. Concurrent callers share the same promise.
 */
export function singleFlight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}