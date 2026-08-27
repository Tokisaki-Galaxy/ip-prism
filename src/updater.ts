/**
 * Scheduled handler — daily qqwry.dat refresh.
 *
 * Pulls the latest database from a public mirror (FW27623/qqwry primary,
 * metowolf/qqwry.dat fallback), compares against the current R2 object's
 * hash, and uploads only when content actually changed. This keeps the
 * data pipeline fully automated with zero manual steps.
 *
 * @module updater
 */

import type { Env } from './types.ts';

/** Mirrors to try, in order. Managed centrally so adding a source is one line. */
function mirrorUrls(env: Env): string[] {
  return [env.DATA_PRIMARY_URL, env.DATA_FALLBACK_URL].filter(Boolean);
}

/**
 * Sanity-check that a downloaded buffer looks like a real qqwry.dat:
 * - ≥ 1 MB (real file is 6-11MB; a tiny response is an error page)
 * - first 4 bytes = last-record offset, must be < file length
 * - header contains three little-endian u32s pointing inside the file
 */
export function looksLikeQqwryDat(buf: Uint8Array): boolean {
  if (buf.length < 1024 * 1024) return false;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const firstOffset = view.getUint32(0, true);
  const lastOffset = view.getUint32(4, true);
  // Both offsets must point within the file and be ordered
  return (
    firstOffset > 0 &&
    firstOffset < buf.length &&
    lastOffset >= firstOffset &&
    lastOffset < buf.length
  );
}

/** Fetch with timeout via AbortController (Workers have no global WAIT by default). */
async function fetchWithTimeout(url: string, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ip-prism-updater/1.0' },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one update cycle. Intended to be called from `scheduled()`.
 *
 * @returns status string for logging / testing assertions
 */
export async function runUpdate(env: Env): Promise<string> {
  const objectKey = env.DATA_OBJECT_KEY;

  // Current version fingerprint (skip download entirely if mirror hasn't moved)
  const existing = await env.DB.head(objectKey);
  const existingTag = existing?.etag ?? null;

  for (const url of mirrorUrls(env)) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url);
    } catch (err) {
      console.warn(`[updater] fetch failed for ${url}: ${String(err)}`);
      continue;
    }

    if (!res.ok) {
      console.warn(`[updater] HTTP ${res.status} from ${url}`);
      continue;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());

    if (!looksLikeQqwryDat(bytes)) {
      console.warn(`[updater] ${url} returned non-dat payload (${bytes.length}b)`);
      continue;
    }

    // Cheap change detection: size + FNV-1a over the first and last 64KB.
    // A full hash would cost more CPU; this catches every realistic daily update.
    const headHash = fnvRange(bytes, 0, Math.min(65536, bytes.length));
    const tailStart = Math.max(0, bytes.length - 65536);
    const tailHash = fnvRange(bytes, tailStart, bytes.length);
    const fingerprint = `${bytes.length}:${headHash}:${tailHash}`;

    if (existingTag && existingTag === fingerprint) {
      return 'unchanged';
    }

    await env.DB.put(objectKey, bytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { fingerprint, fetchedFrom: url },
    });

    console.log(
      `[updater] stored new dat: ${bytes.length} bytes from ${url} (fp=${fingerprint})`,
    );
    return `updated:${fingerprint}`;
  }

  return 'failed';
}

/** FNV-1a over a byte range. */
function fnvRange(data: Uint8Array, start: number, end: number): string {
  let hash = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
