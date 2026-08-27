/**
 * Auth middleware — validates `X-API-Key` header against the `API_KEY` secret.
 *
 * Uses a constant-time comparison to prevent timing side-channels that could
 * leak the expected key length or prefix.
 *
 * @module auth
 */

/** Case-insensitive header lookup (HTTP headers are case-insensitive). */
function getHeader(headers: Headers, name: string): string | null {
  // Headers.get() is already case-insensitive per the spec, but we normalise
  // for environments that may not fully comply.
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

/**
 * Compare two strings in constant time (as far as JS allows).
 * Returns `true` if they are byte-for-byte equal.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still hash both to keep the work roughly equal
    let dummy = 0;
    for (let i = 0; i < a.length; i++) dummy ^= a.charCodeAt(i);
    for (let i = 0; i < b.length; i++) dummy ^= b.charCodeAt(i);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify the incoming request carries the expected `X-API-Key`.
 *
 * @returns `null` if auth passes, or a 401 `Response` to return immediately.
 */
export function verifyApiKey(req: Request, expectedKey: string): Response | null {
  if (!expectedKey) {
    // Server misconfiguration — fail closed
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const provided = getHeader(req.headers, 'X-API-Key');
  if (!provided) {
    return new Response(JSON.stringify({ error: 'missing X-API-Key header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!timingSafeEqual(provided, expectedKey)) {
    return new Response(JSON.stringify({ error: 'invalid API key' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}
