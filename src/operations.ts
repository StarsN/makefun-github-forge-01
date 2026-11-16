// The forge's domain operations: the writes and computed reads every surface
// shares, so REST, GraphQL and MCP can never disagree about what a contents
// write commits, when a label is missing, or whether a pull request merges.
//
// Each operation answers either its result or an ApiError carrying the HTTP
// status the REST surface would use; GraphQL turns those into GraphQL errors
// and MCP into isError results, keeping the rules in exactly one place.

import { gitStampOf } from './clock.ts';
import {
  TreeBuilder,
  buildCommit,
  commitOf,
  diffTrees,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  mergeTrees,
  parseCommit,
  treePathEntry,
  type FileChange,
} from './gitobjects.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The identity server-created commits are authored and committed under. */
function forgeIdentity(forge: Forge): string {
  const sec = forge.clock.tick();
  return `${forge.viewer.name} <${forge.viewer.email}> ${gitStampOf(sec)}`;
}

/** Create one commit on a branch with the given tree, and move the branch. */
function commitOnBranch(forge: Forge, repo: RepoRec, branch: string, tree: string, parents: string[], message: string): string {
  const identity = forgeIdentity(forge);
  const data = buildCommit({ tree, parents, author: identity, committer: identity, message });
  const oid = forge.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

/** The tree a branch tip holds, or null when the branch is unborn. */
export function branchTree(forge: Forge, repo: RepoRec, branch: string): string | null {
  const tip = forge.branchTip(repo, branch);
  if (tip === null) return null;
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

// ---------------------------------------------------------------- contents

export interface ContentsWrite {
  status: 200 | 201;
  commitSha: string;
  blobSha: string;
}

/**
 * PUT /contents: write `content` at `path` on `branch` (the default branch
 * when unnamed) as a new commit. A branch that does not exist yet is created
 * from the default branch's tip — or, in an unborn repository, from nothing.
 * Updating an existing file answers 200, creating one 201, and a `sha` that
 * is not the file's current blob id is a 409.
 */
export function writeContents(
  forge: Forge,
  repo: RepoRec,
  options: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentsWrite {
  const branch = options.branch ?? repo.defaultBranch;
  let tip = forge.branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write is one of the two ways a branch comes into being:
    // it forks from the default branch's tip.
    tip = forge.headTip(repo);
  }
  const lookup = forge.lookup(repo);
  const currentTree = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = currentTree === null ? null : treePathEntry(lookup, currentTree, options.path);
  if (existing !== null && !isFileEntry(existing.mode)) {
    throw new ApiError(422, `cannot write a file over the directory at ${options.path}`);
  }
  if (existing !== null && options.sha !== undefined && options.sha !== existing.oid) {
    throw new ApiError(409, `${options.path} has changed since ${options.sha}; refusing to overwrite`);
  }
  const blobSha = forge.putObject(repo, 'blob', options.content);
  const builder = new TreeBuilder((type, data) => forge.putObject(repo, type, data), lookup);
  const newTree = builder.setPath(currentTree, options.path, blobSha);
  const commitSha = commitOnBranch(forge, repo, branch, newTree, tip === null ? [] : [tip], options.message);
  return { status: existing !== null ? 200 : 201, commitSha, blobSha };
}

function isFileEntry(mode: string): boolean {
  return mode !== '40000' && mode !== '040000';
}

/** DELETE /contents: remove `path` on `branch` as a new commit; answers the commit id. */
export function deleteContents(
  forge: Forge,
  repo: RepoRec,
  options: { path: string; message: string; branch?: string; sha?: string },
): { commitSha: string } {
  const branch = options.branch ?? repo.defaultBranch;
  const tip = forge.branchTip(repo, branch);
  if (tip === null) throw new ApiError(404, `the branch ${branch} does not exist`);
  const lookup = forge.lookup(repo);
  const currentTree = parseCommit(repo.objects.get(tip)!.data).tree;
  const existing = treePathEntry(lookup, currentTree, options.path);
  if (existing === null) throw new ApiError(404, `no file at ${options.path} on ${branch}`);
  if (options.sha !== undefined && options.sha !== existing.oid) {
    throw new ApiError(409, `${options.path} has changed since ${options.sha}; refusing to delete`);
  }
  const builder = new TreeBuilder((type, data) => forge.putObject(repo, type, data), lookup);
  const newTree = builder.removePath(currentTree, options.path);
  const commitSha = commitOnBranch(forge, repo, branch, newTree, [tip], options.message);
  return { commitSha };
}

// ---------------------------------------------------------------- refs

/** POST /git/refs: create a ref at a commit. 422 when it exists or the target is no commit. */
export function createRef(forge: Forge, repo: RepoRec, ref: string, sha: string): void {
  if (!ref.startsWith('refs/')) throw new ApiError(422, `ref ${ref} is not a fully qualified ref`);
  if (repo.refs.has(ref)) throw new ApiError(422, `Reference already exists: ${ref}`);
  const target = commitOf(forge.lookup(repo), sha);
  if (target === null) throw new ApiError(422, `object ${sha} is not a commit`);
  repo.refs.set(ref, sha);
}

// ---------------------------------------------------------------- issues

/** Create an issue; a named label that does not exist is a 422, as on GitHub. */
export function createIssue(
  forge: Forge,
  repo: RepoRec,
  options: { title: string; body?: string; labels?: readonly string[] },
): IssueRec {
  const labels = options.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ApiError(422, `Label "${label}" does not exist in ${repo.owner}/${repo.name}`);
  }
  const now = forge.clock.tickIso();
  const issue: IssueRec = {
    id: forge.nextObjectId(),
    number: repo.nextNumber,
    title: options.title,
    body: options.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: now,
    updatedAt: now,
    seq: forge.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

// ---------------------------------------------------------------- pull requests

/** Open a pull request from `head` into `base`; both branches must exist and differ. */
export function createPull(
  forge: Forge,
  repo: RepoRec,
  options: { title: string; body?: string; head: string; base: string },
): PullRec {
  const headTip = forge.branchTip(repo, options.head);
  if (headTip === null) throw new ApiError(422, `the head branch ${options.head} does not exist`);
  const baseTip = forge.branchTip(repo, options.base);
  if (baseTip === null) throw new ApiError(422, `the base branch ${options.base} does not exist`);
  if (headTip === baseTip) throw new ApiError(422, `nothing to merge: ${options.head} and ${options.base} point at the same commit`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === options.head && pull.baseRef === options.base) {
      throw new ApiError(422, `a pull request from ${options.head} into ${options.base} is already open`);
    }
  }
  const now = forge.clock.tickIso();
  const pull: PullRec = {
    id: forge.nextObjectId(),
    number: repo.nextNumber,
    title: options.title,
    body: options.body ?? '',
    state: 'open',
    headRef: options.head,
    baseRef: options.base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    seq: forge.nextSeq(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The commits a pull request's diff is measured against: its merge base and head trees. */
export function pullDiffTrees(forge: Forge, repo: RepoRec, pull: PullRec): { baseTree: string | null; headTree: string | null } {
  const lookup = forge.lookup(repo);
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const headTree = branchTree(forge, repo, pull.headRef) ?? treeOfCommit(forge, repo, headTip);
  const base = mergeBase(lookup, baseTip, headTip);
  const baseTree = base === null ? null : treeOfCommit(forge, repo, base);
  return { baseTree, headTree };
}

function treeOfCommit(forge: Forge, repo: RepoRec, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The changed files of a pull request, with line counts, as the files views serve them. */
export function pullFiles(forge: Forge, repo: RepoRec, pull: PullRec): (FileChange & { additions: number; deletions: number })[] {
  const lookup = forge.lookup(repo);
  const { baseTree, headTree } = pullDiffTrees(forge, repo, pull);
  return diffTrees(lookup, baseTree, headTree).map((change) => {
    const oldData = change.oldOid === null ? null : (repo.objects.get(change.oldOid)?.data ?? null);
    const newData = change.newOid === null ? null : (repo.objects.get(change.newOid)?.data ?? null);
    const counts = lineDiffCounts(oldData, newData);
    return { ...change, additions: counts.additions, deletions: counts.deletions };
  });
}

/** Whether a pull request merges cleanly right now (its head into its base's current tip). */
export function pullMergeable(forge: Forge, repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const lookup = forge.lookup(repo);
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  if (isAncestor(lookup, headTip, baseTip)) return false;
  const base = mergeBase(lookup, baseTip, headTip);
  const outcome = mergeTrees(
    lookup,
    (type, data) => forge.putObject(repo, type, data),
    base === null ? null : treeOfCommit(forge, repo, base),
    treeOfCommit(forge, repo, baseTip),
    treeOfCommit(forge, repo, headTip),
  );
  return outcome.tree !== null;
}

export interface MergeResult {
  sha: string;
}

/**
 * Merge a pull request into its base branch. 'squash' lands one commit with
 * the merged tree on the base branch; 'merge' lands a two-parent commit with
 * the same tree. A conflicted pull is a 405, an unknown or settled one the
 * status GitHub gives (404 handled by the caller; a closed pull is 405).
 */
export function mergePull(forge: Forge, repo: RepoRec, pull: PullRec, method: string): MergeResult {
  if (pull.state !== 'open' || pull.merged) throw new ApiError(405, 'Pull Request is not mergeable: it is already closed');
  const lookup = forge.lookup(repo);
  const headTip = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(lookup, baseTip, headTip);
  const outcome = mergeTrees(
    lookup,
    (type, data) => forge.putObject(repo, type, data),
    base === null ? null : treeOfCommit(forge, repo, base),
    treeOfCommit(forge, repo, baseTip),
    treeOfCommit(forge, repo, headTip),
  );
  if (outcome.tree === null) {
    throw new ApiError(405, `Pull Request is not mergeable: ${outcome.conflicts.join(', ')} conflict with the base branch`);
  }
  const identity = forgeIdentity(forge);
  let sha: string;
  if (method === 'merge') {
    const data = buildCommit({
      tree: outcome.tree,
      parents: [baseTip, headTip],
      author: identity,
      committer: identity,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`,
    });
    sha = forge.putObject(repo, 'commit', data);
  } else {
    // squash (and rebase, which this forge answers with the same single
    // commit: the tree is identical, only the parentage differs on GitHub).
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    const data = buildCommit({
      tree: outcome.tree,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message: `${pull.title} (#${pull.number})${body}`,
    });
    sha = forge.putObject(repo, 'commit', data);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.clock.tickIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}
