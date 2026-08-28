/**
 * Best-guess field selection + deterministic summary rendering.
 *
 * Design (borrowing from ip2region's fixed-slot / locale conventions and
 * Google Geocoding's structured+display split):
 *
 *  1. `buildBest` — for each semantic slot (country/region/city/isp), pick
 *     the value from the AUTHORITATIVE source for that field via a fixed
 *     priority matrix (first-wins iteration order of the old summarise()
 *     is gone — e.g. amap's adcode-backed 武汉 now beats ipinfo's Wuhan
 *     for CN IPs).
 *  2. `renderSummary` — deterministic one-line display string derived from
 *     `best`: ISO country code (language-neutral) + administrative names,
 *     joined with " · ". CN IPs render Chinese, foreign IPs English —
 *     never mixed within the geographic slots.
 *
 * Semantics note: the isp slot is the ACCESS-network ISP (cz88 area:
 * 电信/联通/移动). AS organisations (ipinfo/geolite org) are a different
 * concept and deliberately stay out of the summary.
 *
 * @module summary
 */

import type { BestSlot, FieldAttribution, GeoSource, SourceResult } from './types.ts';

/** Separator used by current qqwry mirrors inside combined CN records (en dash). */
const CZ_SEPARATOR = '–';

/** Strip a trailing 省/市 for display consistency with amap's naming. */
function normaliseAdmin(name: string): string {
  return name.replace(/[省市]$/, '');
}

/**
 * Split a combined cz88 region string like `中国–湖北–武汉` into
 * `{ region: '湖北', city: '武汉' }`.
 *
 * Conservative by design: returns `{}` unless the string starts with `中国`
 * AND contains the separator — foreign transliterations (`USA CALIFORNIA`)
 * and unparseable forms pass through untouched. Suffixes 省/市 are stripped
 * (湖北省→湖北, 武汉市→武汉, 北京市→北京); 自治区 names are kept whole
 * (内蒙古自治区).
 */
export function splitCz88Region(region: string): { region?: string; city?: string } {
  if (!region.startsWith('中国') || !region.includes(CZ_SEPARATOR)) return {};
  const parts = region
    .slice(2)
    .split(CZ_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return {};
  const out: { region?: string; city?: string } = { region: normaliseAdmin(parts[0]!) };
  const cityPart = parts[1];
  if (cityPart) out.city = normaliseAdmin(cityPart);
  return out;
}

/** One slot candidate: a value plus the source it came from. */
interface Candidate {
  source: GeoSource;
  value?: string | undefined;
}

/** First candidate with a non-empty value. */
function first(candidates: Candidate[]): FieldAttribution | undefined {
  for (const c of candidates) {
    if (c.value) return { value: c.value, source: c.source };
  }
  return undefined;
}

/**
 * Build the best-guess map from per-source results. Only ok sources
 * contribute; slots absent when no ok source provides them.
 */
export function buildBest(
  sources: Partial<Record<GeoSource, SourceResult>>,
): Partial<Record<BestSlot, FieldAttribution>> {
  const cz = sources.cz88?.ok ? sources.cz88 : undefined;
  const geo = sources.geolite?.ok ? sources.geolite : undefined;
  const ipi = sources.ipinfo?.ok ? sources.ipinfo : undefined;
  const ama = sources.amap?.ok ? sources.amap : undefined;

  const best: Partial<Record<BestSlot, FieldAttribution>> = {};

  // country: ISO 3166-1 alpha-2 — geolite is the canonical global source
  // (v4+v6); cz88 only derives 'CN'.
  const country = first([
    { source: 'geolite' as const, value: geo?.country },
    { source: 'ipinfo' as const, value: ipi?.country },
    { source: 'cz88' as const, value: cz?.country },
  ]);
  if (country) best.country = country;
  const isCN = country?.value === 'CN';

  // cz88 combined-record split (only applies to 中国-form strings)
  const czSplit = cz?.region ? splitCz88Region(cz.region) : {};

  // region: CN — amap authoritative (adcode cross-check), cz88-parsed
  // Chinese beats ipinfo's English; whole-string cz88 as last resort.
  // non-CN — ipinfo registry names beat cz88 transliterations.
  const region = first(
    isCN
      ? [
          { source: 'amap' as const, value: ama?.region },
          { source: 'cz88' as const, value: czSplit.region },
          { source: 'ipinfo' as const, value: ipi?.region },
          { source: 'cz88' as const, value: cz?.region },
        ]
      : [
          { source: 'ipinfo' as const, value: ipi?.region },
          { source: 'cz88' as const, value: cz?.region },
        ],
  );
  if (region) best.region = region;

  // city: amap → cz88-parsed → ipinfo for CN; ipinfo only otherwise.
  const city = first(
    isCN
      ? [
          { source: 'amap' as const, value: ama?.city },
          { source: 'cz88' as const, value: czSplit.city },
          { source: 'ipinfo' as const, value: ipi?.city },
        ]
      : [{ source: 'ipinfo' as const, value: ipi?.city }],
  );
  if (city) best.city = city;

  // isp: access-network ISP from cz88's area field, CN IPs only.
  if (isCN && cz?.org) best.isp = { value: cz.org, source: 'cz88' };

  return best;
}

const SLOT_ORDER: BestSlot[] = ['country', 'region', 'city', 'isp'];

/** Render `best` as the deterministic one-line display string. */
export function renderSummary(best: Partial<Record<BestSlot, FieldAttribution>>): string {
  return SLOT_ORDER.map((slot) => best[slot]?.value)
    .filter((v): v is string => Boolean(v))
    .join(' · ');
}
