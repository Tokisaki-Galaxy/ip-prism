/**
 * Programmatic builder of minimal, spec-valid MaxMind MMDB (.mmdb) fixtures.
 *
 * Layout produced (per the MaxMind DB File Format Specification):
 *   [search tree]      nodeCount × 6 bytes (recordSize=24, big-endian records)
 *   [16 zero bytes]    data section separator
 *   [data section]     MMDB-encoded values (maps, strings, uints, arrays)
 *   [metadata marker]  0xAB 0xCD 0xEF "MaxMind.com" (14 bytes)
 *   [metadata map]     MMDB-encoded map with the spec-required fields
 *
 * Semantics matched to mmdb-lib's reader:
 *   - record value  <  nodeCount → internal node reference
 *   - record value === nodeCount → lookup miss (missing subtree)
 *   - record value  >  nodeCount → data pointer (offset = value - nodeCount)
 *   - IPv4 addresses in an ip_version=6 tree live under ::/96 (96 zero bits)
 *
 * Extended types (uint64, array) encode the payload size in the ORIGINAL
 * control byte's low 5 bits, followed by the extended type number (type-7).
 *
 * Limitation: nested prefixes (e.g. 8.8.8.0/24 and 8.8.8.0/25) are not
 * supported — leaf records always terminate their branch.
 *
 * @module test/mmdb-fixture-builder
 */

import { Buffer } from 'node:buffer';

// ── MMDB data encoding ───────────────────────────────────────────────────
const UTF8 = 2;
const MAP = 7;
const ARRAY = 11;
const UINT64 = 9;

function encodeUtf8(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  if (b.length < 29) return [(UTF8 << 5) | b.length, ...b];
  if (b.length < 285) return [(UTF8 << 5) | 29, b.length - 29, ...b];
  const rest = b.length - 285;
  return [(UTF8 << 5) | 30, rest >> 8, rest & 0xff, ...b];
}

function encodeUint32(v: number): number[] {
  let size = 1;
  if (v > 0x00ffffff) size = 4;
  else if (v > 0x0000ffff) size = 3;
  else if (v > 0x000000ff) size = 2;
  const bytes: number[] = [];
  for (let i = size - 1; i >= 0; i--) bytes.push((v >> (i * 8)) & 0xff);
  return [(6 << 5) | size, ...bytes];
}

function encodeUint64(v: number | bigint): number[] {
  const n = BigInt(v);
  let size = 1;
  if (n > 0x0000000000ffffffn) size = 5;
  else if (n > 0x000000000000ffffn) size = 4;
  else if (n > 0x00000000000000ffn) size = 3;
  else if (n > 0x0000000000000000n) size = 2;
  const bytes: number[] = [];
  for (let i = size - 1; i >= 0; i--) bytes.push(Number((n >> BigInt(i * 8)) & 0xffn));
  // Extended type: size lives in the first ctrl byte's low 5 bits (type bits 0),
  // followed by the extended type number (UINT64 - 7).
  return [size, UINT64 - 7, ...bytes];
}

function encodeMap(entries: Array<[string, number[]]>): number[] {
  const out: number[] = [(MAP << 5) | entries.length];
  for (const [k, v] of entries) {
    out.push(...encodeUtf8(k), ...v);
  }
  return out;
}

function encodeArray(items: number[][]): number[] {
  // Extended type: size in the first byte's low 5 bits, then ARRAY - 7
  return [items.length, ARRAY - 7, ...items.flat()];
}

// ── Recursive MMDB value encoder ──────────────────────────────────────────

type MmdbValue = string | number | bigint | MmdbValue[] | { [k: string]: MmdbValue };

function encodeMmdbValue(v: MmdbValue): number[] {
  if (typeof v === 'string') return encodeUtf8(v);
  if (typeof v === 'number') return encodeUint32(v);
  if (typeof v === 'bigint') return encodeUint64(v);
  if (Array.isArray(v)) return encodeArray(v.map(encodeMmdbValue));
  const entries: Array<[string, number[]]> = [];
  for (const [k, val] of Object.entries(v)) {
    entries.push([k, encodeMmdbValue(val)]);
  }
  return encodeMap(entries);
}

