// The git object model, implemented from scratch on node:crypto.
//
// Objects are content-addressed: the id of an object is the SHA-1 of
// "<type> <byte length>\0" followed by the raw bytes, exactly as git defines
// it. This module knows how to hash, parse and build the four object types
// (blob, tree, commit, tag), walk history, compute the closure of a set of
// tips, diff two trees path by path, find a merge base, and run the three-way
// tree merge a squash merge needs. It holds no state of its own: every
// function takes the object lookup it should read through, so the same code
// serves the REST contents API, the merge machinery and the smart-HTTP
// protocol handlers.

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Read an object by id, or undefined when the store does not hold it. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
const OID_PATTERN = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

/** The id an object hashes to: SHA-1 over the git header and the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** The mode exactly as written in the tree object ('40000' for a directory). */
  mode: string;
  name: string;
  oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Parse a tree object's raw bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('utf8', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree ordering key: a directory compares as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isTreeMode(entry.mode) ? `${entry.name}/` : entry.name;
}

/** Build a tree object's raw bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: headers up to the blank line, then the message verbatim. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The name, email and timestamp of an "author Name <email> 1234567890 +0000" line. */
export function parseIdentity(line: string): { name: string; email: string; dateSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (match === null) return { name: line, email: '', dateSec: 0 };
  return { name: match[1], email: match[2], dateSec: Number(match[3]) };
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const headerText = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow tag objects until a non-tag object; returns that object's id (or the input). */
export function peelToNonTag(lookup: ObjectLookup, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The commit a ref tip names, peeling annotated tags; null when it is not a commit. */
export function commitOf(lookup: ObjectLookup, oid: string): string | null {
  const peeled = peelToNonTag(lookup, oid);
  const object = lookup(peeled);
  return object !== undefined && object.type === 'commit' ? peeled : null;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from a tree: the tree itself, subtrees and blobs. */
export function addTreeClosure(lookup: ObjectLookup, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const tree = lookup(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(tree.data)) {
    if (isTreeMode(entry.mode)) addTreeClosure(lookup, entry.oid, into);
    else into.add(entry.oid);
  }
}

/**
 * The full object closure of a set of tips: commits with all their ancestors,
 * their trees and blobs, and tag objects with the objects they name. Tips that
 * name trees or blobs directly contribute just themselves (and their closure).
 */
export function closureOf(lookup: ObjectLookup, tips: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addTreeClosure(lookup, commit.tree, out);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      addTreeClosure(lookup, oid, out);
    }
  }
  return out;
}

/** Every commit reachable from a tip (the tip peeled to a commit first), tip first. */
export function commitAncestors(lookup: ObjectLookup, tip: string): string[] {
  const start = commitOf(lookup, tip);
  if (start === null) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  return order;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  return false;
}

/**
 * A best common ancestor of two commits: the first commit, walking from `b`
 * breadth-first, that is also an ancestor of `a`. Null when they share none.
 */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOfA = new Set(commitAncestors(lookup, a));
  if (ancestorsOfA.has(b)) return b;
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------- tree paths and diffs

/** Flatten a tree into a map from slash-joined path to its blob entry. */
export function flattenTree(lookup: ObjectLookup, treeOid: string, prefix = '', into = new Map<string, TreeEntry>()): Map<string, TreeEntry> {
  const tree = lookup(treeOid);
  if (tree === undefined || tree.type !== 'tree') return into;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isTreeMode(entry.mode)) flattenTree(lookup, entry.oid, path, into);
    else into.set(path, entry);
  }
  return into;
}

/** The blob entry at a slash-joined path inside a tree, or null. */
export function treePathEntry(lookup: ObjectLookup, treeOid: string, path: string): TreeEntry | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = lookup(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (!isTreeMode(entry.mode)) return null;
    current = entry.oid;
  }
  return null;
}

/**
 * A writer for trees: holds the object sink new subtrees go to, and rebuilds
 * the path from the root down to a changed leaf, git-style.
 */
export class TreeBuilder {
  private readonly put: (type: GitObjectType, data: Buffer) => string;
  private readonly lookup: ObjectLookup;

  constructor(put: (type: GitObjectType, data: Buffer) => string, lookup: ObjectLookup) {
    this.put = put;
    this.lookup = lookup;
  }

  /** The root tree with `path` set to the blob `oid` (mode 100644), creating directories. */
  setPath(rootTreeOid: string | null, path: string, oid: string): string {
    const segments = path.split('/');
    return this.setSegments(rootTreeOid, segments, oid);
  }

  /** The root tree with `path` removed; returns the root unchanged when absent. */
  removePath(rootTreeOid: string, path: string): string {
    const segments = path.split('/');
    return this.removeSegments(rootTreeOid, segments) ?? rootTreeOid;
  }

