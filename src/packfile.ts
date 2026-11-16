// Packfiles: the on-the-wire container git moves objects in.
//
// A pack is "PACK", a u32 version (2), a u32 object count, then that many
// entries — a varint header naming the type and inflated size, followed by
// the zlib-deflated payload (or, for the two delta types, a base reference
// and a deflated delta program) — and a SHA-1 trailer over everything before
// it. This module builds packs of plain objects (a server never has to send
// deltas) and reads any pack a client sends, resolving OFS_DELTA and
// REF_DELTA entries against the pack itself and, for thin packs, against the
// receiving repository's own objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType } from './gitobjects.ts';

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Serialize objects into a complete pack (header, plain entries, SHA-1 trailer). */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodeEntryHeader(TYPE_CODES[object.type]!, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The varint entry header: type in bits 4-6 of the first byte, size little-endian 4 then 7 bits. */
function encodeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

interface RawEntry {
  typeCode: number;
  /** For OFS_DELTA: the byte distance back from this entry's start to its base's start. */
  ofsBase?: number;
  /** For REF_DELTA: the base object's id. */
  refBase?: string;
  /** The inflated payload (the object bytes, or the delta program for delta types). */
  data: Buffer;
  /** The offset in the pack where this entry's header begins. */
  start: number;
}

/** Inflate one entry's payload starting at `pos`; answers the bytes and the offset just past them. */
function inflateEntry(pack: Buffer, pos: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesRead: number };
  };
  return { data: result.buffer, next: pos + result.engine.bytesRead };
}

/** Parse a pack's raw entries without resolving deltas. Throws on any structural problem. */
function parseRawEntries(pack: Buffer): RawEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  const entries: RawEntry[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    let byte = pack[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos]!;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawEntry = { typeCode, data: Buffer.alloc(0), start };
    if (typeCode === OFS_DELTA) {
      byte = pack[pos]!;
      pos += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[pos]!;
        pos += 1;
        offset = (offset + 1) * 128 + (byte & 0x7f);
      }
      entry.ofsBase = offset;
    } else if (typeCode === REF_DELTA) {
      entry.refBase = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateEntry(pack, pos);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    pos = inflated.next;
    entries.push(entry);
  }
  return entries;
}

/** Apply a delta program to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let length = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset += delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          length += delta[pos]! * 2 ** (8 * bit);
          pos += 1;
        }
      }
      if (length === 0) length = 0x10000;
      parts.push(base.subarray(offset, offset + length));
      produced += length;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

export interface ParsedPack {
  /** Every object the pack carries, fully resolved, keyed by its id. */
  objects: Map<string, GitObject>;
}

/**
 * Parse a pack and resolve every entry to a whole object. `externalBase`
 * resolves REF_DELTA bases the pack itself does not carry (thin packs),
 * reading the receiving side's existing objects.
 */
export function parsePack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): ParsedPack {
  const raw = parseRawEntries(pack);
  const byStart = new Map<number, number>();
  raw.forEach((entry, index) => byStart.set(entry.start, index));
  const resolved: (GitObject | undefined)[] = raw.map(() => undefined);
  const objects = new Map<string, GitObject>();

  const resolve = (index: number): GitObject => {
    const cached = resolved[index];
    if (cached !== undefined) return cached;
    const entry = raw[index]!;
    let object: GitObject;
    if (entry.typeCode === OFS_DELTA || entry.typeCode === REF_DELTA) {
      let base: GitObject;
      if (entry.typeCode === OFS_DELTA) {
        const baseIndex = byStart.get(entry.start - entry.ofsBase!);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseIndex);
      } else {
        const baseOid = entry.refBase!;
        base = objects.get(baseOid) ?? externalBase?.(baseOid) ?? resolveInPack(baseOid);
        if (base === undefined) throw new Error(`ref-delta base ${baseOid} is not available`);
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      const type = CODE_TYPES[entry.typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.typeCode}`);
      object = { type, data: entry.data };
    }
    resolved[index] = object;
    objects.set(hashObject(object.type, object.data), object);
    return object;
  };

  const resolveInPack = (oid: string): GitObject => {
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index]!.typeCode === OFS_DELTA || raw[index]!.typeCode === REF_DELTA) continue;
      const candidate = resolve(index);
      if (hashObject(candidate.type, candidate.data) === oid) return candidate;
    }
    throw new Error(`ref-delta base ${oid} is not in the pack`);
  };

  for (let index = 0; index < raw.length; index += 1) resolve(index);
  return { objects };
}