// ── Address helpers ──────────────────────────────────────────────────────

/** Parse an (optionally compressed) IPv6 string into its 16 bytes. */
function ipv6Bytes(ip: string): number[] {
  const halves = ip.split('::');
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves[1] !== undefined ? halves[1].split(':').filter(Boolean) : undefined;

  let groups: string[];
  if (tail === undefined) {
    groups = head;
  } else {
    const fill = Math.max(0, 8 - head.length - tail.length);
    groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  }

  const result: number[] = [];
  for (const g of groups) {
    const v = parseInt(g || '0', 16) || 0;
    result.push((v >> 8) & 0xff, v & 0xff);
  }
  if (result.length !== 16) throw new Error(`bad ipv6: ${ip}`);
  return result;
}

/**
 * Map a dotted-quad IPv4 to its position in an ip_version=6 tree:
 * the address occupies the last 32 bits, preceded by 96 zero bits (::/96).
 */
function ipv4ToTreeBits(dotted: string): number[] {
  const b = dotted.split('.').map(Number);
  if (b.length !== 4 || b.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    throw new Error(`bad ipv4: ${dotted}`);
  }
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b[0]!, b[1]!, b[2]!, b[3]!];
}

function parsePrefix(prefix: string): { bits: number[]; length: number } {
  const slashParts = prefix.split('/');
  const addr = slashParts[0]!;
  const lenStr = slashParts[1];
  const length = lenStr !== undefined ? parseInt(lenStr, 10) : 128;
  if (Number.isNaN(length) || length < 0 || length > 128) {
    throw new Error(`bad prefix length: ${prefix}`);
  }
  if (addr.includes('.')) {
    // IPv4 in an ip_version=6 tree: the v4 bits live at positions 96-127,
    // so the tree path is the /96 zero prefix followed by the v4 prefix bits.
    return { bits: ipv4ToTreeBits(addr), length: 96 + length };
  }
  return { bits: ipv6Bytes(addr), length };
}

// ── Trie → flat search tree ──────────────────────────────────────────────

const SEPARATOR_SIZE = 16;

function buildTrie(networks: Array<{ prefix: string; dataOffset: number }>): {
  nodes: Array<{ left: number; right: number }>;
  nodeCount: number;
} {
  interface Trie {
    left?: Trie;
    right?: Trie;
    dataOffset?: number;
  }
  const root: Trie = {};

  for (const { prefix, dataOffset } of networks) {
    const { bits, length } = parsePrefix(prefix);
    let node = root;
    for (let i = 0; i < length; i++) {
      const bit = (bits[i >> 3]! >> (7 - (i & 7))) & 1;
      if (bit === 0) {
        node.left ??= {};
        node = node.left;
      } else {
        node.right ??= {};
        node = node.right;
      }
      if (node.dataOffset !== undefined) {
        throw new Error(`nested prefix not supported: ${prefix}`);
      }
    }
    node.dataOffset = dataOffset;
  }

  const flat: Array<{ left: number; right: number }> = [];
  const seen = new WeakMap<Trie, number>();
  let nextId = 0;

  /** Sentinels: data pointer = -(offset+1); missing subtree = MISSING. */
  const MISSING = -2;

  function assign(n: Trie): number {
    const existing = seen.get(n);
    if (existing !== undefined) return existing;
    const id = nextId++;
    seen.set(n, id);
    while (flat.length <= id) flat.push({ left: MISSING, right: MISSING });
    const slot = flat[id]!;
    slot.left = n.left ? assign(n.left) : MISSING;
    slot.right = n.right ? assign(n.right) : MISSING;
    if (n.dataOffset !== undefined) {
      slot.left = -(n.dataOffset + 1);
    }
    return id;
  }

  assign(root);

  // Resolve sentinels. Tree data pointers count the 16-byte separator in
  // their offset (mmdb-lib: fileOffset = value - nodeCount + searchTreeSize,
  // with the first real data byte living at searchTreeSize + 16):
  //   missing subtree → nodeCount (lookup miss)
  //   data pointer    → nodeCount + SEPARATOR_SIZE + dataOffset
  for (const node of flat) {
    node.left =
      node.left === MISSING
        ? flat.length
        : node.left < 0
          ? flat.length + SEPARATOR_SIZE + (-node.left - 1)
          : node.left;
    node.right =
      node.right === MISSING
        ? flat.length
        : node.right < 0
          ? flat.length + SEPARATOR_SIZE + (-node.right - 1)
          : node.right;
  }

  return { nodes: flat, nodeCount: flat.length };
}

