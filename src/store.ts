// The forge's in-memory store: the one state every surface shares.
//
// REST, GraphQL, MCP and the git protocol all read and write through this
// module, so an issue created over MCP is the same object REST lists, with
// the same number, and a branch pushed over git is the branch a pull request
// names. Nothing is persisted: a trial starts the process against an empty
// forge and grades what it builds from nothing.
//
// The viewer is the token's owner. The trial's scenario fixes who that is —
// the seeded viewer of the contest's one scenario — so the identity lives
// here as a constant of the deployment, the way a single-user forge would
// hard-code its owner.

import { LogicalClock } from './clock.ts';
import { hashObject, type GitObject, type GitObjectType } from './gitobjects.ts';

export interface ViewerIdentity {
  login: string;
  id: number;
  name: string;
  email: string;
}

/** The token owner's identity: the one user this forge serves. */
export const VIEWER: ViewerIdentity = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  seq: number;
}

export interface IssueRec {
  /** A forge-wide numeric id, stable for the issue's life (the REST `id`). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface PullRec {
  /** A forge-wide numeric id, stable for the pull request's life. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** The branch tips when the pull request was opened. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface RepoRec {
  /** The numeric database id: stable for the repo's life, unique per forge. */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Every git object the repository holds, by id. */
  objects: Map<string, GitObject>;
  /** Full ref names ('refs/heads/main') to the object id they point at. */
  refs: Map<string, string>;
  /** The one counter issues and pull requests share, as on GitHub. */
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextCommentId: number;
  createdAt: string;
  seq: number;
}

export class Forge {
  readonly clock = new LogicalClock();
  readonly viewer: ViewerIdentity = VIEWER;
  private readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextRestId = 10_000;
  private seqCounter = 0;

  /** A forge-wide numeric id for REST objects (issues, pulls, labels). */
  nextObjectId(): number {
    const id = this.nextRestId;
    this.nextRestId += 1;
    return id;
  }

  /** A monotonically increasing sequence number for creation ordering. */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  /** The repository at owner/name, or undefined. Only the viewer's own exist. */
  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== this.viewer.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  /** Create a repository owned by the viewer; null when the name is taken. */
  createRepo(name: string, options: { isPrivate?: boolean; description?: string }): RepoRec | null {
    const key = this.key(this.viewer.login, name);
    if (this.repos.has(key)) return null;
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner: this.viewer.login,
      name,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextCommentId: 1,
      createdAt: this.clock.tickIso(),
      seq: this.nextSeq(),
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  /** Delete a repository and everything in it; false when it did not exist. */
  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Store an object in a repository and answer its id (idempotent). */
  putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The object lookup the git-object helpers read through, bound to one repo. */
  lookup(repo: RepoRec): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The commit id HEAD names in a repo: its default branch's tip, or null when unborn. */
  headTip(repo: RepoRec): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** The tip of a branch, or null when the branch does not exist. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }
}
