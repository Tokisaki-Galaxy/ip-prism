# ip-prism

<div align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6.svg?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Cloudflare_Workers-F38020.svg?style=flat-square&logo=cloudflareworkers&logoColor=white" alt="Cloudflare Workers">
  <img src="https://img.shields.io/badge/Cloudflare_R2-F38020.svg?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare R2">
  <img src="https://img.shields.io/badge/Cloudflare_KV-F38020.svg?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare KV">
  <img src="https://img.shields.io/badge/Vitest-729B1B.svg?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
  <img src="https://img.shields.io/badge/pnpm-F69220.svg?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
</div>

Multi-source IP geolocation on Cloudflare Workers (free plan).

One IP goes in, four spectra come out:

| Source | Type | Coverage | Notes |
|---|---|---|---|
| **cz88** | offline (`qqwry.dat` via R2) | IPv4, China-strong | zero outbound calls; GBK decoded natively |
| **geolite** | offline (GeoLite2 City+ASN via R2) | global, IPv4+IPv6 | zero outbound calls; country ISO code, region/city (City db), ASN, org, lat/lon |
| **ipinfo** | online | global | ASN, org, lat/lon |
| **amap** (高德) | online | mainland China only | province/city/adcode; quota-gated by cz88 CN detection |

Why an edge worker instead of querying from the application server:
the online lookups originate from Cloudflare's shared egress, never your
own infrastructure — there is no behavioural link between "who asked"
and "which IPs were looked up". Results are cached at the edge (KV,
30-day TTL), so repeat queries cost nothing.

## Endpoints

All routes except `/healthz` require `X-API-Key: <API_KEY>` header.

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness. Returns `{ok,version}` only — no auth. |
| GET | `/v1/lookup?ip=1.2.3.4` | Resolve one public IP across all sources. |
| POST | `/v1/lookup` | Batch: body `{"ips":["a","b"]}`, max 20. Invalid/reserved entries reported inline in `errors`. |
| POST | `/v1/admin/refresh` | Force a mirror pull of the latest offline DBs into R2 (same logic as the daily cron). |

Single lookup response shape:

```jsonc
{
  "ip": "36.99.5.5",
  "sources": {
    "cz88":    { "source": "cz88",    "ok": true, "country": "CN", "region": "中国–湖北–武汉" },
    "geolite": { "source": "geolite", "ok": true, "country": "CN",
                 "asn": "AS4134", "org": "Chinanet" },
    "amap":    { "source": "amap",    "ok": true, "region": "湖北", "city": "武汉",
                 "adcode": "420100", "lat": 22.65, "lon": 114.2 },
    "ipinfo":  { "source": "ipinfo",  "ok": true, "country": "CN",
                 "asn": "AS4134", "org": "Chinanet Guangdong" }
  },
  "best": {
    "country": { "value": "CN",   "source": "geolite" },
    "region":  { "value": "湖北", "source": "amap" },
    "city":    { "value": "武汉", "source": "amap" },
    "isp":     { "value": "电信", "source": "cz88" }
  },
  "resolvedAt": 1756280000000,   // Unix epoch ms
  "pending": false,              // true → result incomplete; retry shortly
  "summary": "CN · 湖北 · 武汉 · 电信"
}
```

### `best` / `summary` semantics

`best` picks each field from its AUTHORITATIVE source via a fixed priority
matrix (not first-wins), with source attribution:

| Slot | Priority | Notes |
|---|---|---|
| `country` | geolite → ipinfo → cz88 | ISO 3166-1 alpha-2, language-neutral |
| `region` | CN: amap → cz88¹ → ipinfo · non-CN: geolite → ipinfo → cz88 | ¹ combined `中国–湖北–武汉` records are split; 省/市 suffixes stripped |
| `city` | CN: amap → cz88¹ → ipinfo · non-CN: geolite → ipinfo | |
| `isp` | cz88 (CN IPs only) | access-network ISP (电信/联通/移动); AS org is a different concept and stays out |

geolite's region/city come from the optional GeoLite2-City database (English
names, offline); it leads the non-CN chains so lookups stay zero-outbound
whenever possible, with ipinfo as the online refinement. CN chains keep the
Chinese-locale convention and never consume geolite's English names.

`summary` is a deterministic rendering of `best`: ISO country code +
administrative names joined with ` · ` — Chinese for CN IPs, English
elsewhere (locale convention borrowed from ip2region).

IPv6 works for geolite/ipinfo/amap; cz88 is IPv4-only by database nature.
Private / loopback / CGNAT addresses are rejected client-side with `400`.

