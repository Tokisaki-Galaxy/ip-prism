/**
 * AMap (高德) provider — China-only IP location with adcode.
 *
 * API: GET https://restapi.amap.com/v3/ip?ip={ip}&key=KEY
 * Response: { status: "1", province: "广东省", city: "深圳市",
 *             adcode: "440300", rectangle: "113.9,22.5;114.5,22.8" }
 *
 * Key constraints (documented behaviour):
 *  - Only mainland-China IPs resolve; foreign IPs return empty fields or
 *    status "0" with info "INVALID_USER_KEY"-style errors.
 *  - Free tier is quota-limited, so callers pre-filter using cz88's country
 *    detection before invoking this provider.
 *
 * @module providers/amap
 */

import type { SourceResult } from '../types.ts';
import { acquireToken } from '../ratelimit.ts';

interface AmapResponse {
  status?: string;        // "1" success | "0" failure
  info?: string;
  infocode?: string;      // e.g. "10000" ok
  province?: string | string[];
  city?: string | string[];
  adcode?: string | string[];
  rectangle?: string | string[];
}

/** amap returns [] (empty array) instead of "" for unknown values — normalise. */
function pickStr(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/**
 * Query AMap for an IP. Caller is responsible for the China-only pre-filter.
 */
export async function lookupAmap(
  ip: string,
  key: string,
  timeoutMs = 8000,
): Promise<SourceResult> {
  if (!key) {
    return { source: 'amap', ok: false, error: 'disabled: no AMAP_KEY' };
  }

  await acquireToken('amap');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('https://restapi.amap.com/v3/ip');
    url.searchParams.set('ip', ip);
    url.searchParams.set('key', key);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    const body = (await res.json().catch(() => ({}))) as AmapResponse;

    if (!res.ok || body.status !== '1') {
      const msg = body.info ?? `HTTP ${res.status}`;
      // Notably: non-CN IPs often come back as status "0", info "UNKNOWN_IP"
      return { source: 'amap', ok: false, error: msg };
    }

    const result: SourceResult = { source: 'amap', ok: true };

    const province = pickStr(body.province);
    const city = pickStr(body.city);
    const regionName = province.replace(/[省]$/, '');
    if (regionName) result.region = regionName;
    // Municipality responses echo the same value for province and city
    if (city && city !== province) result.city = city.replace(/市$/, '');

    const adcode = pickStr(body.adcode);
    if (adcode) result.adcode = adcode;

    const rect = pickStr(body.rectangle);
    if (rect) result.rectangle = rect;

    // Derive lat/lon from rectangle centre ("lng1,lat1;lng2,lat2")
    if (rect && rect.includes(';')) {
      const [a, b] = rect.split(';');
      const pA = a?.split(',').map(Number) ?? [];
      const pB = b?.split(',').map(Number) ?? [];
      const [lng1, lat1, lng2, lat2] = [pA[0], pA[1], pB[0], pB[1]];
      if (
        lng1 !== undefined && !isNaN(lng1) &&
        lat1 !== undefined && !isNaN(lat1) &&
        lng2 !== undefined && !isNaN(lng2) &&
        lat2 !== undefined && !isNaN(lat2)
      ) {
        result.lon = +(((lng1 + lng2) / 2).toFixed(6));
        result.lat = +(((lat1 + lat2) / 2).toFixed(6));
      }
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'timeout' : String(err);
    return { source: 'amap', ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
