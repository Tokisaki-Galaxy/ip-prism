import { describe, expect, it } from 'vitest';
import { buildMmdb } from './mmdb-fixture-builder';
import { defaultFixture } from './fixture-builder';
import worker from '../src/index';
import type { Env } from '../src/types';

const countryDb = buildMmdb([
  { prefix: '8.8.8.0/24', record: { country: { iso_code: 'DE' } } },
  { prefix: '2001:db8::/32', record: { country: { iso_code: 'US' } } },
]);
const asnDb = buildMmdb([
  {
    prefix: '8.8.8.0/24',
    record: { autonomous_system_number: 15169, autonomous_system_organization: 'GOOGLE' },
  },
]);
const objects = new Map<string, Uint8Array>([
  ['qqwry.dat', defaultFixture()],
  ['GeoLite2-Country.mmdb', countryDb],
  ['GeoLite2-ASN.mmdb', asnDb],
]);

const env = {
  DB: {
    head: async (k: string) => (objects.get(k) ? { etag: `len${objects.get(k)!.length}` } : null),
    get: async (k: string) => {
      const v = objects.get(k);
      return v ? { arrayBuffer: async () => v.slice().buffer } : null;
    },
  },
  CACHE: { get: async () => null, put: async () => {} },
  DATA_OBJECT_KEY: 'qqwry.dat',
  GEOLITE_COUNTRY_KEY: 'GeoLite2-Country.mmdb',
  GEOLITE_ASN_KEY: 'GeoLite2-ASN.mmdb',
  CACHE_TTL_SECONDS: '2592000',
  MAX_BATCH: '20',
  API_KEY: 'smoke-key',
  IPINFO_TOKEN: '',
  AMAP_KEY: '',
} as unknown as Env;

async function call(path: string): Promise<{ status: number; body: any }> {
  const res = await worker.fetch(
    new Request(`https://worker.test${path}`, { headers: { 'X-API-Key': 'smoke-key' } }),
    env,
    {} as ExecutionContext,
  );
  return { status: res.status, body: await res.json() };
}

describe('smoke: worker end-to-end (in-process)', () => {
  it('healthz', async () => {
    const { status, body } = await call('/healthz');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
  });

  it('rejects missing API key', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/v1/lookup?ip=8.8.8.8'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('v4 lookup merges cz88 + geolite', async () => {
    const { status, body } = await call('/v1/lookup?ip=8.8.8.8');
    expect(status).toBe(200);
    expect(body.sources.geolite).toMatchObject({ ok: true, country: 'DE', asn: 'AS15169', org: 'GOOGLE' });
    expect(body.sources.cz88.ok).toBe(true);
    expect(body.pending).toBe(false);
  });

  it('v6 lookup resolves via geolite', async () => {
    const { status, body } = await call('/v1/lookup?ip=2001:db8::1');
    expect(status).toBe(200);
    expect(body.sources.geolite).toMatchObject({ ok: true, country: 'US' });
    expect(body.summary).toBe('US');
  });

  it('batch returns inline errors and geolite data', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/v1/lookup', {
        method: 'POST',
        headers: { 'X-API-Key': 'smoke-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ips: ['8.8.8.8', '192.168.1.1'] }),
      }),
      env,
      {} as ExecutionContext,
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.errors).toEqual({ '192.168.1.1': 'reserved' });
    expect(body.results[0].sources.geolite.ok).toBe(true);
  });
});
