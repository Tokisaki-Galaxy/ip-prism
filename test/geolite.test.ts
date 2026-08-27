import { beforeEach, describe, expect, it } from 'vitest';
import { lookupGeolite } from '../src/providers/geolite';
import { clearCache } from '../src/db';
import { buildMmdb } from './mmdb-fixture-builder';
import type { Env } from '../src/types';

/** Key-aware R2 stub serving per-object byte buffers. */
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
      return { arrayBuffer: async () => v.slice().buffer } as unknown as R2ObjectBody;
    },
    put: async () => ({} as R2Object),
    delete: async () => {},
  } as never;
}

function envWith(country: Uint8Array | null, asn: Uint8Array | null): Env {
  const objects = new Map<string, Uint8Array>();
  if (country) objects.set('GeoLite2-Country.mmdb', country);
  if (asn) objects.set('GeoLite2-ASN.mmdb', asn);
  return {
    DB: r2Stub(objects),
    GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
    GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
  } as unknown as Env;
}

const countryDb = buildMmdb([
  { prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } },
  { prefix: '2001:db8::/32', record: { country: { iso_code: 'US' } } },
]);

const asnDb = buildMmdb([
  {
    prefix: '8.8.8.0/24',
    record: { autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' },
  },
]);

beforeEach(() => {
  // db.loadDbObject caches per object key isolate-globally; the stub etag is
  // size-derived and would collide across same-size fixtures.
  clearCache();
});

describe('lookupGeolite', () => {
  it('resolves an IPv4 country via the ::/96 compatibility path', async () => {
    const res = await lookupGeolite(envWith(countryDb, null), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('DE');
  });

  it('resolves a native IPv6 network', async () => {
    const res = await lookupGeolite(envWith(countryDb, null), '2001:db8::1');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('US');
  });

  it('resolves ASN + org and formats the AS number', async () => {
    const res = await lookupGeolite(envWith(null, asnDb), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.asn).toBe('AS15169');
    expect(res.org).toBe('GOOGLE');
    expect(res.country).toBeUndefined();
  });

  it('merges country and ASN databases into one result', async () => {
    const res = await lookupGeolite(envWith(countryDb, asnDb), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('DE');
    expect(res.asn).toBe('AS15169');
    expect(res.org).toBe('GOOGLE');
  });

  it('reports a data-level miss for uncovered IPs', async () => {
    const res = await lookupGeolite(envWith(countryDb, asnDb), '9.9.9.9');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no geolite record for ip');
  });

  it('returns not-loaded when both databases are absent from R2', async () => {
    const res = await lookupGeolite(envWith(null, null), '8.8.8.8');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('database not loaded yet');
  });

  it('degrades to ASN-only when the country db is missing', async () => {
    const res = await lookupGeolite(envWith(null, asnDb), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.asn).toBe('AS15169');
    expect(res.country).toBeUndefined();
  });

  it('turns corrupt database bytes into a db error instead of throwing', async () => {
    const junk = new TextEncoder().encode('<html>503</html>'.repeat(40));
    const res = await lookupGeolite(envWith(junk, null), '8.8.8.8');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('db error');
  });
});