  private entriesOf(treeOid: string | null): TreeEntry[] {
    if (treeOid === null) return [];
    const tree = this.lookup(treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data);
  }

  private setSegments(treeOid: string | null, segments: string[], blobOid: string): string {
    const head = segments[0]!;
    const entries = this.entriesOf(treeOid).filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = this.entriesOf(treeOid).find((entry) => entry.name === head && isTreeMode(entry.mode));
      const child = this.setSegments(existing === undefined ? null : existing.oid, segments.slice(1), blobOid);
      entries.push({ mode: '40000', name: head, oid: child });
    }
    return this.put('tree', buildTree(entries));
  }

  private removeSegments(treeOid: string, segments: string[]): string | null {
    const head = segments[0]!;
    const current = this.entriesOf(treeOid);
    const existing = current.find((entry) => entry.name === head);
    if (existing === undefined) return null;
    let entries: TreeEntry[];
    if (segments.length === 1) {
      entries = current.filter((entry) => entry.name !== head);
    } else {
      if (!isTreeMode(existing.mode)) return null;
      const child = this.removeSegments(existing.oid, segments.slice(1));
      if (child === null) return null;
      const childEntries = this.entriesOf(child);
      entries = current.filter((entry) => entry.name !== head);
      if (childEntries.length > 0) entries.push({ mode: '40000', name: head, oid: child });
    }
    return this.put('tree', buildTree(entries));
  }
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** The per-path differences between two trees (either may be null = empty). */
export function diffTrees(lookup: ObjectLookup, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree === null ? new Map<string, TreeEntry>() : flattenTree(lookup, fromTree);
  const to = toTree === null ? new Map<string, TreeEntry>() : flattenTree(lookup, toTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of to) {
    const before = from.get(path);
    if (before === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (before.oid !== entry.oid || before.mode !== entry.mode) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: entry.oid });
    }
  }
  for (const [path, entry] of from) {
    if (!to.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Count the lines of a text buffer the way a diff does: a trailing newline ends the last line. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** Added and deleted line counts between two blob versions, by longest common subsequence. */
export function lineDiffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : splitLines(oldData);
  const newLines = newData === null ? [] : splitLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // Trim the common prefix and suffix first: most edits are local, and the LCS
  // table then stays small. Fall back to whole-count when the middle is huge.
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const oldMid = oldLines.slice(start, oldEnd);
  const newMid = newLines.slice(start, newEnd);
  if (oldMid.length === 0) return { additions: newMid.length, deletions: 0 };
  if (newMid.length === 0) return { additions: 0, deletions: oldMid.length };
  if (oldMid.length * newMid.length > 4_000_000) {
    return { additions: newMid.length, deletions: oldMid.length };
  }
  const lcs = lcsLength(oldMid, newMid);
  return { additions: newMid.length - lcs, deletions: oldMid.length - lcs };
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  const width = b.length + 1;
  let previous = new Uint32Array(width);
  let current = new Uint32Array(width);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[b.length];
}

export interface MergeOutcome {
  /** The merged root tree's id, or null when the merge conflicts. */
  tree: string | null;
  /** The paths that conflicted (empty when the merge is clean). */
  conflicts: string[];
}

/**
 * A three-way merge of two trees against their common ancestor's tree, per
 * path: a path changed on only one side takes that side; changed identically
 * on both takes either; changed differently on both (or deleted against
 * changed) conflicts. `put` stores any tree that has to be rebuilt.
 */
export function mergeTrees(
  lookup: ObjectLookup,
  put: (type: GitObjectType, data: Buffer) => string,
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): MergeOutcome {
  const base = baseTree === null ? new Map<string, TreeEntry>() : flattenTree(lookup, baseTree);
  const ours = oursTree === null ? new Map<string, TreeEntry>() : flattenTree(lookup, oursTree);
  const theirs = theirsTree === null ? new Map<string, TreeEntry>() : flattenTree(lookup, theirsTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const conflicts: string[] = [];
  const builder = new TreeBuilder(put, lookup);
  let result = oursTree;
  const merged = new Map<string, TreeEntry | null>();
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    if (o === t) merged.set(path, ours.get(path) ?? theirs.get(path) ?? null);
    else if (b === o) merged.set(path, theirs.get(path) ?? null);
    else if (b === t) merged.set(path, ours.get(path) ?? null);
    else conflicts.push(path);
  }
  if (conflicts.length > 0) return { tree: null, conflicts };
  // Start from ours and apply the paths where theirs won.
  for (const [path, entry] of merged) {
    const o = ours.get(path)?.oid ?? null;
    const want = entry?.oid ?? null;
    if (want === o) continue;
    if (want === null) result = result === null ? null : builder.removePath(result, path);
    else result = builder.setPath(result, path, want);
  }
  if (result === null) result = put('tree', buildTree([]));
  return { tree: result, conflicts: [] };
}