// ── Full MMDB builder ────────────────────────────────────────────────────

const RECORD_SIZE = 24;
const NODE_BYTE_SIZE = RECORD_SIZE / 4; // 6
const MMDB_MAGIC = Uint8Array.of(
  0xab, 0xcd, 0xef, // marker prefix
  0x4d, 0x61, 0x78, 0x4d, 0x69, 0x6e, 0x64, 0x2e, 0x63, 0x6f, 0x6d, // "MaxMind.com"
);

export interface MmdbNetwork {
  /** CIDR prefix; IPv4 addresses are placed under ::/96. */
  prefix: string;
  /** Flat record map (nested maps/arrays/bigints supported). */
  record: MmdbValue;
}

/**
 * Build a minimal spec-valid MMDB buffer from a list of network records.
 *
 * @param opts.ipVersion  4 or 6 (default 6 — GeoLite2 files are v6 trees)
 * @param opts.padTo      Pad with zero bytes to at least this size
 */
export function buildMmdb(
  networks: MmdbNetwork[],
  opts: { ipVersion?: number; padTo?: number } = {},
): Uint8Array {
  const ipVersion = opts.ipVersion ?? 6;

  const encodedData: number[][] = [];
  let dataOffset = 0;
  const networkOffsets: Array<{ prefix: string; dataOffset: number }> = [];

  for (const net of networks) {
    const encoded = encodeMmdbValue(net.record);
    networkOffsets.push({ prefix: net.prefix, dataOffset });
    encodedData.push(encoded);
    dataOffset += encoded.length;
  }

  const { nodes, nodeCount } = buildTrie(networkOffsets);
  const treeSize = nodeCount * NODE_BYTE_SIZE;

  const metadata = encodeMmdbValue({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: BigInt(Math.floor(Date.now() / 1000)),
    database_type: 'ip-prism-test',
    description: { en: 'ip-prism test fixture' },
    ip_version: ipVersion,
    languages: ['en'],
    node_count: nodeCount,
    record_size: RECORD_SIZE,
  });

  const totalSize = treeSize + SEPARATOR_SIZE + dataOffset + MMDB_MAGIC.length + metadata.length;
  const buf = new Uint8Array(opts.padTo ? Math.max(totalSize, opts.padTo) : totalSize);
  let cursor = 0;

  // Search tree — two big-endian 24-bit records per node
  for (let i = 0; i < nodeCount; i++) {
    const left = nodes[i]!.left;
    const right = nodes[i]!.right;
    buf[cursor] = (left >> 16) & 0xff;
    buf[cursor + 1] = (left >> 8) & 0xff;
    buf[cursor + 2] = left & 0xff;
    buf[cursor + 3] = (right >> 16) & 0xff;
    buf[cursor + 4] = (right >> 8) & 0xff;
    buf[cursor + 5] = right & 0xff;
    cursor += NODE_BYTE_SIZE;
  }

  cursor += SEPARATOR_SIZE; // data section separator (zero bytes)

  for (const encoded of encodedData) {
    for (const byte of encoded) buf[cursor++] = byte;
  }

  buf.set(MMDB_MAGIC, cursor);
  cursor += MMDB_MAGIC.length;

  for (const byte of metadata) buf[cursor++] = byte;

  return buf;
}
