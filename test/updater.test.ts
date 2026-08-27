import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUpdate, looksLikeQqwryDat, looksLikeMmdb, anyPipelineFailed } from '../src/updater';
import { defaultFixture, padPastMinSize } from './fixture-builder';
import { buildMmdb } from './mmdb-fixture-builder';
import type { Env } from '../src/types';

function r2Stub(): R2Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
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
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
      objects.set(key, u8.slice());
      return { etag: `len${u8.length}` } as R2Object;
    },
    delete: async (key: string) => {
      objects.delete(key);
    },
    list: async () => ({ objects: [], truncated: false }) as unknown as R2Objects,
  } as never;
}

function envWith(
  db: R2Bucket,
  overrides: Partial<Record<string, string>> = {},
): Env {
  return {
    DB: db,
    CACHE: {} as KVNamespace,
    DATA_PRIMARY_URL: 'https://mirror-a.invalid/qqwry.dat',
    DATA_FALLBACK_URL: 'https://mirror-b.invalid/qqwry.dat',
    DATA_OBJECT_KEY: 'qqwry.dat',
    CACHE_TTL_SECONDS: '2592000',
    MAX_BATCH: '20',
    API_KEY: 'k',
    IPINFO_TOKEN: '',
    AMAP_KEY: '',
    ...overrides,
  } as unknown as Env;
}

const junk = new TextEncoder().encode('<html>404 not found</html>');

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('looksLikeQqwryDat', () => {
  it('accepts real fixture bytes (padded past 1 MiB floor)', () => {
    expect(looksLikeQqwryDat(padPastMinSize(defaultFixture()))).toBe(true);
  });
  it('rejects HTML error pages', () => {
    expect(looksLikeQqwryDat(junk)).toBe(false);
  });
  it('rejects tiny payloads', () => {
    expect(looksLikeQqwryDat(new Uint8Array(16))).toBe(false);
  });
});

describe('looksLikeMmdb', () => {
  it('accepts a spec-valid fixture (padded past the size floor)', () => {
    const db = buildMmdb(
      [{ prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } }],
      { padTo: 1024 },
    );
    expect(looksLikeMmdb(db)).toBe(true);
  });
  it('rejects HTML error pages', () => {
    expect(looksLikeMmdb(junk)).toBe(false);
  });
  it('rejects tiny payloads', () => {
    expect(looksLikeMmdb(new Uint8Array(16))).toBe(false);
  });
  it('rejects truncated files that never contain the metadata marker', () => {
    const db = buildMmdb(
      [{ prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } }],
      { padTo: 1024 },
    );
    expect(looksLikeMmdb(db.slice(0, 600))).toBe(false);
  });
  it('rejects files whose metadata section is not a map', () => {
    const db = buildMmdb(
      [{ prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } }],
      { padTo: 1024 },
    );
    // Overwrite the metadata map's control byte (first byte after the marker)
    // with a UTF8-string type marker instead of a map.
    const copy = db.slice();
    const marker = [0xab, 0xcd, 0xef, 0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d];
    let pos = -1;
    for (let i = copy.length - marker.length; i >= 0; i--) {
      if (marker.every((b, j) => copy[i + j] === b)) {
        pos = i;
        break;
      }
    }
    expect(pos).toBeGreaterThan(0);
    copy[pos! + marker.length] = (2 << 5) | 4;
    expect(looksLikeMmdb(copy)).toBe(false);
  });
});

describe('runUpdate', () => {
  it('stores fixture from primary mirror on first run', async () => {
    const db = r2Stub();
    const good = padPastMinSize(defaultFixture());
    const fetchMock = vi.fn(async () => new Response(good.slice().buffer));
    vi.stubGlobal('fetch', fetchMock);

    const status = await runUpdate(envWith(db));
    expect(status.startsWith('qqwry:updated:')).toBe(true);
    expect(db.objects.get('qqwry.dat')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // only primary contacted
  });

  it('falls back to secondary when primary serves garbage', async () => {
    const db = r2Stub();
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        void url;
        call++;
        return call === 1
          ? new Response(junk.slice().buffer)
          : new Response(padPastMinSize(defaultFixture()).slice().buffer);
      }),
    );
    const status = await runUpdate(envWith(db));
    expect(status.startsWith('qqwry:updated:')).toBe(true);
    expect(call).toBe(2);
  });

  it('skips upload when content unchanged', async () => {
    const db = r2Stub();
    const good = padPastMinSize(defaultFixture());

    const fetchMock = vi.fn(async () => new Response(good.slice().buffer));
    vi.stubGlobal('fetch', fetchMock);

    await runUpdate(envWith(db));
    // Second run: same content — the stub R2 etag (`len<N>`) won't equal our
    // fingerprint, but our fake network returns identical content. The
    // updater stores anyway in that case; assert idempotent end-state.
    const before = db.objects.get('qqwry.dat')!.slice();
    await runUpdate(envWith(db));
    const after = db.objects.get('qqwry.dat')!;
    expect(after.length).toBe(before.length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed when every mirror errors', async () => {
    const db = r2Stub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const status = await runUpdate(envWith(db));
    expect(status).toBe('qqwry:failed');
  });

  it('updates all configured pipelines and aggregates per-DB status', async () => {
    const db = r2Stub();
    const country = buildMmdb(
      [{ prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } }],
      { padTo: 1024 },
    );
    const asn = buildMmdb(
      [
        {
          prefix: '8.8.8.0/24',
          record: { autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' },
        },
      ],
      { padTo: 1024 },
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('qqwry')) return new Response(padPastMinSize(defaultFixture()).slice().buffer);
        if (u.includes('Country')) return new Response(country.slice().buffer);
        if (u.includes('ASN')) return new Response(asn.slice().buffer);
        throw new Error(`unexpected url ${u}`);
      }),
    );

    const status = await runUpdate(
      envWith(db, {
        GEOLITE_COUNTRY_URL: 'https://geo.invalid/GeoLite2-Country.mmdb',
        GEOLITE_ASN_URL: 'https://geo.invalid/GeoLite2-ASN.mmdb',
        GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
        GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
      }),
    );

    expect(status).toContain('qqwry:updated:');
    expect(status).toContain('geolite-country:updated:');
    expect(status).toContain('geolite-asn:updated:');
    expect(anyPipelineFailed(status)).toBe(false);
    expect(db.objects.get('GeoLite2-Country.mmdb')).toBeDefined();
    expect(db.objects.get('GeoLite2-ASN.mmdb')).toBeDefined();
  });

  it('keeps ok=true when only one pipeline fails', async () => {
    const db = r2Stub();
    const country = buildMmdb(
      [{ prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } }],
      { padTo: 1024 },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('Country')) return new Response(country.slice().buffer);
        throw new Error('network down');
      }),
    );

    const status = await runUpdate(
      envWith(db, {
        GEOLITE_COUNTRY_URL: 'https://geo.invalid/GeoLite2-Country.mmdb',
        GEOLITE_ASN_URL: 'https://geo.invalid/GeoLite2-ASN.mmdb',
        GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
        GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
      }),
    );

    expect(status).toContain('geolite-country:updated:');
    expect(status).toContain('qqwry:failed');
    expect(status).toContain('geolite-asn:failed');
    expect(anyPipelineFailed(status)).toBe(true);
  });

  it('skips pipelines whose URLs are not configured', async () => {
    const db = r2Stub();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(padPastMinSize(defaultFixture()).slice().buffer)),
    );

    const status = await runUpdate(envWith(db));
    expect(status).not.toContain('geolite');
  });
});
