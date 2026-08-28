import { describe, expect, it } from 'vitest';
import { buildBest, renderSummary, splitCz88Region } from '../src/summary';
import type { BestSlot, FieldAttribution, SourceResult } from '../src/types';

/** Shorthand SourceResult builder — ok sources only matter here. */
function src(source: SourceResult['source'], fields: Partial<SourceResult>): SourceResult {
  return { source, ok: true, ...fields };
}

function expectSlot(
  best: Partial<Record<BestSlot, FieldAttribution>>,
  slot: BestSlot,
  value: string,
  source: string,
): void {
  expect(best[slot]).toEqual({ value, source });
}

describe('splitCz88Region', () => {
  it('splits combined CN records (province + city)', () => {
    expect(splitCz88Region('中国–湖北–武汉')).toEqual({ region: '湖北', city: '武汉' });
  });

  it('strips 省/市 suffixes but keeps 自治区 whole', () => {
    expect(splitCz88Region('中国–湖北省–武汉市')).toEqual({ region: '湖北', city: '武汉' });
    expect(splitCz88Region('中国–内蒙古自治区–呼和浩特市')).toEqual({
      region: '内蒙古自治区',
      city: '呼和浩特',
    });
  });

  it('handles municipalities (single segment)', () => {
    expect(splitCz88Region('中国–北京市')).toEqual({ region: '北京' });
  });

  it('passes through foreign transliterations untouched', () => {
    expect(splitCz88Region('USA CALIFORNIA')).toEqual({});
  });

  it('rejects 中国-prefixed strings without the separator', () => {
    expect(splitCz88Region('中国武汉')).toEqual({});
  });
});

describe('buildBest — priority matrix', () => {
  it('CN IP with all four sources: amap wins region/city, geolite country, cz88 isp', () => {
    const best = buildBest({
      cz88: src('cz88', { country: 'CN', region: '中国–湖北–武汉', org: '电信' }),
      geolite: src('geolite', { country: 'CN', asn: 'AS4134', org: 'Chinanet' }),
      ipinfo: src('ipinfo', { country: 'CN', region: 'Hubei', city: 'Wuhan', asn: 'AS4134' }),
      amap: src('amap', { region: '湖北', city: '武汉', adcode: '420100' }),
    });

    expectSlot(best, 'country', 'CN', 'geolite');
    expectSlot(best, 'region', '湖北', 'amap');
    expectSlot(best, 'city', '武汉', 'amap');
    expectSlot(best, 'isp', '电信', 'cz88');
    expect(renderSummary(best)).toBe('CN · 湖北 · 武汉 · 电信');
  });

  it('CN IP without amap: cz88-parsed Chinese beats ipinfo/geolite English', () => {
    const best = buildBest({
      cz88: src('cz88', { country: 'CN', region: '中国–广东–深圳', org: '电信' }),
      geolite: src('geolite', { country: 'CN', region: 'Guangdong', city: 'Shenzhen' }),
      ipinfo: src('ipinfo', { country: 'CN', region: 'Guangdong', city: 'Shenzhen' }),
    });

    expectSlot(best, 'region', '广东', 'cz88');
    expectSlot(best, 'city', '深圳', 'cz88');
    expect(renderSummary(best)).toBe('CN · 广东 · 深圳 · 电信');
  });

  it('foreign IP: ipinfo beats cz88 transliteration, no isp slot', () => {
    const best = buildBest({
      cz88: src('cz88', { region: 'USA CALIFORNIA', org: 'GOOGLE' }),
      geolite: src('geolite', { country: 'US', asn: 'AS15169' }),
      ipinfo: src('ipinfo', { country: 'US', region: 'California', city: 'Mountain View' }),
    });

    expectSlot(best, 'country', 'US', 'geolite');
    expectSlot(best, 'region', 'California', 'ipinfo');
    expectSlot(best, 'city', 'Mountain View', 'ipinfo');
    expect(best.isp).toBeUndefined();
    expect(renderSummary(best)).toBe('US · California · Mountain View');
  });

  it('foreign IP without ipinfo: geolite city data fills region/city offline', () => {
    const best = buildBest({
      cz88: src('cz88', { region: 'USA CALIFORNIA', org: 'GOOGLE' }),
      geolite: src('geolite', {
        country: 'US',
        region: 'California',
        city: 'Mountain View',
        lat: 37.4,
        lon: -122.1,
      }),
    });

    expectSlot(best, 'country', 'US', 'geolite');
    expectSlot(best, 'region', 'California', 'geolite');
    expectSlot(best, 'city', 'Mountain View', 'geolite');
    expect(renderSummary(best)).toBe('US · California · Mountain View');
  });

  it('foreign IP with both: geolite wins region/city (offline-first)', () => {
    const best = buildBest({
      geolite: src('geolite', { country: 'DE', region: 'Bavaria', city: 'Munich' }),
      ipinfo: src('ipinfo', { country: 'DE', region: 'Bavaria', city: 'Munich' }),
    });

    expectSlot(best, 'region', 'Bavaria', 'geolite');
    expectSlot(best, 'city', 'Munich', 'geolite');
  });

  it('IPv6 with only geolite: country-only summary', () => {
    const best = buildBest({
      geolite: src('geolite', { country: 'US' }),
    });

    expectSlot(best, 'country', 'US', 'geolite');
    expect(best.region).toBeUndefined();
    expect(renderSummary(best)).toBe('US');
  });

  it('ok:false sources never contribute', () => {
    const best = buildBest({
      cz88: { source: 'cz88', ok: false, error: 'database not loaded yet' },
      geolite: src('geolite', { country: 'DE' }),
    });

    expectSlot(best, 'country', 'DE', 'geolite');
    expect(best.region).toBeUndefined();
  });

  it('empty input → empty best and empty summary', () => {
    const best = buildBest({});
    expect(best).toEqual({});
    expect(renderSummary(best)).toBe('');
  });

  it('municipality: amap region wins per matrix, no city slot', () => {
    const best = buildBest({
      cz88: src('cz88', { country: 'CN', region: '中国–北京市', org: '联通' }),
      amap: src('amap', { region: '北京市', adcode: '110000' }), // city === province → omitted
    });

    // amap is the authoritative CN region source even for municipalities;
    // its naming keeps the 市 suffix (existing amap.ts convention).
    expectSlot(best, 'region', '北京市', 'amap');
    expect(best.city).toBeUndefined();
    expect(best.isp).toEqual({ value: '联通', source: 'cz88' });
    expect(renderSummary(best)).toBe('CN · 北京市 · 联通');
  });

  it('municipality without amap: cz88-parsed region stands in', () => {
    const best = buildBest({
      cz88: src('cz88', { country: 'CN', region: '中国–北京市', org: '联通' }),
    });

    expectSlot(best, 'region', '北京', 'cz88');
    expect(best.city).toBeUndefined();
    expect(renderSummary(best)).toBe('CN · 北京 · 联通');
  });
});
