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
| **geolite** | offline (GeoLite2 Country+ASN via R2) | global, IPv4+IPv6 | zero outbound calls; country ISO code, ASN, org |
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
    "cz88":    { "source": "cz88",    "ok": true, "country": "CN", "region": "中国广东省" },
    "geolite": { "source": "geolite", "ok": true, "country": "CN",
                 "asn": "AS4134", "org": "Chinanet" },
    "amap":    { "source": "amap",    "ok": true, "region": "广东", "city": "深圳",
                 "adcode": "440300", "lat": 22.65, "lon": 114.2 },
    "ipinfo":  { "source": "ipinfo",  "ok": true, "country": "CN",
                 "asn": "AS4134", "org": "Chinanet Guangdong" }
  },
  "resolvedAt": 1756280000000,
  "pending": false,          // true → some source timed out; retry shortly
  "summary": "CN · 中国广东省 · 深圳"
}
```

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

**GeoLite2-Country.mmdb + GeoLite2-ASN.mmdb** (8.2 + 11.5 MB, global IPv4/IPv6):

- primary: <https://github.com/P3TERX/GeoLite.mmdb> daily release assets
  (country pipeline falls back to the <https://github.com/Loyalsoldier/geoip> mirror)

Downloads are sanity-checked (qqwry header offsets / MMDB magic + metadata
validation) before upload; unchanged content is skipped via fingerprint
comparison. Isolates reload each buffer from R2 automatically when the
object's ETag changes.

Force an immediate refresh: `curl -XPOST -H 'X-API-Key: …' https://…workers.dev/v1/admin/refresh`

## Smoke test after deploy

```bash
BASE=https://<your-subdomain>.workers.dev

curl -XPOST -H "X-API-Key: $KEY" "$BASE/v1/admin/refresh"          # pull all 3 DBs into R2
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
  25 MiB/R2 object (~31 MB used total), 10 ms CPU (binary search ≈
  microseconds), 128 MB isolate memory.
- Rate limiting (`src/ratelimit.ts`) is per-isolate token bucket, 1 QPS +
  jitter per online provider. Exactness is not required — the caches absorb
  the rest.
- Cache layers: isolate Map → KV write-through. Only complete results
  (`pending=false`, ≥1 ok source) are persisted.
- The single-flight map collapses concurrent identical lookups within one
  isolate; the KV layer dedupes across isolates organically.
