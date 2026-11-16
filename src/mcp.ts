// The MCP surface: POST /mcp, JSON-RPC 2.0 over Streamable HTTP.
//
// The endpoint speaks the current revision (2026-07-28): server/discover
// answers the server's identity, capabilities and supported versions in one
// request, with no handshake and no session. The legacy initialize handshake
// is answered too, for clients that negotiate down. The tools are the
// github-mcp-server operations the suite drives — create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request, plus
// list_repos and get_issue — and every one acts on the same store as REST,
// returning the REST shape of the object it touched.

import { ApiError, createIssue, createPull, mergePull } from './operations.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, RepoRec } from './store.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpReply {
  status: number;
  /** The JSON body to send, or null for an empty answer (notifications). */
  body: unknown;
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full name, "owner/repo", instead of owner and repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch to merge from.' },
        base: { type: 'string', description: 'The base branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'The merge method: merge, squash or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// ---------------------------------------------------------------- tool calls

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Read a string argument, tolerating the full_name form for owner/repo tools. */
function repoArgs(forge: Forge, args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [namedOwner, namedRepo] = args.full_name.split('/', 2);
    if (owner === '') owner = namedOwner!;
    if (repo === '') repo = namedRepo!;
  }
  return { owner, repo };
}

function repoOrFail(forge: Forge, args: Record<string, unknown>): RepoRec {
  const { owner, repo } = repoArgs(forge, args);
  const found = forge.getRepo(owner, repo);
  if (found === undefined) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === undefined) throw new RpcError(-32601, `unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      // The full_name property can stand in for owner and repo together.
      if ((required === 'owner' || required === 'repo') && typeof args.full_name === 'string' && args.full_name.includes('/')) continue;
      throw new RpcError(-32602, `missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo(String(args.name), {
          isPrivate: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
        if (repo === null) return toolFailure(`repository ${String(args.name)} already exists`);
        return toolResult(repoJson(forge, repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(forge, repoOrFail(forge, args)));
      }
      case 'list_repos': {
        return toolResult(forge.listRepos().map((repo) => repoJson(forge, repo)));
      }
      case 'create_issue': {
        const repo = repoOrFail(forge, args);
        const issue = createIssue(forge, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolResult(issueJson(forge, repo, issue));
      }
      case 'list_issues': {
        const repo = repoOrFail(forge, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => b.seq - a.seq);
        return toolResult({ issues: issues.map((issue) => issueJson(forge, repo, issue)) });
      }
      case 'get_issue': {
        const repo = repoOrFail(forge, args);
        const issue = repo.issues.get(Number(args.issue_number));
        if (issue === undefined) return toolFailure(`issue ${String(args.issue_number)} not found`);
        return toolResult(issueJson(forge, repo, issue));
      }
      case 'create_pull_request': {
        const repo = repoOrFail(forge, args);
        const pull = createPull(forge, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolResult(pullJson(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoOrFail(forge, args);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (pull === undefined) return toolFailure(`pull request ${String(args.pull_number)} not found`);
        const method = typeof args.merge_method === 'string' ? args.merge_method : 'squash';
        mergePull(forge, repo, pull, method);
        return toolResult(pullJson(forge, repo, pull));
      }
      default:
        throw new RpcError(-32601, `unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof RpcError) throw err;
    if (err instanceof ApiError) return toolFailure(err.message);
    if (err instanceof Error) return toolFailure(err.message);
    return toolFailure(String(err));
  }
}

// ---------------------------------------------------------------- the endpoint

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Answer one JSON-RPC request object; null when it is a notification (no answer owed). */
function handleOne(forge: Forge, request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  if (id === undefined) return null; // a notification: accepted, never answered
  try {
    switch (method) {
      case 'server/discover':
        return rpcResult(id, {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible git forge. The tools mirror its REST surface over one shared store.',
        });
      case 'initialize': {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call': {
        const params = (request.params ?? {}) as Record<string, unknown>;
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        return rpcResult(id, callTool(forge, name, args));
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    return rpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

/** POST /mcp: a raw body in, a status and JSON body out. */
export function handleMcp(forge: Forge, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: the body is not JSON') };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleOne(forge, (entry ?? {}) as Record<string, unknown>))
      .filter((answer) => answer !== null);
    return { status: 200, body: answers };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: the body is not a JSON-RPC request') };
  }
  const answer = handleOne(forge, parsed as Record<string, unknown>);
  if (answer === null) return { status: 202, body: null };
  return { status: 200, body: answer };
}
