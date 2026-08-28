import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBatch, handleSingle, resolveOne } from '../src/router';
import { resetLimiter } from '../src/ratelimit';
import { clearCache } from '../src/db';
import { resetMemCache } from '../src/cache';
import { buildQqwryDat, defaultFixture } from './fixture-builder';
import { buildMmdb } from './mmdb-fixture-builder';
import type { Env } from '../src/types';

// ── Stub bindings ─────────────────────────────────────────────────────────

/** Minimal KVNamespace stand-in backed by a Map. */
function kvStub(): KVNamespace & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView): Promise<void> {
      store.set(key, value);
    },
    // Unused members required by the interface shape
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as never;
}

/** Minimal key-aware R2Bucket serving per-object fixture bytes. */
function r2Stub(objects: Map<string, Uint8Array>): R2Bucket {
  return {
    async head(key: string) {
      const v = objects.get(key);
      if (!v) return null;
      return { etag: `len${v.length}`, size: v.length } as R2Object;
    },
    async get(key: string) {
      const v = objects.get(key);
      if (!v) return null;
      return {
        arrayBuffer: async () => v.slice().buffer,
      } as unknown as R2ObjectBody;
    },
    async put(key: string, value: ArrayBuffer | ArrayBufferView) {
      const u8 =
        value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
      objects.set(key, u8.slice());
      return { etag: `len${u8.length}` } as R2Object;
    },
    delete: async () => {},
  } as never;
}

// ── Offline fixtures ──────────────────────────────────────────────────────

/** GeoLite2-Country covering one v4 and one v6 network. */
const geoliteCountryDb = buildMmdb([
  { prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } },
  { prefix: '2001:db8::/32', record: { country: { iso_code: 'US' } } },
]);

/** GeoLite2-ASN covering the same v4 network. */
const geoliteAsnDb = buildMmdb([
  {
    prefix: '8.8.8.0/24',
    record: { autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' },
  },
]);

/** Assemble an Env with all three offline fixtures pre-loaded into R2. */
function makeEnv(overrides: Partial<Record<string, string>> = {}): Env {
  const objects = new Map<string, Uint8Array>([
    ['qqwry.dat', defaultFixture()],
    ['GeoLite2-Country.mmdb', geoliteCountryDb],
    ['GeoLite2-ASN.mmdb', geoliteAsnDb],
  ]);
  return {
    DB: r2Stub(objects),
    CACHE: kvStub(),
    DATA_PRIMARY_URL: 'https://mirror.invalid/a.dat',
    DATA_FALLBACK_URL: '',
    DATA_OBJECT_KEY: 'qqwry.dat',
    GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
    GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
    CACHE_TTL_SECONDS: '2592000',
    MAX_BATCH: '20',
    API_KEY: 'test-key',
    IPINFO_TOKEN: overrides.IPINFO_TOKEN ?? '',
    AMAP_KEY: overrides.AMAP_KEY ?? '',
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetLimiter();
  // Module-global caches: db.loadDbObject caches per object key with
  // size-derived stub etags, and cache.ts's isolate Map would leak resolved
  // results across tests. Clear both.
  clearCache();
  resetMemCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleSingle', () => {
  it('400 on missing ip param', async () => {
    const res = await handleSingle(new URL('https://x/v1/lookup'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('400 on invalid ip', async () => {
    const res = await handleSingle(new URL('https://x/v1/lookup?ip=nonsense'), makeEnv());
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'invalid ip' });
  });

  it('400 on reserved address', async () => {
    const res = await handleSingle(new URL('https://x/v1/lookup?ip=192.168.1.1'), makeEnv());
    expect(res.status).toBe(400);
  });

  it('strips ::ffff: prefix before resolving', async () => {
    const res = await handleSingle(new URL('https://x/v1/lookup?ip=%3A%3Affff%3A1.2.4.10'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe('1.2.4.10');
  });

  it('resolves from offline cz88 when no tokens configured', async () => {
    const res = await handleSingle(new URL('https://x/v1/lookup?ip=9.9.9.9'), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: boolean;
      summary: string;
      sources: Record<string, { source: string; ok: boolean }>;
    };
    expect(body.pending).toBe(false);
    expect(body.sources.cz88?.ok).toBe(true);
    expect(body.summary).toBe('USA CALIFORNIA');
  });

  it('marks pending when database is missing from R2', async () => {
    const env = { ...makeEnv(), DB: r2Stub(new Map()) } as unknown as Env;
    const res = await handleSingle(new URL('https://x/v1/lookup?ip=77.77.77.77'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: boolean;
      sources: Record<string, { error?: string }>;
    };
    expect(body.pending).toBe(true);
    expect(body.sources.cz88?.error).toContain('not loaded');
  });

  it('caches resolved results in KV write-through (v3 key)', async () => {
    const env = makeEnv();
    await handleSingle(new URL('https://x/v1/lookup?ip=1.2.4.77'), env);
    const kv = (env.CACHE as unknown as { store: Map<string, string> }).store;
    expect(kv.has('geo:v3:1.2.4.77')).toBe(true);
    const raw = kv.get('geo:v3:1.2.4.77')!;
    expect(raw).toContain('"ok":true');
  });
});

describe('handleBatch', () => {
  function post(body: unknown): Request {
    return new Request('https://x/v1/lookup', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('rejects non-array bodies', async () => {
    const res = await handleBatch(post({ ips: 'nope' }), makeEnv());
    expect(res.status).toBe(400);
  });

  it('enforces MAX_BATCH cap', async () => {
    const ips = Array.from({ length: 21 }, (_, i) => `80.1.0.${i}`);
    const res = await handleBatch(post({ ips }), makeEnv());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('max 20');
  });

  it('reports invalid/reserved entries inline and resolves the rest', async () => {
    const res = await handleBatch(
      post({ ips: ['1.2.4.5', 'bogus', '10.0.0.9', '::ffff:1.2.5.30'] }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ ip: string; sources: Record<string, { ok: boolean }> }>;
      errors: Record<string, string>;
    };
    expect(body.results.map((r) => r.ip)).toEqual(['1.2.4.5', '1.2.5.30']);
    expect(body.errors).toEqual({ bogus: 'invalid', '10.0.0.9': 'reserved' });
    for (const r of body.results) expect(r.sources.cz88?.ok).toBe(true);
  });
});

describe('resolveOne — online provider gating', () => {
  it('skips amap for clearly non-China IPs (saves quota)', async () => {
    const amapFetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: '0', info: 'should-not-happen' })),
    );
    vi.stubGlobal('fetch', amapFetch);

    const res = await resolveOne('9.9.9.9', makeEnv({ AMAP_KEY: 'k' }));
    expect(amapFetch).not.toHaveBeenCalled();
    expect(res.sources.amap).toBeUndefined();
  });

  it('fires amap when cz88 reports CN, merging adcode-derived coords', async () => {
    const amapOk = {
      status: '1',
      province: '广东省',
      city: '深圳市',
      adcode: '440300',
      rectangle: '113.9,22.5;114.5,22.8',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(amapOk))),
    );

    // Dedicated CN-flagged dat so the cz88→CN gate (not just the CIDR
    // heuristic) authorises the amap call.
    const cnDat = buildQqwryDat([
      {
        startIp: '36.96.0.0',
        // GBK 中国 + NUL
        country: Uint8Array.from([0xd6, 0xd0, 0xb9, 0xfa, 0x00]),
      },
    ]);
    const env = {
      ...makeEnv({ AMAP_KEY: 'k' }),
      DB: r2Stub(new Map([['qqwry.dat', cnDat]])),
    } as unknown as Env;

    const res = await resolveOne('36.99.5.5', env);
    expect(res.sources.amap?.ok).toBe(true);
    expect(res.sources.amap?.region).toBe('广东');
    expect(res.sources.amap?.city).toBe('深圳');
    expect(res.sources.amap?.lat).toBeCloseTo(22.65, 5);
    expect(res.sources.amap?.lon).toBeCloseTo(114.2, 5);
    expect(res.summary).toContain('深圳');
    // Best-guess matrix: amap owns region/city, cz88 provides the ISO country.
    expect(res.best.country).toEqual({ value: 'CN', source: 'cz88' });
    expect(res.best.region).toEqual({ value: '广东', source: 'amap' });
    expect(res.best.city).toEqual({ value: '深圳', source: 'amap' });
  });

  it('calls ipinfo with bearer token and splits ASN/org', async () => {
    const seenHeaders: Headers[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(
          JSON.stringify({
            city: 'Mountain View',
            region: 'California',
            country: 'US',
            loc: '37.4056,-122.0775',
            org: 'AS15169 Google LLC',
          }),
        );
      }),
    );

    const res = await resolveOne('8.8.8.8', makeEnv({ IPINFO_TOKEN: 'tok' }));
    expect(seenHeaders[0]?.get('Authorization')).toBe('Bearer tok');
    expect(res.sources.ipinfo?.asn).toBe('AS15169');
    expect(res.sources.ipinfo?.org).toBe('Google LLC');
    expect(res.sources.ipinfo?.country).toBe('US');
    expect(res.sources.ipinfo?.lat).toBeCloseTo(37.4056, 4);
    expect(res.summary).toContain('Mountain View');
  });
});

