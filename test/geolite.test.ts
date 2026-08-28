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

function envWith(
  country: Uint8Array | null,
  asn: Uint8Array | null,
  city: Uint8Array | null = null,
  cityConfigured = false,
): Env {
  const objects = new Map<string, Uint8Array>();
  if (country) objects.set('GeoLite2-Country.mmdb', country);
  if (asn) objects.set('GeoLite2-ASN.mmdb', asn);
  if (city) objects.set('GeoLite2-City.mmdb', city);
  return {
    DB: r2Stub(objects),
    GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
    GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
    // The City pipeline is gated by GEOLITE_CITY_URL only — an object can
    // sit in R2 while the feature stays off.
    ...(cityConfigured
      ? {
          GEOLITE_CITY_URL: 'https://geo.invalid/GeoLite2-City.mmdb',
          GEOLITE_CITY_KEY: 'GeoLite2-City.mmdb',
        }
      : {}),
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

const cityDb = buildMmdb([
  {
    prefix: '8.8.8.0/24',
    record: {
      country: { iso_code: 'DE' },
      subdivisions: [{ iso_code: 'BY', names: { en: 'Bavaria' } }],
      city: { names: { en: 'Munich' } },
      location: { latitude: 48.1375, longitude: 11.575, accuracy_radius: 10 },
    },
  },
  { prefix: '2001:db8::/32', record: { country: { iso_code: 'US' } } },
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

  it('resolves region/city/coords from the City database (country included)', async () => {
    const res = await lookupGeolite(envWith(null, asnDb, cityDb, true), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('DE');
    expect(res.region).toBe('Bavaria');
    expect(res.city).toBe('Munich');
    expect(res.lat).toBeCloseTo(48.1375, 5);
    expect(res.lon).toBeCloseTo(11.575, 5);
    expect(res.asn).toBe('AS15169');
    expect(res.org).toBe('GOOGLE');
  });

  it('covers IPv6 through the City database too', async () => {
    const res = await lookupGeolite(envWith(null, null, cityDb, true), '2001:db8::1');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('US');
    expect(res.region).toBeUndefined();
  });

  it('degrades to the Country database when City is configured but missing', async () => {
    const res = await lookupGeolite(envWith(countryDb, asnDb, null, true), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('DE');
    expect(res.region).toBeUndefined();
    expect(res.city).toBeUndefined();
  });

  it('ignores a present City db when GEOLITE_CITY_URL is unset', async () => {
    const res = await lookupGeolite(envWith(countryDb, asnDb, cityDb, false), '8.8.8.8');
    expect(res.ok).toBe(true);
    expect(res.country).toBe('DE');
    expect(res.region).toBeUndefined();
    expect(res.city).toBeUndefined();
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
