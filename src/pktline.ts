// Pkt-lines: the framing of the git smart-HTTP protocol.
//
// Every protocol message is a sequence of packets, each prefixed by four
// lowercase hex digits giving the packet's total length including the prefix
// itself. Three lengths are control packets rather than data: 0000 is the
// flush that ends a stream or section, 0001 is the delimiter that separates
// protocol-v2 sections, and 0002 is a response-end marker (unused here). A
// data packet holds at most 65516 payload bytes. Sideband packets spend their
// first payload byte on a band number: 1 is pack data, 2 is progress, 3 is a
// fatal error.

export const PKT_FLUSH = 'flush';
export const PKT_DELIM = 'delim';

export type PktLine = string | typeof PKT_FLUSH | typeof PKT_DELIM;

/** Encode one data packet from a string payload. */
export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  return pktData(payload);
}

/** Encode one data packet from raw bytes. */
export function pktData(payload: Buffer): Buffer {
  const length = payload.length + 4;
  if (length > 65520) throw new Error('pkt-line payload too large');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (0001) that separates protocol-v2 sections. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a whole message of string lines plus a terminating flush. */
export function pktLines(lines: readonly string[]): Buffer {
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

/**
 * Decode the pkt-line stream at the front of `buffer`. Returns the packets
 * (strings for data, the PKT_FLUSH / PKT_DELIM markers for control packets)
 * and the number of bytes consumed — anything past the flush belongs to
 * whatever follows the stream (a packfile, in receive-pack). Throws when the
 * framing is malformed.
 */
export function decodePktStream(buffer: Buffer): { packets: PktLine[]; consumed: number } {
  const packets: PktLine[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push(PKT_FLUSH);
      pos += 4;
      return { packets, consumed: pos };
    }
    if (length === 1) {
      packets.push(PKT_DELIM);
      pos += 4;
      continue;
    }
    if (length === 2) {
      pos += 4;
      return { packets, consumed: pos };
    }
    if (length < 4) throw new Error(`invalid pkt-line length ${length}`);
    if (pos + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push(buffer.toString('utf8', pos + 4, pos + length));
    pos += length;
  }
  return { packets, consumed: pos };
}

/**
 * Decode a protocol-v2 request body: a list of header lines, a delimiter,
 * then argument lines up to the flush. Header lines are "key=value" pairs
 * (the command first); argument lines are returned raw.
 */
export function decodeV2Request(buffer: Buffer): { headers: Map<string, string>; args: string[] } {
  const { packets } = decodePktStream(buffer);
  const headers = new Map<string, string>();
  const args: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet === PKT_DELIM) {
      inArgs = true;
      continue;
    }
    if (packet === PKT_FLUSH) break;
    if (!inArgs) {
      const eq = packet.indexOf('=');
      if (eq === -1) headers.set(packet.trim(), '');
      else headers.set(packet.slice(0, eq).trim(), packet.slice(eq + 1).trim());
    } else {
      args.push(packet.replace(/\n$/, ''));
    }
  }
  return { headers, args };
}

/** Wrap bytes in sideband band-1 packets of at most 65515 data bytes each. */
export function sidebandWrap(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let pos = 0; pos < data.length; pos += CHUNK) {
    const slice = data.subarray(pos, Math.min(data.length, pos + CHUNK));
    packets.push(pktData(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}
