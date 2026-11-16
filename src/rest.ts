// The REST v3 surface: /api/v3 routes for the viewer, repositories, branches,
// commits, contents, labels, issues, comments and pull requests.
//
// Every handler answers a {status, body, headers} triple; the server module
// serializes it as JSON with the forge's request-id header. Errors are
// ApiErrors from the operations module or plain {message} bodies, the shape
// GitHub's API uses and the suite's protocol checks require. A repository
// under any owner but the viewer's does not exist here (404, never 403):
// the store only holds the viewer's repositories, which is exactly that rule.

import { isoOf } from './clock.ts';
import {
  commitAncestors,
  isOid,
  parseCommit,
  parseIdentity,
  parseTree,
  isTreeMode,
  treePathEntry,
} from './gitobjects.ts';
import { ApiError, createIssue, createPull, createRef, deleteContents, mergePull, pullFiles, writeContents } from './operations.ts';
import type { CommentRec, Forge, IssueRec, LabelRec, PullRec, RepoRec } from './store.ts';

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function notFound(message = 'Not Found'): RestResponse {
  return { status: 404, body: { message } };
}

function invalid(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

// ---------------------------------------------------------------- shapes

export function userJson(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    type: 'User',
    name: viewer.name,
    email: viewer.email,
    site_admin: false,
  };
}

