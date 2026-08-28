/**
 * Shared types for ip-prism — a multi-source IP geolocation edge service.
 *
 * @module types
 */

/** The geo data sources supported by this worker. */
export type GeoSource = 'cz88' | 'geolite' | 'ipinfo' | 'amap';

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
  /** Autonomous System Number (ipinfo / geolite, e.g. "AS4134"). */
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

/** Slots of the best-guess field map, in display order. */
export type BestSlot = 'country' | 'region' | 'city' | 'isp';

/** A best-guess field value with the source that provided it. */
export interface FieldAttribution {
  /** Field value (country: ISO 3166-1 alpha-2; region/city: administrative name; isp: access ISP). */
  value: string;
  /** Which source won this slot. */
  source: GeoSource;
}

/** Aggregated result for one IP across all configured sources. */
export interface LookupResult {
  /** The queried IP (normalised, no ::ffff: prefix). */
  ip: string;
  /** Per-source results keyed by source name. Absent sources were disabled
   *  (missing API key) or skipped (not applicable). */
  sources: Partial<Record<GeoSource, SourceResult>>;
  /** Best-guess per-field values, each attributed to its authoritative
   *  source (per-field priority, not first-wins). Empty object when no
   *  source succeeded. */
  best: Partial<Record<BestSlot, FieldAttribution>>;
  /** Unix epoch (ms) when this result was assembled. */
  resolvedAt: number;
  /** `true` when one or more sources are still in-flight or timed out; the
   *  caller may retry shortly to pick up completed results. */
  pending: boolean;
  /** Deterministic one-line rendering of `best` for list views, e.g.
   *  "CN · 湖北 · 武汉 · 电信". Locale convention: ISO country code +
   *  Chinese administrative names for CN IPs, English elsewhere. */
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

  /** GeoLite2 mirror URLs (GitHub release asset direct links). */
  GEOLITE_COUNTRY_URL: string;
  GEOLITE_ASN_URL: string;
  /** GeoLite2-City mirror — enables offline region/city/coords lookups.
   *  Optional: absent/empty skips the update pipeline and the city reader
   *  (country lookups then come from the Country database as before). */
  GEOLITE_CITY_URL?: string;
  /** R2 object keys under which the mmdb payloads are stored. */
  GEOLITE_COUNTRY_KEY: string;
  GEOLITE_ASN_KEY: string;
  /** R2 key for the City database (defaults to `GeoLite2-City.mmdb`). */
  GEOLITE_CITY_KEY?: string;

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
