/**
 * Programmatic builder of minimal, spec-valid qqwry.dat fixtures.
 *
 * Layout produced:
 *   [0..7]    header: u32le firstIdxOffset, u32le lastIdxOffset
 *   [8..]     records, back to back
 *   [idx..]   index area: 7 bytes per entry (u32le ip + u24le record offset)
 *
 * Records are contiguous: record i's range ends at record i+1's start - 1;
 * the last record runs to 255.255.255.255. This mirrors a real dat file,
 * which never has gaps.
 *
 * @module test/fixture-builder
 */

export interface DatRecord {
  /** Dotted-quad start IP. */
  startIp: string;
  /** Country field: ASCII string or raw GBK byte array (caller terminates). */
  country: Uint8Array | string;
  /** Area field: ASCII string / raw bytes / '' for empty. */
  area?: Uint8Array | string;
}

/** String → bytes with trailing NUL; plain ASCII only when given a string. */
function toBytes(v: Uint8Array | string | undefined): Uint8Array {
  if (v === undefined || v === '') return new Uint8Array([0]);
  if (typeof v === 'string') {
    const out = new Uint8Array(v.length + 1);
    for (let i = 0; i < v.length; i++) out[i] = v.charCodeAt(i);
    out[v.length] = 0;
    return out;
  }
  // Raw byte arrays must already include their terminator(s)
  return v;
}

function ipNum(dotted: string): number {
  const parts = dotted.split('.');
  if (parts.length !== 4) throw new Error(`bad ipv4: ${dotted}`);
  let n = 0;
  for (const p of parts) {
    const o = parseInt(p, 10);
    if (isNaN(o) || o < 0 || o > 255) throw new Error(`bad octet '${p}'`);
    n = (n * 256) | o;
  }
  return n >>> 0;
}

function putU32le(target: Uint8Array, pos: number, value: number): void {
  target[pos] = value & 0xff;
  target[pos + 1] = (value >>> 8) & 0xff;
  target[pos + 2] = (value >>> 16) & 0xff;
  target[pos + 3] = (value >>> 24) & 0xff;
}

/** Build the dat file from sorted records. */
export function buildQqwryDat(records: DatRecord[]): Uint8Array {
  if (records.length === 0) throw new Error('need ≥1 record');

  const countries = records.map((r) => toBytes(r.country));
  const areas = records.map((r) => toBytes(r.area));
  const ips = records.map((r) => ipNum(r.startIp));

  let recordsSize = 0;
  for (let i = 0; i < records.length; i++) {
    recordsSize += 4 + countries[i]!.length + areas[i]!.length;
  }

  const firstIdxOffset = 8 + recordsSize;
  const total = firstIdxOffset + records.length * 7;
  const buf = new Uint8Array(total);

  // Records
  let cursor = 8;
  const recOffsets: number[] = [];
  for (let i = 0; i < records.length; i++) {
    recOffsets.push(cursor);
    putU32le(buf, cursor, ips[i]!);
    cursor += 4;
    buf.set(countries[i]!, cursor);
    cursor += countries[i]!.length;
    buf.set(areas[i]!, cursor);
    cursor += areas[i]!.length;
  }

  // Index area
  for (let i = 0; i < records.length; i++) {
    const pos = firstIdxOffset + i * 7;
    const off = recOffsets[i]!;
    putU32le(buf, pos, ips[i]!);
    buf[pos + 4] = off & 0xff;
    buf[pos + 5] = (off >>> 8) & 0xff;
    buf[pos + 6] = (off >>> 16) & 0xff;
  }

  // Header
  putU32le(buf, 0, firstIdxOffset);
  putU32le(buf, 4, firstIdxOffset + (records.length - 1) * 7);

  return buf;
}

/**
 * Convenience demo database:
 *   1.2.4.0 – 1.2.4.255 → GUANGDONG SHENZHEN / TELECOM
 *   1.2.5.0 – 9.9.8.255 → CHINA          / (empty)
 *   9.9.9.0 – 255.255.255.255 → USA CALIFORNIA / GOOGLE
 */
export function defaultFixture(): Uint8Array {
  return buildQqwryDat([
    { startIp: '1.2.4.0', country: 'GUANGDONG SHENZHEN', area: 'TELECOM' },
    { startIp: '1.2.5.0', country: 'CHINA', area: '' },
    { startIp: '9.9.9.0', country: 'USA CALIFORNIA', area: 'GOOGLE' },
  ]);
}

/**
 * Pad a fixture past the 1 MiB floor enforced by the updater's sanity check.
 * Appends zeroed bytes AFTER the index area — every stored offset stays
 * valid, parsers simply never read the tail.
 */
export function padPastMinSize(bytes: Uint8Array): Uint8Array {
  const min = 1024 * 1024 + 1;
  if (bytes.length >= min) return bytes;
  const out = new Uint8Array(min);
  out.set(bytes, 0);
  return out;
}
