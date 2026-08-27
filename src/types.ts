/**
 * Shared types for ip-prism — a multi-source IP geolocation edge service.
 *
 * @module types
 */

/** The three geo data sources supported by this worker. */
export type GeoSource = 'cz88' | 'ipinfo' | 'amap';

/**
 * A single source's resolution result for one IP.
 *
 * Fields are optional because not every source provides every attribute
 * (e.g. cz88 has no ASN, amap has no lat/lon).
 */
export interface SourceResult {
  /** Which source produced this result. */
  source: GeoSource;
  /** Whether the lookup succeeded. `false` on network error, disabled, or
   *  not-applicable (e.g. amap skipped for non-China IPs). */
  ok: boolean;
  /** Human-readable error when `ok === false`. */
  error?: string;
  /** ISO 3166-1 alpha-2 country code (e.g. "CN", "US"). */
  country?: string;
  /** First-level administrative division (province / state). */
  region?: string;
  /** Second-level administrative division (city / prefecture). */
  city?: string;
  /** District / county (amap only, within China). */
  district?: string;
  /** Autonomous System Number (ipinfo only, e.g. "AS4134"). */
  asn?: string;
  /** Organisation / ISP name. */
  org?: string;
  /** Latitude (decimal degrees, WGS84). */
  lat?: number;
  /** Longitude (decimal degrees, WGS84). */
  lon?: number;
  /** AMap administrative division code (6-digit, China only). */
  adcode?: string;
  /** Bounding rectangle "lng1,lat1;lng2,lat2" (amap only). */
  rectangle?: string;
  /** Raw upstream response for debugging / advanced consumers. */
  raw?: unknown;
}

/** Aggregated result for one IP across all configured sources. */
export interface LookupResult {
  /** The queried IP (normalised, no ::ffff: prefix). */
  ip: string;
  /** Per-source results keyed by source name. Absent sources were disabled
   *  (missing API key) or skipped (not applicable). */
  sources: Partial<Record<GeoSource, SourceResult>>;
  /** Unix epoch (ms) when this result was assembled. */
  resolvedAt: number;
  /** `true` when one or more sources are still in-flight or timed out; the
   *  caller may retry shortly to pick up completed results. */
  pending: boolean;
  /** Best-effort one-line summary for list views, e.g. "CN · 广东 · 深圳". */
  summary: string;
}

/** Normalised environment bindings declared in wrangler.toml. */
export interface Env {
  // Bindings
  DB: R2Bucket;
  CACHE: KVNamespace;

  // Non-secret vars (wrangler.toml [vars])
  DATA_PRIMARY_URL: string;
  DATA_FALLBACK_URL: string;
  DATA_OBJECT_KEY: string;
  CACHE_TTL_SECONDS: string;
  MAX_BATCH: string;

  // Secrets (wrangler secret put)
  API_KEY: string;
  IPINFO_TOKEN: string;
  AMAP_KEY: string;
}

/** Parsed config derived from Env at request time. */
export interface AppConfig {
  cacheTtl: number;
  maxBatch: number;
  ipinfoToken: string;
  amapKey: string;
}
