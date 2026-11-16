// Git smart HTTP: the /{owner}/{repo}.git endpoints.
//
// Three routes per repository:
//   GET  info/refs?service=git-upload-pack    the v2 advertisement when the
//                                             client asks for protocol v2,
//                                             the v0 one otherwise
//   GET  info/refs?service=git-receive-pack   always the v0 advertisement
//   POST git-upload-pack                      v2 ls-refs and fetch, v0 fetch
//   POST git-receive-pack                     v0 push with report-status
//
// The advertisements, the fetch planner (wants minus haves, with shallow
// boundaries) and the push rules (fast-forward only, per-ref answers) follow
// the protocol documents and the suite's own client, which parses strictly:
// section framing in v2 fetch answers, sideband framing in v0, and the exact
// "ng <ref> non-fast-forward" reason string in a push report.

import {
  ZERO_OID,
  addTreeClosure,
  closureOf,
  commitOf,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  peelToNonTag,
  type GitObject,
} from './gitobjects.ts';
import { buildPack, parsePack } from './packfile.ts';
import { PKT_DELIM, PKT_FLUSH, decodePktStream, decodeV2Request, pktFlush, pktLine, pktLines, sidebandWrap } from './pktline.ts';
import type { Forge, RepoRec } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-relative agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function jsonError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message })) };
}