describe('resolveOne — geolite offline source', () => {
  it('merges country + ASN into the result without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await resolveOne('8.8.8.8', makeEnv());
    expect(res.sources.geolite?.ok).toBe(true);
    expect(res.sources.geolite?.country).toBe('DE');
    expect(res.sources.geolite?.asn).toBe('AS15169');
    expect(res.sources.geolite?.org).toBe('GOOGLE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.pending).toBe(false);
    // Best-guess matrix: geolite owns country; region falls back to the
    // cz88 whole-string (non-CN branch, no ipinfo token configured).
    expect(res.best.country).toEqual({ value: 'DE', source: 'geolite' });
    expect(res.best.region).toEqual({ value: 'CHINA', source: 'cz88' });
    expect(res.summary).toBe('DE · CHINA');
  });

  it('resolves IPv6 addresses that cz88 cannot cover', async () => {
    const res = await resolveOne('2001:db8::1', makeEnv());
    expect(res.sources.cz88?.ok).toBe(false);
    expect(res.sources.geolite?.ok).toBe(true);
    expect(res.sources.geolite?.country).toBe('US');
    expect(res.summary).toBe('US');
    expect(res.best.country).toEqual({ value: 'US', source: 'geolite' });
  });

  it('marks pending when only the geolite dbs are missing', async () => {
    // qqwry present; geolite objects absent — the cron will fill them in.
    // 77.77.77.77 has no complete cached entry (the missing-db test above
    // cached a pending result, which cacheGet never serves).
    const objects = new Map<string, Uint8Array>([['qqwry.dat', defaultFixture()]]);
    const env = { ...makeEnv(), DB: r2Stub(objects) } as unknown as Env;

    const res = await resolveOne('77.77.77.77', env);
    expect(res.sources.cz88?.ok).toBe(true);
    expect(res.sources.geolite?.ok).toBe(false);
    expect(res.sources.geolite?.error).toBe('database not loaded yet');
    expect(res.pending).toBe(true);
  });
});
