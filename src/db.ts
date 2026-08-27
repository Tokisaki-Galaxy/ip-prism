/**
 * R2-backed qqwry.dat loader with isolate-global caching.
 *
 * On first access the worker fetches the dat file from R2 into a module-global
 * `Uint8Array`. Subsequent requests on the same isolate read from memory with
 * zero I/O. A content-hash check detects when the cron updater has pushed a
 * new version, triggering a transparent reload.
 *
 * @module db
 */

import type { Env } from './types.ts';

interface LoadedDb {
  buffer: Uint8Array;
  /** FNV-1a hash of the buffer content, used for change detection. */
  hash: string;
  /** Unix ms when this was loaded. */
  loadedAt: number;
}

/** Module-global: the loaded database, persisted across requests on one isolate. */
let cached: LoadedDb | null = null;

/**
 * Compute a simple FNV-1a 32-bit hash as a hex string.
 * Fast, non-cryptographic — just for change detection.
 */
function fnv1a(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Load the qqwry.dat from R2, or return the cached version if unchanged.
 *
 * @param env  Worker environment (needs DB binding + DATA_OBJECT_KEY)
 * @returns The loaded database buffer and metadata, or `null` if the object
 *          doesn't exist in R2 yet (first deploy, before cron has run).
 */
export async function loadDb(env: Env): Promise<LoadedDb | null> {
  // Check R2 for the object's etag to detect changes
  const head = await env.DB.head(env.DATA_OBJECT_KEY);
  if (!head) {
    return null; // Not yet uploaded
  }

  // If we have a cached version and the etag matches, reuse it
  if (cached && cached.hash === head.etag) {
    return cached;
  }

  // Etag changed (or cold start) — fetch the full body
  const obj = await env.DB.get(env.DATA_OBJECT_KEY);
  if (!obj) {
    return null;
  }

  const buffer = new Uint8Array(await obj.arrayBuffer());
  // Use the R2 etag as our hash — it's already a content hash
  const hash = head.etag ?? fnv1a(buffer);

  cached = {
    buffer,
    hash,
    loadedAt: Date.now(),
  };

  return cached;
}

/**
 * Get the raw buffer for the qqwry database.
 * Convenience wrapper around {@link loadDb} that returns just the bytes.
 *
 * @returns The database bytes, or `null` if not yet loaded into R2.
 */
export async function getDbBuffer(env: Env): Promise<Uint8Array | null> {
  const db = await loadDb(env);
  return db?.buffer ?? null;
}

/** Clear the isolate cache (for testing). */
export function clearCache(): void {
  cached = null;
}
