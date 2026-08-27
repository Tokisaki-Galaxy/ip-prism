/**
 * GeoLite2 provider — offline country + ASN lookups over MaxMind .mmdb
 * payloads stored in R2 (refreshed daily by the updater, see updater.ts).
 *
 * Two databases are consulted:
 *   - Country: `country.iso_code` → global ISO 3166-1 alpha-2 for IPv4+IPv6
 *   - ASN:     `autonomous_system_number` + `autonomous_system_organization`
 *
 * Both are parsed with `mmdb-lib`, a zero-dependency reader that operates
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
import type { CountryResponse, AsnResponse } from 'mmdb-lib';
import type { Env, SourceResult } from '../types.ts';
import { getDbBuffer } from '../db.ts';

/** Reader cache keyed by buffer object identity. */
const countryReaders = new WeakMap<Uint8Array, Reader<CountryResponse>>();
const asnReaders = new WeakMap<Uint8Array, Reader<AsnResponse>>();

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

/**
 * Query GeoLite2 Country + ASN for an IP (IPv4 or IPv6).
 * Returns a SourceResult; never throws (data-level failures become ok:false).
 */
export async function lookupGeolite(env: Env, ip: string): Promise<SourceResult> {
  const countryKey = env.GEOLITE_COUNTRY_KEY || 'GeoLite2-Country.mmdb';
  const asnKey = env.GEOLITE_ASN_KEY || 'GeoLite2-ASN.mmdb';

  let countryBuf: Uint8Array | null;
  let asnBuf: Uint8Array | null;
  try {
    [countryBuf, asnBuf] = await Promise.all([
      getDbBuffer(env, countryKey),
      getDbBuffer(env, asnKey),
    ]);
  } catch (err) {
    return { source: 'geolite', ok: false, error: `r2 error: ${String(err)}` };
  }

  if (!countryBuf && !asnBuf) {
    // Not uploaded yet (first deploy before cron) — caller marks pending.
    return { source: 'geolite', ok: false, error: 'database not loaded yet' };
  }

  const result: SourceResult = { source: 'geolite', ok: false };

  try {
    if (countryBuf) {
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