/** The refs a repository advertises, sorted by name, HEAD first in the caller's hands. */
function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headRefName(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- advertisements

/** The v0 advertisement body for a service ('git-upload-pack' or 'git-receive-pack'). */
function advertiseV0(forge: Forge, repo: RepoRec, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : UPLOAD_CAPS_V0;
  const allCaps = `${caps} symref=HEAD:${headRefName(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = forge.headTip(repo);
  if (refs.length === 0 || headTip === null) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${allCaps}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const lookup = forge.lookup(repo);
  let first = true;
  const refLine = (oid: string, name: string): void => {
    if (first) {
      parts.push(pktLine(`${oid} ${name}\0${allCaps}\n`));
      first = false;
    } else {
      parts.push(pktLine(`${oid} ${name}\n`));
    }
    const object = lookup(oid);
    if (object !== undefined && object.type === 'tag') {
      parts.push(pktLine(`${peelToNonTag(lookup, oid)} ${name}^{}\n`));
    }
  };
  refLine(headTip, 'HEAD');
  for (const [name, oid] of refs) refLine(oid, name);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The protocol-v2 advertisement for upload-pack: version, then capability lines. */
function advertiseV2(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

/** GET info/refs. A missing repository is a 404 for both services. */
export function handleInfoRefs(
  forge: Forge,
  repo: RepoRec | undefined,
  service: string | null,
  wantsV2: boolean,
): GitResponse {
  if (repo === undefined) return jsonError(404, 'Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return jsonError(400, 'unknown service');
  }
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: advertiseV0(forge, repo, service),
  };
}

// ---------------------------------------------------------------- ls-refs

/** One ls-refs answer line set (protocol v2). */
function lsRefsLines(forge: Forge, repo: RepoRec, args: readonly string[]): string[] {
  const lookup = forge.lookup(repo);
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const lines: string[] = [];
  const headName = headRefName(repo);
  const headTip = forge.headTip(repo);
  // HEAD is a pseudo-ref in the answer: present when no prefixes were given,
  // or when a prefix matches HEAD's own name (a clone asks for exactly that,
  // with "ref-prefix HEAD"); a bare refs/heads/ prefix does not pull it in.
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${wantSymrefs ? ` symref-target:${headName}` : ''}\n`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${headName}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    const object = lookup(oid);
    if (wantPeel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${peelToNonTag(lookup, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** A 'deepen' counted from the client's current depth, not from the want. */
  deepenRelative: boolean;
  /** Whether the client closed negotiation with 'done' in this request. */
  done: boolean;
}

interface FetchPlan {
  /** The objects to pack, in a stable order (commits first). */
  objects: GitObject[];
  shallowLines: string[];
  unshallowLines: string[];
  /** A have the client and server share, for the ACK line; null for NAK. */
  common: string | null;
  /** Every have that names a commit the server holds, in request order. */
  commonHaves: string[];
}

/**
 * Plan a fetch: the objects reachable from the wants that the client does
 * not already hold. Haves the client lists as shallow are held only down to
 * their own trees — their ancestors are exactly what a deepen asks for, so
 * the walk passes through them. A depth limit cuts the walk by generations
 * from the wants and marks the cut commits as the new shallow boundary.
 */
function planFetch(forge: Forge, repo: RepoRec, request: FetchRequest): FetchPlan {
  const lookup = forge.lookup(repo);
  const shallowSet = new Set(request.shallow.filter((oid) => isOid(oid) && lookup(oid)?.type === 'commit'));
  const haves = request.haves.filter((oid) => isOid(oid) && lookup(oid)?.type === 'commit');

  // What the client already holds: every ancestor of a have, but grafted at
  // the shallow boundary — a commit named in a 'shallow' line is held itself,
  // its parents are not. Held objects are the held commits plus their trees.
  const heldCommits = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (heldCommits.has(oid)) continue;
      heldCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      const object = lookup(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
  }
  const heldObjects = new Set<string>(heldCommits);
  for (const oid of heldCommits) {
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') addTreeClosure(lookup, parseCommit(object.data).tree, heldObjects);
  }

  // Everything strictly below the client's shallow boundary. An unbounded
  // fetch (no depth requested) must not send any of it — the client grafts
  // its boundary and cannot link deeper history; a fetch with a depth (a
  // deepen, or deepen-2147483647 for --unshallow) may.
  const belowBoundary = new Set<string>();
  {
    const stack: string[] = [];
    for (const oid of shallowSet) {
      const object = lookup(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (belowBoundary.has(oid) || shallowSet.has(oid)) continue;
      belowBoundary.add(oid);
      const object = lookup(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
  }

  // Breadth-first walk from the wants, tracking generation distance. Tags on
  // the way are collected without consuming depth.
  const tagObjects = new Set<string>();
  const dist = new Map<string, number>();
  const queue: [string, number][] = [];
  const seedCommit = (oid: string, depth: number): void => {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = lookup(current);
      if (object === undefined) return;
      if (object.type === 'tag') {
        tagObjects.add(current);
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') {
        if (!dist.has(current) || depth < dist.get(current)!) queue.push([current, depth]);
      } else if (object.type === 'tree') {
        addTreeClosure(lookup, current, tagObjects);
      } else {
        tagObjects.add(current);
      }
      return;
    }
  };
  for (const want of request.wants) if (isOid(want)) seedCommit(want, 0);
  while (queue.length > 0) {
    const [oid, depth] = queue.shift()!;
    if (dist.has(oid) && dist.get(oid)! <= depth) continue;
    dist.set(oid, depth);
    // For a plain depth-limited fetch, nothing at distance >= depth can be
    // sent or measured, so the walk stops at the last included generation.
    // (A relative deepen is exempt: the boundary's own distance must be
    // measured through held commits first.)
    if (request.depth !== undefined && !request.deepenRelative && depth >= request.depth - 1) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!dist.has(parent) || dist.get(parent)! > depth + 1) queue.push([parent, depth + 1]);
    }
  }

  // The effective depth: the requested depth, or — for a relative deepen —
  // the depth the client's shallow boundary already sits at, plus the
  // requested increment. A depth of N includes N generations (distances
  // 0..N-1 from a want).
  let effectiveDepth = request.depth;
  if (request.depth !== undefined && request.deepenRelative) {
    let current = 1;
    for (const oid of shallowSet) {
      const at = dist.get(oid);
      if (at !== undefined) current = Math.max(current, at + 1);
    }
    effectiveDepth = current + request.depth;
  }

  const sendCommits = new Set<string>();
  for (const [oid, depth] of dist) {
    if (effectiveDepth !== undefined && depth >= effectiveDepth) continue;
    if (heldCommits.has(oid)) continue;
    if (request.depth === undefined && belowBoundary.has(oid)) continue;
    sendCommits.add(oid);
  }

  const send = new Set<string>();
  for (const oid of sendCommits) {
    send.add(oid);
    const commit = lookup(oid);
    if (commit !== undefined && commit.type === 'commit') addTreeClosure(lookup, parseCommit(commit.data).tree, send);
  }
  for (const oid of tagObjects) {
    if (!heldObjects.has(oid)) send.add(oid);
  }
  for (const oid of heldObjects) send.delete(oid);

  // The shallow boundary: sent commits with a parent the client will not
  // hold in full after this fetch. Only meaningful when the fetch is shallow
  // (a depth was requested, or the client already carries a boundary).
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (effectiveDepth !== undefined || shallowSet.size > 0) {
    const boundary = new Set<string>();
    for (const oid of sendCommits) {
      const commit = lookup(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      for (const parent of parseCommit(commit.data).parents) {
        const solidlyHeld = heldCommits.has(parent) && !shallowSet.has(parent);
        if (lookup(parent) !== undefined && !sendCommits.has(parent) && !solidlyHeld) boundary.add(oid);
      }
    }
    for (const oid of boundary) if (!shallowSet.has(oid)) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of shallowSet) {
      if (boundary.has(oid)) continue;
      const commit = lookup(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      const parents = parseCommit(commit.data).parents;
      const delivered = sendCommits.has(oid) || parents.some((parent) => sendCommits.has(parent));
      if (delivered) unshallowLines.push(`unshallow ${oid}\n`);
    }
  }

  const objects: GitObject[] = [];
  const pushObject = (oid: string): void => {
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  };
  for (const oid of sendCommits) pushObject(oid);
  for (const oid of send) if (!sendCommits.has(oid)) pushObject(oid);

  let common: string | null = null;
  const commonHaves: string[] = [];
  for (const have of request.haves) {
    if (isOid(have) && lookup(have)?.type === 'commit') {
      common = have;
      commonHaves.push(have);
    }
  }
  return { objects, shallowLines, unshallowLines, common, commonHaves };
}

/**
 * The v2 fetch answer, in the shapes the protocol's state machine allows:
 *
 *   - haves but no 'done', and nothing in common: an acknowledgments section
 *     carrying only NAK — negotiation continues in the client's next request,
 *     and no other section may follow.
 *   - haves but no 'done', with a common commit: acknowledgments with an ACK
 *     per common have and 'ready', then — in the same answer — shallow-info
 *     when the boundary moved and a packfile section (an empty pack when
 *     there is nothing new: after 'ready' the packfile must come).
 *   - 'done' sent (a clone, or a client that negotiates in one request): no
 *     acknowledgments at all; shallow-info and packfile sections only, the
 *     packfile omitted when there are no objects to send.
 */
function fetchResponseV2(plan: FetchPlan, request: FetchRequest): Buffer {
  const joinSections = (sections: Buffer[][]): Buffer => {
    const parts: Buffer[] = [];
    sections.forEach((section, index) => {
      parts.push(...section);
      parts.push(index === sections.length - 1 ? pktFlush() : delimPacket());
    });
    return Buffer.concat(parts);
  };
  const shallowSection = (): Buffer[] | null => {
    const lines = [...plan.shallowLines, ...plan.unshallowLines];
    return lines.length === 0 ? null : [pktLine('shallow-info\n'), ...lines.map((line) => pktLine(line))];
  };

  if (!request.done && request.haves.length > 0) {
    if (plan.commonHaves.length === 0) {
      return joinSections([[pktLine('acknowledgments\n'), pktLine('NAK\n')]]);
    }
    const ackLines = [...plan.commonHaves.map((have) => `ACK ${have}\n`), 'ready\n'];
    const sections: Buffer[][] = [[pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(line))]];
    const shallow = shallowSection();
    if (shallow !== null) sections.push(shallow);
    sections.push([pktLine('packfile\n'), ...sidebandWrap(buildPack(plan.objects))]);
    return joinSections(sections);
  }

  const sections: Buffer[][] = [];
  const shallow = shallowSection();
  if (shallow !== null) sections.push(shallow);
  if (plan.objects.length > 0) {
    sections.push([pktLine('packfile\n'), ...sidebandWrap(buildPack(plan.objects))]);
  }
  if (sections.length === 0) return pktFlush();
  return joinSections(sections);
}

function delimPacket(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/**
 * The v0 fetch answer. Over stateless RPC a deepen exchange is several
 * requests, and the client reads each answer in a fixed order (fetch-pack's
 * find_common): after a wants block it reads a shallow list closed by a
 * flush; after every have block another shallow list, then ACK/NAK lines;
 * after 'done' a final shallow list, one ACK/NAK, then the sideband pack.
 * Bytes left unread poison the next read, so each phase gets exactly its
 * own shape. A plain (non-deepen) fetch negotiates in a single request and
 * expects the ACK/NAK first, then the pack.
 */
function fetchResponseV0(plan: FetchPlan, request: FetchRequest): Buffer {
  const shallowLines = [...plan.shallowLines, ...plan.unshallowLines];
  const shallowBlock = (): Buffer[] =>
    shallowLines.length === 0 ? [] : [...shallowLines.map((line) => pktLine(line)), pktFlush()];
  const ackLine = plan.common !== null ? `ACK ${plan.common}\n` : 'NAK\n';
  const deepen = request.depth !== undefined;

  if (!request.done) {
    if (deepen && request.haves.length === 0) {
      // The wants-only request of a deepen exchange: the shallow list alone.
      return Buffer.concat(shallowBlock());
    }
    if (request.haves.length > 0) {
      // A negotiation round: no pack yet. The answer is the shallow list
      // (deepen exchanges only), an ACK-common per common have, an ACK-ready
      // when every have was common (this server can always build the pack
      // from a common base), and a closing NAK — the client's ACK loop reads
      // until a NAK or a plain ACK, so the block must end with one.
      const parts = deepen ? shallowBlock() : [];
      for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have} common\n`));
      const everyHaveCommon = plan.commonHaves.length === request.haves.filter((oid) => isOid(oid)).length;
      if (plan.commonHaves.length > 0 && everyHaveCommon) {
        parts.push(pktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]} ready\n`));
      }
      parts.push(pktLine('NAK\n'));
      return Buffer.concat(parts);
    }
  }

  const parts: Buffer[] = [];
  if (deepen) parts.push(...shallowBlock());
  parts.push(pktLine(ackLine));
  if (plan.objects.length > 0) {
    parts.push(...sidebandWrap(buildPack(plan.objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, deepenRelative: false, done: false };
  for (const arg of args) {
    // The v0 request rides its capabilities on the first want line, after a
    // NUL (or space) separator — the oid is only the first token, and a
    // 'deepen-relative' capability token may hide in the remainder.
    if (arg.startsWith('want ')) {
      const tokens = arg.slice(5).split(/[\s\0]+/).filter((token) => token.length > 0);
      request.wants.push(tokens[0]!);
      if (tokens.includes('deepen-relative')) request.deepenRelative = true;
    }
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).split(/[\s\0]/)[0]!);
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg === 'deepen-relative') request.deepenRelative = true;
    else if (arg === 'done') request.done = true;
  }
  return request;
}

/** POST git-upload-pack: a v2 command request, or a v0 want/have exchange. */
export function handleUploadPack(forge: Forge, repo: RepoRec | undefined, body: Buffer, wantsV2: boolean): GitResponse {
  if (repo === undefined) return jsonError(404, 'Not Found');
  const resultType = 'application/x-git-upload-pack-result';
  if (wantsV2) {
    let decoded: ReturnType<typeof decodeV2Request>;
    try {
      decoded = decodeV2Request(body);
    } catch {
      return jsonError(400, 'malformed pkt-line stream');
    }
    const command = decoded.headers.get('command');
    if (command === 'ls-refs') {
      return { status: 200, contentType: resultType, body: pktLines(lsRefsLines(forge, repo, decoded.args)) };
    }
    if (command === 'fetch') {
      const request = parseFetchArgs(decoded.args);
      const plan = planFetch(forge, repo, request);
      return { status: 200, contentType: resultType, body: fetchResponseV2(plan, request) };
    }
    return jsonError(400, `unknown command ${command ?? ''}`);
  }
  // Protocol v0: want lines (capabilities ride the first), a flush, have
  // lines, 'done', a flush. Parse leniently: collect everything.
  let packets: string[];
  try {
    const first = decodePktStream(body);
    packets = first.packets.filter((packet): packet is string => packet !== PKT_FLUSH && packet !== PKT_DELIM);
    let rest = body.subarray(first.consumed);
    while (rest.length > 0) {
      const next = decodePktStream(rest);
      packets.push(...next.packets.filter((packet): packet is string => packet !== PKT_FLUSH && packet !== PKT_DELIM));
      rest = rest.subarray(next.consumed);
      if (next.consumed === 0) break;
    }
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const args: string[] = [];
  for (const packet of packets) {
    const line = packet.replace(/\n$/, '');
    const space = line.indexOf(' ');
    const head = space === -1 ? line : line.slice(0, space);
    if (head === 'want' || head === 'have' || head === 'shallow' || head === 'deepen' || head === 'done') args.push(line);
  }
  const request = parseFetchArgs(args);
  const plan = planFetch(forge, repo, request);
  return { status: 200, contentType: resultType, body: fetchResponseV0(plan, request) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * POST git-receive-pack: apply a push. The pack (when the body carries one)
 * is unpacked first; each ref then updates independently — creates, deletes
 * and fast-forwards apply, a non-fast-forward is refused by name — and the
 * report goes back in sideband band 1 when the client asked for it, as the
 * advertisement offered.
 */
export function handleReceivePack(forge: Forge, repo: RepoRec | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return jsonError(404, 'Not Found');
  const resultType = 'application/x-git-receive-pack-result';
  let packets: (string | typeof PKT_FLUSH | typeof PKT_DELIM)[];
  let consumed: number;
  try {
    const decoded = decodePktStream(body);
    packets = decoded.packets;
    consumed = decoded.consumed;
  } catch {
    return jsonError(400, 'malformed pkt-line stream');
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  for (const packet of packets) {
    if (packet === PKT_FLUSH || packet === PKT_DELIM) continue;
    let line = packet.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      const caps = line.slice(nul + 1).split(' ');
      if (caps.includes('side-band-64k')) sideband = true;
      if (caps.includes('report-status')) reportStatus = true;
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
  }
  const packBytes = body.subarray(consumed);
  const lookup = forge.lookup(repo);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, lookup);
      for (const [oid, object] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    results.push(applyPushCommand(forge, repo, command, unpackError));
  }

  if (!reportStatus) {
    return { status: 200, contentType: resultType, body: Buffer.alloc(0) };
  }
  const reportLines: string[] = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack error ${unpackError}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const reportStream = pktLines(reportLines);
  if (sideband) {
    return { status: 200, contentType: resultType, body: Buffer.concat([...sidebandWrap(reportStream), pktFlush()]) };
  }
  return { status: 200, contentType: resultType, body: reportStream };
}

/** Apply one push command to the repo's refs; answers its report line. */
function applyPushCommand(
  forge: Forge,
  repo: RepoRec,
  command: PushCommand,
  unpackError: string | null,
): { ref: string; ok: boolean; reason: string } {
  const fail = (reason: string): { ref: string; ok: boolean; reason: string } => ({ ref: command.ref, ok: false, reason });
  if (unpackError !== null) return fail('unpack failed');
  const lookup = forge.lookup(repo);
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current !== command.oldOid) return fail('stale ref');
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true, reason: '' };
  }
  const target = lookup(command.newOid);
  if (target === undefined) return fail('invalid object');
  if (command.oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return fail('reference already exists');
  } else if (current !== command.oldOid) {
    return fail('stale ref');
  }
  if (command.ref.startsWith('refs/heads/')) {
    const newCommit = commitOf(lookup, command.newOid);
    if (newCommit === null) return fail('invalid object');
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = commitOf(lookup, command.oldOid);
      if (oldCommit === null || !isAncestor(lookup, oldCommit, newCommit)) return fail('non-fast-forward');
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true, reason: '' };
}