## Deploy

```bash
pnpm install

# One-time account resources (names are neutral by design)
npx wrangler r2 bucket create ip-prism-db
npx wrangler kv namespace create CACHE          # → paste id into wrangler.toml
npx wrangler kv namespace create CACHE --preview # → paste preview_id

# Secrets
npx wrangler secret put API_KEY        # random ≥32 hex; this is the caller's key
npx wrangler secret put IPINFO_TOKEN   # https://ipinfo.io/account/token
npx wrangler secret put AMAP_KEY       # https://console.amap.com → Web服务 key

# Ship it
npx wrangler deploy
```

## Data pipeline (zero manual updates)

A daily cron (`17 03 * * *`) refreshes every offline database:

**cz88 / qqwry.dat** (~11 MB, China-strong IPv4):

1. primary: <https://raw.githubusercontent.com/FW27623/qqwry/main/qqwry.dat>
   (daily auto-refresh from official channel)
2. fallback: <https://raw.githubusercontent.com/metowolf/qqwry.dat/main/qqwry.dat>

**GeoLite2-City.mmdb + GeoLite2-ASN.mmdb** (62.1 + 11.5 MB, global IPv4/IPv6;
the legacy Country.mmdb pipeline stays configured as the country fallback when
the City database is not yet uploaded):

- primary: <https://github.com/P3TERX/GeoLite.mmdb> daily release assets
  (country pipeline falls back to the <https://github.com/Loyalsoldier/geoip> mirror)

City-db memory budget on the Workers free plan: all databases are cached
isolate-globally — qqwry ~11 MB + City ~62 MB + ASN ~11.5 MB ≈ 85 MB of the
128 MB isolate limit (the Country db is not loaded while the City db is
present). If an deployment ever trips the memory limit, point
`GEOLITE_CITY_URL` at DB-IP's Lite City mmdb (~40 MB, same format, CC-BY
attribution required) — the parser is format-identical.

Downloads are sanity-checked (qqwry header offsets / MMDB magic + metadata
validation) before upload; unchanged content is skipped via fingerprint
comparison. Isolates reload each buffer from R2 automatically when the
object's ETag changes.

Force an immediate refresh: `curl -XPOST -H 'X-API-Key: …' https://…workers.dev/v1/admin/refresh`

## Smoke test after deploy

```bash
BASE=https://<your-subdomain>.workers.dev

curl -XPOST -H "X-API-Key: $KEY" "$BASE/v1/admin/refresh"          # pull all 4 DBs into R2 (City is ~62MB)
curl "$BASE/healthz"
curl -H "X-API-Key: $KEY" "$BASE/v1/lookup?ip=114.114.114.114"      # CN
curl -H "X-API-Key: $KEY" "$BASE/v1/lookup?ip=8.8.8.8"              # US, no amap hit
curl -H "X-API-Key: $KEY" "$BASE/v1/lookup?ip=2606:4700:4700::1111" # IPv6 via geolite
curl -XPOST -H "X-API-Key: $KEY" -d '{"ips":["1.2.4.8","8.8.8.8","192.168.1.1"]}' \
     "$BASE/v1/lookup"                                              # inline error for reserved
```

## Development

```bash
pnpm test         # vitest — fixture-based offline tests, network fully mocked
pnpm typecheck    # strict tsc --noEmit
pnpm dev          # local wrangler dev (needs .dev.vars, see .dev.vars.example)
```

Test strategy: all third-party behaviour is exercised against hand-built
spec-valid `qqwry.dat` and MaxMind `.mmdb` fixtures and stubbed R2/KV
bindings, so CI needs no network or real keys. The QQWry parser additionally
self-checks its GBK byte table against the platform `TextDecoder` to fail
loudly if runtime decode semantics drift.

## Architecture notes

- `src/db.ts` loads each offline DB once per isolate into module-global
  memory, keyed by R2 object; the free-plan limits that matter are
  10 ms CPU (binary search ≈ microseconds), 128 MB isolate memory
  (~85 MB used with the City database; see the data pipeline section for
  the budget and the DB-IP fallback), R2 objects up to 5 TB (KV's 25 MiB
  value cap is why payloads live in R2).
- Rate limiting (`src/ratelimit.ts`) is per-isolate token bucket, 1 QPS +
  jitter per online provider. Exactness is not required — the caches absorb
  the rest.
- Cache layers: isolate Map → KV write-through. Only complete results
  (`pending=false`, ≥1 ok source) are persisted.
- The single-flight map collapses concurrent identical lookups within one
  isolate; the KV layer dedupes across isolates organically.
