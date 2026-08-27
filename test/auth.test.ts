import { describe, expect, it } from 'vitest';
import { verifyApiKey } from '../src/auth';

const KEY = 'correct-horse-battery-staple';

function reqWithHeader(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set('X-API-Key', value);
  return new Request('https://example.com/v1/lookup', { headers });
}

describe('verifyApiKey', () => {
  it('accepts the correct key', () => {
    expect(verifyApiKey(reqWithHeader(KEY), KEY)).toBeNull();
  });

  it('rejects missing header with 401', () => {
    const res = verifyApiKey(reqWithHeader(null), KEY);
    expect(res?.status).toBe(401);
  });

  it('rejects wrong key with 403', () => {
    const res = verifyApiKey(reqWithHeader('wrong-key'), KEY);
    expect(res?.status).toBe(403);
  });

  it('rejects prefix-of-true-key (timing-safe equality)', () => {
    expect(verifyApiKey(reqWithHeader(KEY.slice(0, 5)), KEY)?.status).toBe(403);
  });

  it('rejects superset-of-true-key', () => {
    expect(verifyApiKey(reqWithHeader(KEY + 'x'), KEY)?.status).toBe(403);
  });

  it('fails closed when server has no key configured (503)', () => {
    const res = verifyApiKey(reqWithHeader('anything'), '');
    expect(res?.status).toBe(503);
  });

  it('header lookup is case-insensitive', () => {
    const headers = new Headers({ 'x-api-key': KEY });
    const req = new Request('https://example.com/', { headers });
    expect(verifyApiKey(req, KEY)).toBeNull();
  });
});
