/**
 * cz88 (qqwry.dat) offline provider — vendored TypeScript implementation of
 * the classic QQWry binary format (reference: cnwhy/lib-qqwry).
 *
 * Format summary:
 *   Header  : u32le[firstIndexOffset], u32le[lastIndexOffset]
 *   Index   : N × 7 bytes — u32le[ipStart], u24le[recordOffset]
 *   Record  : u32le[startIp], then country string, then area string
 *   Strings : GBK-encoded; two redirect modes:
 *             0x01 u24le→follow pointer to string (recursively)
 *             0x02 u24le→country pointed elsewhere, area follows inline
 *
 * Decoding uses TextDecoder('gbk') — natively available in workerd (the
 * CJK decoder path is enabled by default since compatibility date
 * 2026-03-03, see workers compat flag `text_decoder_cjk_decoder`).
 *
 * IPv4 only — qqwry.dat contains no IPv6 ranges. Callers should treat
 * v6 addresses as unsupported for this source.
 *
 * @module providers/cz88
 */

import type { SourceResult } from '../types.ts';
import { ipv4ToUint32, uint32ToIpv4 } from '../util.ts';

/** Reused GBK decoder (creating per call wastes allocations). */
const gbkDecoder = new TextDecoder('gbk');

interface DataView3 {
  buf: Uint8Array;
  view: DataView;
}

class QqwryFile implements DataView3 {
  buf: Uint8Array;
  view: DataView;
  /** Offset of first index entry. */
  readonly firstIdx: number;
  /** Offset of last index entry. */
  readonly lastIdx: number;
  /** Number of index entries. */
  readonly count: number;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 8) throw new Error('qqwry.dat too small');
    this.firstIdx = this.view.getUint32(0, true);
    this.lastIdx = this.view.getUint32(4, true);
    if (
      this.firstIdx <= 0 ||
      this.firstIdx >= buf.length ||
      this.lastIdx < this.firstIdx ||
      this.lastIdx >= buf.length
    ) {
      throw new Error('qqwry.dat header corrupt');
    }
    this.count = (this.lastIdx - this.firstIdx) / 7 + 1;
  }

  /** Read a 3-byte little-endian unsigned integer. */
  private u24le(pos: number): number {
    return (
      this.buf[pos]! |
      (this.buf[pos + 1]! << 8) |
      (this.buf[pos + 2]! << 16)
    );
  }

  /** Read a null-terminated GBK string starting at `pos`. */
  private readCString(pos: number): string {
    let end = pos;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    return gbkDecoder.decode(this.buf.subarray(pos, end));
  }

  /**
   * Resolve a possibly-redirected string.
   * Returns `{ text, nextPos }` where `nextPos` is where parsing continues
   * for the sibling field (area) — meaningful only for the country field.
   */
  private readField(pos: number): { text: string; nextPos: number } {
    const mode = this.buf[pos];
    if (mode === undefined) return { text: '', nextPos: pos };

    if (mode === 0x01) {
      // Redirected; the target itself will not be a further 0x01 redirect
      const ptr = this.u24le(pos + 1);
      return this.readField(ptr);
    }
    if (mode === 0x02) {
      // Country string pointed elsewhere; area starts right after the 3 ptr bytes
      const ptr = this.u24le(pos + 1);
      return { text: this.readCString(ptr), nextPos: pos + 4 };
    }
    // Direct inline C-string
    let end = pos;
    while (end < this.buf.length && this.buf[end] !== 0) end++;
    return { text: gbkDecoder.decode(this.buf.subarray(pos, end)), nextPos: end + 1 };
  }

  /** Look up a raw u32 IP → record fields, or `null` if out of range. */
  lookupRaw(ipNum: number): { start: number; end: number; country: string; area: string } | null {
    let lo = 0;
    let hi = this.count - 1;

    // Classic binary search over the index area; on miss return the
    // lower-bound entry whose range covers the queried IP.
    let match = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const idxPos = this.firstIdx + mid * 7;
      const idxIp = this.view.getUint32(idxPos, true);

      if (idxIp > ipNum) {
        hi = mid - 1;
      } else {
        match = mid;
        lo = mid + 1;
      }
    }
    if (match < 0) return null;

    const idxPos = this.firstIdx + match * 7;
    const recOff =
      this.buf[idxPos + 4]! |
      (this.buf[idxPos + 5]! << 8) |
      (this.buf[idxPos + 6]! << 16);

    const startIp = this.view.getUint32(recOff, true);
    // Country field begins right after startIp
    const countryRes = this.readField(recOff + 4);
    const areaRes = this.readField(countryRes.nextPos);

    // Scan forward through 0x01 chains to find the true range end
    let endProbe = recOff;
    // Range end is stored after the previous record's content — we instead
    // approximate via the NEXT index entry's start minus one, which is how
    // lib-qqwry computes coverage without extra parsing.
    let endIp: number;
    if (match + 1 < this.count) {
      const nextIdx = this.firstIdx + (match + 1) * 7;
      const nextRec =
        this.buf[nextIdx + 4]! | (this.buf[nextIdx + 5]! << 8) | (this.buf[nextIdx + 6]! << 16);
      endIp = this.view.getUint32(nextRec, true) - 1 >>> 0;
    } else {
      endIp = 0xffffffff;
    }

    void endProbe;

    return { start: startIp, end: endIp, country: countryRes.text, area: areaRes.text };
  }
}

/**
 * Map a raw cz88 record onto our SourceResult shape.
 *
 * cz88 encodes Chinese IPs with `country` = e.g. "广东省深圳市", foreign IPs
 * with the transliterated country name. We expose the whole thing via
 * region/city for consumers and derive a coarse country code.
 */
function toSourceResult(ip: string, rec: NonNullable<ReturnType<QqwryFile['lookupRaw']>>): SourceResult {
  const result: SourceResult = { source: 'cz88', ok: true };

  const cnIndicators = ['中国', '省', '市', '区', '县', '壮族自治区', '回族自治区', '维吾尔自治区'];
  const looksCn =
    rec.country.startsWith('中国') ||
    cnIndicators.some((s) => rec.country.includes(s));

  if (looksCn) {
    result.country = 'CN';
  }

  // Fill region / city from the combined text (cz88 does not split them)
  result.region = rec.country;
  if (rec.area && !/^cz88\.net$/i.test(rec.area)) {
    // Area holds ISP or district depending on database version; keep it as org hint
    result.org = rec.area;
  }

  result.raw = { start: uint32ToIpv4(rec.start), end: uint32ToIpv4(rec.end) };
  void ip; // caller context already has it; kept for symmetry
  return result;
}

/**
 * Look up an IPv4 address against the loaded QQWry buffer.
 *
 * @param dat     Raw bytes of qqwry.dat (from db.loadDbObject)
 * @param ipStr   Normalised IPv4 dotted-quad
 */
export function lookupCz88(dat: Uint8Array, ipStr: string): SourceResult {
  const ipNum = ipv4ToUint32(ipStr);
  if (ipNum === null) {
    return { source: 'cz88', ok: false, error: 'not an IPv4 address' };
  }

  try {
    const file = new QqwryFile(dat);
    const rec = file.lookupRaw(ipNum);
    if (!rec) {
      return { source: 'cz88', ok: false, error: 'out of range' };
    }
    return toSourceResult(ipStr, rec);
  } catch (err) {
    return { source: 'cz88', ok: false, error: `db error: ${String(err)}` };
  }
}

/** Exposed for tests. */
export { QqwryFile };
