/**
 * GeoLite2 provider — offline country / city / ASN lookups over MaxMind
 * .mmdb payloads stored in R2 (refreshed daily by the updater, see updater.ts).
 *
 * Up to three databases are consulted:
 *   - City (optional, GEOLITE_CITY_URL): `subdivisions` / `city.names` /
 *     `location` for region/city/coords, and `country.iso_code` for the
 *     country slot — supersedes the Country database when configured
 *     (saves its ~8MB isolate footprint: one buffer instead of two)
 *   - Country: `country.iso_code` → global ISO 3166-1 alpha-2, used when
 *     the City database is not configured or not yet uploaded
 *   - ASN:     `autonomous_system_number` + `autonomous_system_organization`
 *
 * All are parsed with `mmdb-lib`, a zero-dependency reader that operates
 * directly on the in-memory buffer (binary search over the embedded tree —
 * microseconds per lookup, well inside the 10 ms CPU budget). Readers are
 * memoised per buffer identity: db.loadDbObject returns the same Uint8Array
 * instance until an etag change forces a reload, at which point the WeakMap
 * entry is simply abandoned for GC.
 *
 * Requires the `nodejs_compat` flag — mmdb-lib expects a Node `Buffer`.
 *
 * @module providers/geolite
 */

import { Reader } from 'mmdb-lib';
import { Buffer } from 'node:buffer';
import type { CountryResponse, AsnResponse, CityResponse } from 'mmdb-lib';
import type { Env, SourceResult } from '../types.ts';
import { getDbBuffer } from '../db.ts';

/** Reader cache keyed by buffer object identity. */
const countryReaders = new WeakMap<Uint8Array, Reader<CountryResponse>>();
const asnReaders = new WeakMap<Uint8Array, Reader<AsnResponse>>();
const cityReaders = new WeakMap<Uint8Array, Reader<CityResponse>>();

/** Build (or reuse) a typed Reader for a database buffer. */
function countryReader(buf: Uint8Array): Reader<CountryResponse> {
  const hit = countryReaders.get(buf);
  if (hit) return hit;
  const reader = new Reader<CountryResponse>(
    Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
  );
  countryReaders.set(buf, reader);
  return reader;
}

/** Build (or reuse) a typed Reader for a database buffer. */
function asnReader(buf: Uint8Array): Reader<AsnResponse> {
  const hit = asnReaders.get(buf);
  if (hit) return hit;
  const reader = new Reader<AsnResponse>(
    Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
  );
  asnReaders.set(buf, reader);
  return reader;
}

/** Build (or reuse) a typed Reader for a database buffer. */
function cityReader(buf: Uint8Array): Reader<CityResponse> {
  const hit = cityReaders.get(buf);
  if (hit) return hit;
  const reader = new Reader<CityResponse>(
    Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength),
  );
  cityReaders.set(buf, reader);
  return reader;
}

/**
 * Query GeoLite2 (City | Country) + ASN for an IP (IPv4 or IPv6).
 * Returns a SourceResult; never throws (data-level failures become ok:false).
 */
export async function lookupGeolite(env: Env, ip: string): Promise<SourceResult> {
  const countryKey = env.GEOLITE_COUNTRY_KEY || 'GeoLite2-Country.mmdb';
  const asnKey = env.GEOLITE_ASN_KEY || 'GeoLite2-ASN.mmdb';
  const cityKey = env.GEOLITE_CITY_KEY || 'GeoLite2-City.mmdb';
  const cityConfigured = Boolean(env.GEOLITE_CITY_URL);

  let cityBuf: Uint8Array | null = null;
  let countryBuf: Uint8Array | null = null;
  let asnBuf: Uint8Array | null = null;
  try {
    if (cityConfigured) {
      [cityBuf, asnBuf] = await Promise.all([
        getDbBuffer(env, cityKey),
        getDbBuffer(env, asnKey),
      ]);
      if (!cityBuf) {
        // City configured but the object is not in R2 yet (first deploy
        // before cron) — degrade to the Country database for the country slot.
        countryBuf = await getDbBuffer(env, countryKey);
      }
    } else {
      [countryBuf, asnBuf] = await Promise.all([
        getDbBuffer(env, countryKey),
        getDbBuffer(env, asnKey),
      ]);
    }
  } catch (err) {
    return { source: 'geolite', ok: false, error: `r2 error: ${String(err)}` };
  }

  if (!cityBuf && !countryBuf && !asnBuf) {
    // Not uploaded yet (first deploy before cron) — caller marks pending.
    return { source: 'geolite', ok: false, error: 'database not loaded yet' };
  }

  const result: SourceResult = { source: 'geolite', ok: false };

  try {
    if (cityBuf) {
      const rec = cityReader(cityBuf).get(ip);
      const iso = rec?.country?.iso_code ?? rec?.registered_country?.iso_code;
      if (iso) {
        result.country = iso;
        result.ok = true;
      }
      const subName = rec?.subdivisions?.[0]?.names?.en;
      const cityName = rec?.city?.names?.en;
      if (subName) result.region = subName;
      // Municipalities echo the same name for both levels (Berlin) — keep
      // the region slot only, mirroring the amap convention.
      if (cityName && cityName !== subName) result.city = cityName;
      if (typeof rec?.location?.latitude === 'number') result.lat = rec.location.latitude;
      if (typeof rec?.location?.longitude === 'number') result.lon = rec.location.longitude;
    } else if (countryBuf) {
      const rec = countryReader(countryBuf).get(ip);
      const iso = rec?.country?.iso_code ?? rec?.registered_country?.iso_code;
      if (iso) {
        result.country = iso;
        result.ok = true;
      }
    }

    if (asnBuf) {
      const rec = asnReader(asnBuf).get(ip);
      if (rec?.autonomous_system_number) {
        result.asn = `AS${rec.autonomous_system_number}`;
        if (rec.autonomous_system_organization) {
          result.org = rec.autonomous_system_organization;
        }
        result.ok = true;
      }
    }
  } catch (err) {
    return { source: 'geolite', ok: false, error: `db error: ${String(err)}` };
  }

  if (!result.ok) {
    // Loaded databases but the IP has no covering record (e.g. unallocated
    // space) — a data-level miss, not an infrastructure failure.
    result.error = 'no geolite record for ip';
  }
  return result;
}
