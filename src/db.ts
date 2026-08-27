/**
 * R2-backed offline database loader with isolate-global caching.
 *
 * Offline payloads (qqwry.dat, GeoLite2-*.mmdb) are fetched from R2 into
 * module-global `Uint8Array`s keyed by R2 object key. Subsequent requests on
 * the same isolate read from memory with zero I/O. A per-object etag check
 * detects when the cron updater has pushed a new version, triggering a
 * transparent reload of just that object.
 *
 * @module db
 */

import type { Env } from './types.ts';

interface LoadedDb {
  buffer: Uint8Array;
  /** R2 etag of the source object, used for change detection. */
  hash: string;
  /** Unix ms when this was loaded. */
  loadedAt: number;
}

/** Module-global: loaded databases keyed by R2 object key, per-isolate. */
const cachedBy = new Map<string, LoadedDb>();

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
 * Load an offline database object from R2, or return the cached version if
 * unchanged since the last load on this isolate.
 *
 * @param env      Worker environment (needs DB binding)
 * @param objectKey R2 object key identifying the payload
 * @returns The loaded database buffer and metadata, or `null` if the object
 *          doesn't exist in R2 yet (first deploy, before cron has run).
 */
export async function loadDbObject(env: Env, objectKey: string): Promise<LoadedDb | null> {
  // Check R2 for the object's etag to detect changes
  const head = await env.DB.head(objectKey);
  if (!head) {
    return null; // Not yet uploaded
  }

  const hit = cachedBy.get(objectKey);
  // If we have a cached version and the etag matches, reuse it
  if (hit && hit.hash === head.etag) {
    return hit;
  }

  // Etag changed (or cold start) — fetch the full body
  const obj = await env.DB.get(objectKey);
  if (!obj) {
    return null;
  }

  const buffer = new Uint8Array(await obj.arrayBuffer());
  // Use the R2 etag as our hash — it's already a content hash
  const loaded: LoadedDb = {
    buffer,
    hash: head.etag ?? fnv1a(buffer),
    loadedAt: Date.now(),
  };

  cachedBy.set(objectKey, loaded);

  return loaded;
}

/**
 * Get the raw bytes for an offline database object.
 * Convenience wrapper around {@link loadDbObject} that returns just the bytes.
 *
 * @returns The database bytes, or `null` if not yet loaded into R2.
 */
export async function getDbBuffer(env: Env, objectKey: string): Promise<Uint8Array | null> {
  const db = await loadDbObject(env, objectKey);
  return db?.buffer ?? null;
}

/** Clear the isolate cache (for testing). */
export function clearCache(): void {
  cachedBy.clear();
}
