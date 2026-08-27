import { describe, expect, it } from 'vitest';
import {
  isIPv4,
  isReservedIp,
  isValidIp,
  ipv4ToUint32,
  likelyChina,
  normaliseIp,
  uint32ToIpv4,
} from '../src/util';

describe('normaliseIp', () => {
  it('passes plain IPv4 through', () => {
    expect(normaliseIp('1.2.3.4')).toBe('1.2.3.4');
    expect(normaliseIp(' 8.8.8.8 ')).toBe('8.8.8.8');
  });
  it('strips ::ffff: mapped prefix', () => {
    expect(normaliseIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normaliseIp('::FFFF:8.8.8.8')).toBe('8.8.8.8');
  });
});

describe('classification', () => {
  it('detects IPv4 vs IPv6', () => {
    expect(isIPv4('1.2.3.4')).toBe(true);
    expect(isIPv4('2001:db8::1')).toBe(false);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp('not an ip')).toBe(false);
  });

  it('flags private and reserved ranges', () => {
    for (const ip of [
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '127.0.0.1',
      '169.254.10.10',
      '100.64.0.1',
      '100.127.255.254',
      '198.18.0.1',
      '::1',
      'fd00::1234',
      'fe80::abcd',
    ]) {
      expect(isReservedIp(ip), `expect ${ip} reserved`).toBe(true);
    }
  });

  it('does not flag public IPs', () => {
    for (const ip of ['8.8.8.8', '114.114.114.114', '2606:4700::1111', '1.2.3.4']) {
      expect(isReservedIp(ip), `expect ${ip} public`).toBe(false);
    }
  });

  it('treats 100.x outside CGNAT as public', () => {
    expect(isReservedIp('100.63.0.1')).toBe(false);
    expect(isReservedIp('100.128.0.1')).toBe(false);
    expect(isReservedIp('100.66.7.7')).toBe(true);
  });
});

describe('uint32 conversion roundtrip', () => {
  it('roundtrips every boundary', () => {
    const edges = ['0.0.0.0', '255.255.255.255', '1.2.3.4', '128.0.0.1', '9.9.9.9'];
    for (const ip of edges) {
      const n = ipv4ToUint32(ip);
      expect(n).not.toBeNull();
      expect(uint32ToIpv4(n!)).toBe(ip);
    }
  });
  it('rejects malformed input', () => {
    expect(ipv4ToUint32('999.1.1.1')).toBeNull();
    expect(ipv4ToUint32('1.2.3')).toBeNull();
    expect(ipv4ToUint32('a.b.c.d')).toBeNull();
  });
});

describe('likelyChina heuristic', () => {
  it('true for major CN blocks', () => {
    expect(likelyChina('114.114.114.114')).toBe(true);
    expect(likelyChina('220.181.38.148')).toBe(true); // Baidu range in 210-223 block
    expect(likelyChina('36.99.0.1')).toBe(true);
  });
  it('false for obvious foreign ranges', () => {
    expect(likelyChina('8.8.8.8')).toBe(false);
    expect(likelyChina('2.16.0.1')).toBe(false);
  });
});
