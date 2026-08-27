/**
 * IP address utilities — normalisation, classification, parsing.
 *
 * @module util
 */

/** Private / reserved IPv4 CIDRs (RFC 1918, loopback, link-local, etc.). */
const RESERVED_IPV4_PREFIXES = [
  '0.',    // 0.0.0.0/8
  '10.',   // 10.0.0.0/8
  '127.',  // 127.0.0.0/8
  '169.254.', // 169.254.0.0/16
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.', // 172.16.0.0/12
  '192.0.0.', // 192.0.0.0/24
  '192.168.', // 192.168.0.0/16
  '198.18.', '198.19.', // 198.18.0.0/15
];

/**
 * Strip `::ffff:` IPv4-mapped prefix and trim whitespace.
 *
 * Express / many proxies report IPv4 connections as `::ffff:1.2.3.4`; the
 * geo providers expect the bare IPv4 form.
 */
export function normaliseIp(raw: string): string {
  const trimmed = raw.trim();
  // Handle ::ffff:a.b.c.d (IPv4-mapped IPv6)
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped?.[1]) return mapped[1];
  // Handle ::ffff:a.b.c.d with leading zero compression variants
  if (trimmed.toLowerCase().startsWith('::ffff:')) {
    const tail = trimmed.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  }
  return trimmed;
}

/** Detect whether a normalised IP string is IPv4. */
export function isIPv4(ip: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

/** Detect whether a normalised IP string is IPv6. */
export function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

/**
 * `true` if the IP is private, loopback, link-local, or otherwise not a
 * globally-routable address that geo providers would know about.
 *
 * For IPv6 we check the common non-global prefixes; for everything else
 * we fall back to "not reserved" (let the provider return an error).
 */
export function isReservedIp(ip: string): boolean {
  if (isIPv4(ip)) {
    // 100.64.0.0/10 — CGNAT
    if (ip.startsWith('100.')) {
      const second = parseInt(ip.split('.')[1]!, 10);
      if (second >= 64 && second <= 127) return true;
    }
    return RESERVED_IPV4_PREFIXES.some((p) => ip.startsWith(p));
  }
  if (isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||                     // loopback
      lower.startsWith('fc') || lower.startsWith('fd') || // ULA fc00::/7
      lower.startsWith('fe80')               // link-local
    );
  }
  return false;
}

/** Validate that a string is a plausible IP address (v4 or v6). */
export function isValidIp(ip: string): boolean {
  return isIPv4(ip) || isIPv6(ip);
}

/**
 * Parse an IPv4 dotted-quad string into a 32-bit unsigned integer.
 * Returns `null` for invalid input.
 */
export function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255 || part !== String(octet)) {
      return null;
    }
    result = (result << 8) | octet;
  }
  // Force unsigned
  return result >>> 0;
}

/** Convert a 32-bit unsigned integer back to dotted-quad notation. */
export function uint32ToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

/**
 * Best-effort guess whether an IP is in mainland China.
 *
 * Uses a coarse CIDR heuristic (the major China Telecom / Unicom / Mobile
 * blocks) — this is ONLY a pre-filter to avoid wasting amap API quota on
 * obviously-foreign IPs. The authoritative country check comes from the
 * cz88 lookup result.
 */
const CN_CIDR_RANGES: Array<[number, number]> = [
  // 1.0.1.0/24 — 223.255.0.0/18 (selected major China blocks)
  // This is intentionally a SHORT heuristic list; the real gate is cz88's
  // country field. Keeping it short avoids false negatives on edge ranges.
  [ipv4ToUint32('1.0.1.0')!, ipv4ToUint32('1.0.1.255')!],
  [ipv4ToUint32('14.0.0.0')!, ipv4ToUint32('14.255.255.255')!],
  [ipv4ToUint32('27.0.0.0')!, ipv4ToUint32('27.255.255.255')!],
  [ipv4ToUint32('36.96.0.0')!, ipv4ToUint32('36.255.255.255')!],
  [ipv4ToUint32('39.0.0.0')!, ipv4ToUint32('39.255.255.255')!],
  [ipv4ToUint32('42.0.0.0')!, ipv4ToUint32('42.255.255.255')!],
  [ipv4ToUint32('49.0.0.0')!, ipv4ToUint32('49.255.255.255')!],
  [ipv4ToUint32('58.0.0.0')!, ipv4ToUint32('61.255.255.255')!],
  [ipv4ToUint32('101.0.0.0')!, ipv4ToUint32('126.255.255.255')!],
  [ipv4ToUint32('175.0.0.0')!, ipv4ToUint32('182.255.255.255')!],
  [ipv4ToUint32('210.0.0.0')!, ipv4ToUint32('223.255.255.255')!],
];

/** Coarse heuristic: is this IPv4 likely in mainland China? */
export function likelyChina(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const n = ipv4ToUint32(ip);
  if (n === null) return false;
  return CN_CIDR_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}