export function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { id: 0, name, color: 'ededed', description: '' })),
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(forge: Forge, repo: RepoRec, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- helpers

function repoOr404(forge: Forge, owner: string, name: string): RepoRec {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) throw new ApiError(404, 'Not Found');
  return repo;
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Resolve a ref parameter (branch name or commit id) to a commit id. */
function resolveCommit(forge: Forge, repo: RepoRec, ref: string): string | null {
  const branch = forge.branchTip(repo, ref);
  if (branch !== null) return branch;
  if (isOid(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  const tagged = repo.refs.get(`refs/tags/${ref}`);
  if (tagged !== undefined) return tagged;
  return null;
}

// ---------------------------------------------------------------- the router

export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  origin: string,
): RestResponse {
  try {
    return route(forge, method, segments, query, body, origin);
  } catch (err) {
    if (err instanceof ApiError) return invalid(err.status, err.message);
    throw err;
  }
}

function route(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  origin: string,
): RestResponse {
  const [head, ...rest] = segments;

  if (head === undefined) {
    if (method !== 'GET') return notFound();
    return ok(
      200,
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org, user' },
    );
  }

  if (head === 'meta' && rest.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (head === 'user') {
    if (rest.length === 0) {
      if (method !== 'GET') return notFound();
      return ok(200, userJson(forge));
    }
    if (rest[0] === 'repos' && rest.length === 1) {
      if (method === 'GET') return listUserRepos(forge, query, origin);
      if (method === 'POST') return createRepo(forge, body);
    }
    return notFound();
  }

  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0]!;
    const name = rest[1]!;
    const tail = rest.slice(2);
    if (tail.length === 0) {
      if (method === 'GET') return ok(200, repoJson(forge, repoOr404(forge, owner, name)));
      if (method === 'PATCH') return patchRepo(forge, owner, name, body);
      if (method === 'DELETE') {
        if (!forge.deleteRepo(owner, name)) return notFound();
        return ok(204, null);
      }
      return notFound();
    }
    const repo = repoOr404(forge, owner, name);
    return routeRepoTail(forge, method, repo, tail, query, body);
  }

  return notFound();
}

// ---------------------------------------------------------------- viewer repos

function listUserRepos(forge: Forge, query: URLSearchParams, origin: string): RestResponse {
  const { page, perPage } = parsePage(query);
  const all = forge.listRepos();
  const items = paginate(all, page, perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const next = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return ok(200, items.map((repo) => repoJson(forge, repo)), headers);
}

function createRepo(forge: Forge, body: Record<string, unknown> | null): RestResponse {
  const name = typeof body?.name === 'string' ? body.name : '';
  if (name === '') return invalid(422, 'Repository creation failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return invalid(422, `Repository creation failed: name "${name}" is invalid`);
  const repo = forge.createRepo(name, {
    isPrivate: body?.private === true,
    description: typeof body?.description === 'string' ? body.description : '',
  });
  if (repo === null) {
    return {
      status: 422,
      body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] },
    };
  }
  if (typeof body?.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  return ok(201, repoJson(forge, repo));
}

function patchRepo(forge: Forge, owner: string, name: string, body: Record<string, unknown> | null): RestResponse {
  const repo = repoOr404(forge, owner, name);
  if (body !== null) {
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      const renamed = forge.createRepo(body.name, {});
      if (renamed === null) return invalid(422, 'Repository creation failed: name already exists');
      forge.deleteRepo(repo.owner, repo.name);
      renamed.id = repo.id;
      renamed.isPrivate = repo.isPrivate;
      renamed.description = repo.description;
      renamed.defaultBranch = repo.defaultBranch;
      renamed.objects = repo.objects;
      renamed.refs = repo.refs;
      renamed.nextNumber = repo.nextNumber;
      renamed.issues = repo.issues;
      renamed.pulls = repo.pulls;
      renamed.labels = repo.labels;
      renamed.nextCommentId = repo.nextCommentId;
      return ok(200, repoJson(forge, renamed));
    }
  }
  return ok(200, repoJson(forge, repo));
}

// ---------------------------------------------------------------- repo tails

function routeRepoTail(
  forge: Forge,
  method: string,
  repo: RepoRec,
  tail: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResponse {
  const [head, ...rest] = tail;

  if (head === 'branches') {
    if (rest.length === 0) {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return ok(200, branches);
    }
    if (method !== 'GET') return notFound();
    const branch = rest.join('/');
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return notFound();
    return ok(200, { name: branch, commit: { sha: tip }, protected: false });
  }

  if (head === 'commits' && rest.length === 0) {
    if (method !== 'GET') return notFound();
    return listCommits(forge, repo, query);
  }

  if (head === 'git' && rest[0] === 'refs') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const ref = typeof body?.ref === 'string' ? body.ref : '';
        const sha = typeof body?.sha === 'string' ? body.sha : '';
        if (ref === '' || sha === '') return invalid(422, 'ref and sha are required');
        createRef(forge, repo, ref, sha);
        return ok(201, { ref, object: { sha, type: 'commit' } });
      }
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return ok(200, refs);
      }
      return notFound();
    }
    if (method !== 'GET') return notFound();
    const ref = `refs/${rest.slice(1).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) return notFound();
    return ok(200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }

  if (head === 'contents') {
    return routeContents(forge, method, repo, rest.join('/'), query, body);
  }

  if (head === 'labels') {
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') return invalid(422, 'name is required');
        if (repo.labels.has(name)) return invalid(422, `label "${name}" already exists`);
        const label: LabelRec = {
          id: forge.nextObjectId(),
          name,
          color: typeof body?.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body?.description === 'string' ? body.description : '',
        };
        repo.labels.set(name, label);
        return ok(201, labelJson(label));
      }
    }
    return notFound();
  }

  if (head === 'issues') {
    return routeIssues(forge, method, repo, rest, query, body);
  }

  if (head === 'pulls') {
    return routePulls(forge, method, repo, rest, query, body);
  }

  return notFound();
}

// ---------------------------------------------------------------- commits

function listCommits(forge: Forge, repo: RepoRec, query: URLSearchParams): RestResponse {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveCommit(forge, repo, ref) ?? forge.headTip(repo);
  if (tip === null) return ok(200, []);
  const { page, perPage } = parsePage(query);
  const lookup = forge.lookup(repo);
  const all = commitAncestors(lookup, tip).map((oid) => {
    const commit = parseCommit(repo.objects.get(oid)!.data);
    const author = parseIdentity(commit.author);
    const committer = parseIdentity(commit.committer);
    return {
      sha: oid,
      commit: {
        message: commit.message,
        author: { name: author.name, email: author.email, date: isoOf(author.dateSec) },
        committer: { name: committer.name, email: committer.email, date: isoOf(committer.dateSec) },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  return ok(200, paginate(all, page, perPage));
}

// ---------------------------------------------------------------- contents

function routeContents(
  forge: Forge,
  method: string,
  repo: RepoRec,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResponse {
  if (method === 'GET') return getContents(forge, repo, path, query.get('ref') ?? undefined);
  if (method === 'PUT') {
    const message = typeof body?.message === 'string' ? body.message : '';
    const content = typeof body?.content === 'string' ? body.content : '';
    if (message === '' || typeof body?.content !== 'string') return invalid(422, 'message and content are required');
    const bytes = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const result = writeContents(forge, repo, {
      path,
      content: bytes,
      message,
      branch: typeof body?.branch === 'string' ? body.branch : undefined,
      sha: typeof body?.sha === 'string' ? body.sha : undefined,
    });
    return ok(result.status, {
      content: { name: path.split('/').pop() ?? '', path, sha: result.blobSha, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const message = typeof body?.message === 'string' ? body.message : '';
    if (message === '') return invalid(422, 'message is required');
    const result = deleteContents(forge, repo, {
      path,
      message,
      branch: typeof body?.branch === 'string' ? body.branch : undefined,
      sha: typeof body?.sha === 'string' ? body.sha : undefined,
    });
    return ok(200, { content: null, commit: { sha: result.commitSha, message } });
  }
  return notFound();
}

function getContents(forge: Forge, repo: RepoRec, path: string, ref: string | undefined): RestResponse {
  const commitOid = resolveCommit(forge, repo, ref ?? repo.defaultBranch);
  if (commitOid === null) {
    if (path === '') return ok(200, []);
    return notFound();
  }
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return notFound();
  const tree = parseCommit(commit.data).tree;
  const lookup = forge.lookup(repo);
  if (path === '') return ok(200, dirListing(forge, repo, tree, ''));
  const entry = treePathEntry(lookup, tree, path);
  if (entry === null) return notFound();
  if (isTreeMode(entry.mode)) return ok(200, dirListing(forge, repo, entry.oid, path));
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined) return notFound();
  return ok(200, {
    type: 'file',
    name: path.split('/').pop() ?? '',
    path,
    sha: entry.oid,
    size: blob.data.length,
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

function dirListing(forge: Forge, repo: RepoRec, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = isTreeMode(entry.mode);
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: blob?.data.length ?? 0,
    };
  });
}

// ---------------------------------------------------------------- issues

function routeIssues(
  forge: Forge,
  method: string,
  repo: RepoRec,
  rest: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResponse {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page, perPage } = parsePage(query);
      return ok(200, paginate(issues, page, perPage).map((issue) => issueJson(forge, repo, issue)));
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      if (title === '') return invalid(422, 'title is required');
      const labels = Array.isArray(body?.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
      const issue = createIssue(forge, repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        labels,
      });
      return ok(201, issueJson(forge, repo, issue));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return ok(200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      if (body !== null) {
        if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((label): label is string => typeof label === 'string');
          for (const name of names) if (!repo.labels.has(name)) throw new ApiError(422, `Label "${name}" does not exist`);
          issue.labels = names;
        }
        issue.updatedAt = forge.clock.tickIso();
      }
      return ok(200, issueJson(forge, repo, issue));
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentJson(forge, repo, issue, comment)));
    }
    if (method === 'POST') {
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') return invalid(422, 'body is required');
      const comment: CommentRec = { id: repo.nextCommentId, body: text, createdAt: forge.clock.tickIso(), seq: forge.nextSeq() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return ok(201, commentJson(forge, repo, issue, comment));
    }
  }
  return notFound();
}

// ---------------------------------------------------------------- pulls

function routePulls(
  forge: Forge,
  method: string,
  repo: RepoRec,
  rest: readonly string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResponse {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      const { page, perPage } = parsePage(query);
      return ok(200, paginate(pulls, page, perPage).map((pull) => pullJson(forge, repo, pull)));
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : '';
      const head = typeof body?.head === 'string' ? body.head : '';
      const base = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
      if (title === '' || head === '') return invalid(422, 'title and head are required');
      const pull = createPull(forge, repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        head: head.includes(':') ? head.split(':').pop()! : head,
        base,
      });
      return ok(201, pullJson(forge, repo, pull));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
    return notFound();
  }
  if (pull === undefined) return notFound();

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const files = pullFiles(forge, repo, pull).map((file) => ({
      filename: file.path,
      status: file.status === 'removed' ? 'removed' : file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      sha: file.newOid ?? file.oldOid ?? '',
    }));
    return ok(200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    const methodName = typeof body?.merge_method === 'string' ? body.merge_method : 'merge';
    const result = mergePull(forge, repo, pull, methodName);
    return ok(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}
