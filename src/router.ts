/**
 * Request routing + per-IP resolution orchestration.
 * Kept separate from `index.ts` so handlers are directly unit-testable
 * with stubbed Env bindings.
 *
 * @module router
 */

import type { Env, GeoSource, LookupResult, SourceResult } from './types';
import { cacheGet, cacheSet, singleFlight } from './cache';
import { getDbBuffer } from './db';
import { lookupCz88 } from './providers/cz88';
import { lookupGeolite } from './providers/geolite';
import { lookupIpInfo } from './providers/ipinfo';
import { lookupAmap } from './providers/amap';
import { isReservedIp, isValidIp, likelyChina, normaliseIp } from './util';

/** Parsed request-scoped config. */
export interface RuntimeConfig {
  cacheTtlMs: number;
  maxBatch: number;
  ipinfoToken: string;
  amapKey: string;
}

/** Parse config from env with defensive defaults. */
export function config(env: Env): RuntimeConfig {
  return {
    cacheTtlMs:
      Math.max(3600, parseInt(env.CACHE_TTL_SECONDS ?? '2592000', 10) || 2592000) * 1000,
    maxBatch: Math.min(50, parseInt(env.MAX_BATCH ?? '20', 10) || 20),
    ipinfoToken: env.IPINFO_TOKEN ?? '',
    amapKey: env.AMAP_KEY ?? '',
  };
}

/**
 * Build a one-line summary from per-source results.
 * Slots: [country, region, city] filled by first source providing each.
 */
export function summarise(sources: Partial<Record<GeoSource, SourceResult>>): string {
  const parts: string[] = [];
  for (const key of ['cz88', 'geolite', 'ipinfo', 'amap'] as const) {
    const s = sources[key];
    if (!s?.ok) continue;
    if (!parts[0] && s.country) parts[0] = s.country;
    if (!parts[1] && s.region && s.region !== s.country) parts[1] = s.region;
    if (!parts[2] && s.city && s.city !== s.region) parts[2] = s.city;
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * Resolve one IP across all sources (cache-aware, single-flight deduped).
 */
export async function resolveOne(ip: string, env: Env): Promise<LookupResult> {
  const cfg = config(env);
  const now = Date.now();

  const cached = await cacheGet(ip, env.CACHE);
  if (cached && !cached.pending) return cached;

  return singleFlight(`resolve:${ip}`, async () => {
    const results: Partial<Record<GeoSource, SourceResult>> = {};
    let pending = false;

    // ── cz88: offline backbone; IPv4 only ────────────────────────────────
    let china = false;
    let czOk = false;
    if (!isReservedIp(ip)) {
      const dat = await getDbBuffer(env, env.DATA_OBJECT_KEY);
      if (!dat) {
        results.cz88 = { source: 'cz88', ok: false, error: 'database not loaded yet' };
        pending = true;
      } else {
        const res = lookupCz88(dat, ip);
        results.cz88 = res;
        czOk = res.ok;
        china = res.ok && res.country === 'CN';
      }
    }

    // ── Online providers (public IPs only) ───────────────────────────────
    const tasks: Array<Promise<void>> = [];

    // geolite: offline country + ASN, IPv4+IPv6, zero outbound calls —
    // fire for every public IP with no quota gating.
    if (!isReservedIp(ip)) {
      tasks.push(
        lookupGeolite(env, ip).then((r) => {
          results.geolite = r;
          if (r.error === 'database not loaded yet') pending = true;
        }),
      );
    }

    if (cfg.ipinfoToken && !isReservedIp(ip)) {
      tasks.push(
        lookupIpInfo(ip, cfg.ipinfoToken).then((r) => {
          results.ipinfo = r;
          if (r.error === 'timeout') pending = true;
        }),
      );
    }

    // amap quota gate: only fire when cz88 confirmed CN, or heuristic says CN
    const cnGate = china || (!czOk && likelyChina(ip));
    if (cfg.amapKey && cnGate && !isReservedIp(ip)) {
      tasks.push(
        lookupAmap(ip, cfg.amapKey).then((r) => {
          results.amap = r;
          if (r.error === 'timeout') pending = true;
        }),
      );
    }

    await Promise.all(tasks);

    const result: LookupResult = {
      ip,
      sources: results,
      resolvedAt: now,
      pending,
      summary: summarise(results),
    };

    if (!pending && Object.values(results).some((r) => r?.ok)) {
      await cacheSet(ip, result, env.CACHE, cfg.cacheTtlMs);
    }

    return result;
  });
}

/** JSON response helper shared by handlers. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** GET /v1/lookup?ip= */
export async function handleSingle(url: URL, env: Env): Promise<Response> {
  const raw = url.searchParams.get('ip');
  if (!raw) return json({ error: 'missing ?ip= parameter' }, 400);

  const ip = normaliseIp(raw);
  if (!isValidIp(ip)) return json({ error: 'invalid ip', got: raw }, 400);
  if (isReservedIp(ip)) return json({ error: 'reserved/private address', ip }, 400);

  const result = await resolveOne(ip, env);
  return json(result);
}

/** POST /v1/lookup {ips:[...]} */
export async function handleBatch(request: Request, env: Env): Promise<Response> {
  let body: { ips?: unknown };
  try {
    body = (await request.json()) as { ips?: unknown };
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const arr = body.ips;
  if (!Array.isArray(arr)) return json({ error: 'body must be {ips:[...]}' }, 400);
  if (arr.length === 0) return json({ error: 'ips array empty' }, 400);

  const cfg = config(env);
  if (arr.length > cfg.maxBatch) {
    return json({ error: `too many ips (max ${cfg.maxBatch})` }, 400);
  }

  const seen = new Set<string>();
  /** First bad occurrence keyed by original input. */
  const errors: Record<string, string> = {};
  const unique: string[] = [];

  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const ip = normaliseIp(item);
    if (!isValidIp(ip)) {
      errors[item] ??= 'invalid';
      continue;
    }
    if (isReservedIp(ip)) {
      errors[item] ??= 'reserved';
      continue;
    }
    if (seen.has(ip)) continue;
    seen.add(ip);
    unique.push(ip);
  }

  // Concurrency 3 chunks — predictable subrequest usage per invocation
  const results: LookupResult[] = [];
  for (let i = 0; i < unique.length; i += 3) {
    const chunk = unique.slice(i, i + 3);
    results.push(...(await Promise.all(chunk.map((ip) => resolveOne(ip, env)))));
  }

  return json(Object.keys(errors).length ? { results, errors } : { results });
}
