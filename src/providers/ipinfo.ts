/**
 * ipinfo.io provider — online lookup with ASN + geocoordinates.
 *
 * API: GET https://ipinfo.io/{ip}/json?token=TOKEN
 * Response (200): { ip, hostname, city, region, country: "US", loc:
 * "37.4056,-122.0775", org: "AS15169 Google LLC", postal, timezone }
 *
 * Errors as { error: {...} } with non-200 status.
 *
 * @module providers/ipinfo
 */

import type { SourceResult } from '../types.ts';
import { acquireToken } from '../ratelimit.ts';

interface IpinfoResponse {
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  loc?: string;
  org?: string;
  error?: { title?: string; message?: string };
}

/** Parse "AS15169 Google LLC" → { asn, org } with absent fields omitted. */
function splitOrg(raw: string | undefined): { asn?: string; org?: string } {
  if (!raw) return {};
  const m = raw.match(/^(AS\d+)\s+(.+)$/i);
  if (m?.[1] && m[2]) return { asn: m[1].toUpperCase(), org: m[2] };
  const onlyAsn = raw.match(/^AS\d+$/i);
  if (onlyAsn) return { asn: raw.toUpperCase() };
  return { org: raw };
}

/**
 * Query ipinfo for an IP.
 * Returns a SourceResult; never throws (network failures become ok:false).
 */
export async function lookupIpInfo(
  ip: string,
  token: string,
  timeoutMs = 8000,
): Promise<SourceResult> {
  if (!token) {
    return { source: 'ipinfo', ok: false, error: 'disabled: no IPINFO_TOKEN' };
  }

  await acquireToken('ipinfo');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });

    const body = (await res.json().catch(() => ({}))) as IpinfoResponse;

    if (!res.ok || body.error) {
      const msg = body.error?.message ?? `HTTP ${res.status}`;
      // ipinfo returns 404-ish errors cleanly; treat as data-level failure
      return { source: 'ipinfo', ok: false, error: msg };
    }

    const result: SourceResult = { source: 'ipinfo', ok: true };

    // Assign only when present (exactOptionalPropertyTypes)
    if (body.country) result.country = body.country;  // already ISO alpha-2
    if (body.region) result.region = body.region;
    if (body.city) result.city = body.city;

    const { asn, org } = splitOrg(body.org);
    if (asn) result.asn = asn;
    if (org) result.org = org;

    if (body.loc) {
      const [latStr, lonStr] = body.loc.split(',');
      const lat = parseFloat(latStr ?? '');
      const lon = parseFloat(lonStr ?? '');
      if (!isNaN(lat)) result.lat = lat;
      if (!isNaN(lon)) result.lon = lon;
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'timeout' : String(err);
    return { source: 'ipinfo', ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
