// The GraphQL v4 surface: POST /api/graphql.
//
// A small, purpose-built GraphQL implementation — a lexer and parser for the
// document shapes gh and github-mcp-server send (operations with variables,
// aliases, inline fragments, input objects, enum lists, batched operation
// arrays), a schema model rich enough for the feature-detection __type
// probes, and an executor whose resolvers read and write the same store the
// REST surface serves. Global ids are opaque base64 of "<Type>:<key>", so
// they are stable across reads and never the plain database id.

import { ApiError, createIssue, createPull, mergePull, pullFiles, pullMergeable } from './operations.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', '=', '@', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    const ch = source[pos]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', pos)) {
        const end = source.indexOf('"""', pos + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(pos + 3, end) });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          const esc = source[pos + 1]!;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 4;
          } else value += esc;
          pos += 2;
        } else {
          value += source[pos];
          pos += 1;
        }
      }
      if (pos >= source.length) throw new Error('unterminated string');
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(pos))!;
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      pos += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(pos))!;
      tokens.push({ kind: 'name', value: match[0] });
      pos += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token "${token.value}"`);
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('fragment definition is missing "on"');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.next(); // the variable name
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next(); // the type name
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.next(); // the directive name
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        this.next();
        return { kind: 'fragmentSpread', name: token.value };
      }
      // An inline fragment without a type condition.
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected a field name, got "${first.value}"`);
    let alias: string | null = null;
    let name = first.value;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.next().value;
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    this.expectPunct('(');
    const args: { name: string; value: ValueNode }[] = [];
    while (!this.skipPunct(')')) {
      const name = this.next().value;
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.next().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** A ValueNode with variables substituted from the operation's variable map. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema model (for __type)

interface TypeModel {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_MODELS: Record<string, TypeModel> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'rateLimit'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'createdAt', 'updatedAt'] },
  Organization: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
      'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'refs', 'labels', 'stargazerCount', 'forkCount',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments',
      'createdAt', 'updatedAt', 'closedAt', 'repository',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'mergeable',
      'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'comments', 'url',
      'createdAt', 'updatedAt', 'closedAt', 'repository', 'author',
    ],
  },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'ofType', 'inputFields', 'possibleTypes', 'specifiedByURL'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType', 'directives'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueClosedStateReason: { kind: 'ENUM', enumValues: ['COMPLETED', 'NOT_PLANNED', 'DUPLICATE'] },
};

// ---------------------------------------------------------------- global ids

/** An opaque global id: base64url of "<Type>:<key parts>", never the bare key. */
export function globalId(type: string, ...key: (string | number)[]): string {
  return Buffer.from(`${type}:${key.join(':')}`, 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { type: string; key: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split === -1) return null;
    return { type: text.slice(0, split), key: text.slice(split + 1).split(':') };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', repo.id, pull.number);
}

// ---------------------------------------------------------------- execution

/** A typed value the executor completes: a type name plus its source record. */
interface GValue {
  t: string;
  v: unknown;
}

function g(t: string, v: unknown): GValue {
  return { t, v };
}

function isGValue(value: unknown): value is GValue {
  return typeof value === 'object' && value !== null && 't' in value && 'v' in value;
}

class GqlError extends Error {}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = valueOf(arg.value, ctx.variables);
  return args;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  first: number | undefined;
  after: string | null | undefined;
  numberOf: (item: T) => number;
}

/** Slice a connection page out of an ordered list, with its pageInfo. */
function pageOf<T>(spec: ConnectionSpec<T>): { page: T[]; pageInfo: GValue } {
  let start = 0;
  if (typeof spec.after === 'string' && spec.after !== '') {
    const afterNumber = numberFromCursor(spec.after);
    if (afterNumber !== null) {
      const index = spec.items.findIndex((item) => spec.numberOf(item) === afterNumber);
      if (index !== -1) start = index + 1;
    }
  }
  const limit = spec.first === undefined ? spec.items.length : Math.max(0, spec.first);
  const page = spec.items.slice(start, start + limit);
  const hasNextPage = start + page.length < spec.items.length;
  const endCursor = page.length > 0 ? cursorOf(spec.numberOf(page[page.length - 1]!)) : null;
  const startCursor = page.length > 0 ? cursorOf(spec.numberOf(page[0]!)) : null;
  return {
    page,
    pageInfo: g('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor, endCursor }),
  };
}

function issuesConnection(ctx: ExecCtx, repo: RepoRec, args: Record<string, unknown>): GValue {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy !== undefined && orderBy !== null) {
    const ascending = orderBy.direction === 'ASC';
    list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const { page, pageInfo } = pageOf({
    items: list,
    first: typeof args.first === 'number' ? args.first : undefined,
    after: args.after as string | null | undefined,
    numberOf: (issue) => issue.number,
  });
  return g('IssueConnection', {
    nodes: page.map((issue) => g('Issue', { repo, issue })),
    pageInfo,
    totalCount: list.length,
  });
}

function pullsConnection(ctx: ExecCtx, repo: RepoRec, args: Record<string, unknown>): GValue {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  list.sort((a, b) => b.number - a.number);
  const { page, pageInfo } = pageOf({
    items: list,
    first: typeof args.first === 'number' ? args.first : undefined,
    after: args.after as string | null | undefined,
    numberOf: (pull) => pull.number,
  });
  return g('PullRequestConnection', {
    nodes: page.map((pull) => g('PullRequest', { repo, pull })),
    pageInfo,
    totalCount: list.length,
  });
}

function repoByGlobalId(forge: Forge, id: string): RepoRec | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Repository') return null;
  const dbId = Number(decoded.key[0]);
  return forge.listRepos().find((repo) => repo.id === dbId) ?? null;
}

function issueByGlobalId(forge: Forge, id: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const repo = forge.listRepos().find((candidate) => candidate.id === Number(decoded.key[0]));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number(decoded.key[1]));
  return issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(forge: Forge, id: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const repo = forge.listRepos().find((candidate) => candidate.id === Number(decoded.key[0]));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number(decoded.key[1]));
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------- field resolvers

function resolveField(obj: GValue, field: FieldNode, ctx: ExecCtx): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const name = field.name;

  if (obj.t === '__Type') {
    const typeName = (obj.v as { name: string }).name;
    const model = TYPE_MODELS[typeName];
    switch (name) {
      case 'name':
        return typeName;
      case 'kind':
        return model?.kind ?? 'OBJECT';
      case 'description':
        return null;
      case 'fields':
        return model?.fields?.map((fieldName) => g('__Field', { name: fieldName })) ?? null;
      case 'enumValues':
        return model?.enumValues?.map((valueName) => g('__EnumValue', { name: valueName })) ?? null;
      default:
        return null;
    }
  }

  switch (obj.t) {
    case 'Query': {
      switch (name) {
        case 'viewer':
          return g('User', forge.viewer);
        case 'repository': {
          const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          return repo === undefined ? null : g('Repository', repo);
        }
        case 'node': {
          const id = String(args.id ?? '');
          const decoded = decodeGlobalId(id);
          if (decoded === null) return null;
          if (decoded.type === 'Repository') {
            const repo = repoByGlobalId(forge, id);
            return repo === null ? null : g('Repository', repo);
          }
          if (decoded.type === 'Issue') {
            const found = issueByGlobalId(forge, id);
            return found === null ? null : g('Issue', found);
          }
          if (decoded.type === 'PullRequest') {
            const found = pullByGlobalId(forge, id);
            return found === null ? null : g('PullRequest', found);
          }
          return null;
        }
        case '__type': {
          const typeName = String(args.name ?? '');
          return TYPE_MODELS[typeName] === undefined ? null : g('__Type', { name: typeName });
        }
        case 'rateLimit':
          return g('RateLimit', { limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: '2025-01-01T01:00:00Z', nodeCount: 0 });
        default:
          break;
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(name, args, ctx);
    }
    case 'User': {
      const viewer = forge.viewer;
      switch (name) {
        case 'id':
          return globalId('User', viewer.id);
        case 'login':
          return viewer.login;
        case 'name':
          return viewer.name;
        case 'email':
          return viewer.email;
        case 'url':
          return `/${viewer.login}`;
        case 'createdAt':
        case 'updatedAt':
          return '2025-01-01T00:00:00Z';
        default:
          break;
      }
      break;
    }
    case 'Repository': {
      const repo = obj.v as RepoRec;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return g('User', forge.viewer);
        case 'defaultBranchRef':
          return g('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'description':
          return repo.description;
        case 'url':
          return `/${repo.owner}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt':
          return repo.createdAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : g('Issue', { repo, issue });
        }
        case 'issues':
          return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : g('PullRequest', { repo, pull });
        }
        case 'pullRequests':
          return pullsConnection(ctx, repo, args);
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = obj.v as { repo: RepoRec; issue: IssueRec };
      switch (name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'url':
          return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'author':
          return g('User', forge.viewer);
        case 'repository':
          return g('Repository', repo);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'labels':
          return g('LabelConnection', {
            nodes: issue.labels.map((labelName) =>
              g('Label', repo.labels.get(labelName) ?? { id: 0, name: labelName, color: 'ededed', description: '' }),
            ),
            pageInfo: g('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
            totalCount: issue.labels.length,
          });
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = obj.v as { repo: RepoRec; pull: PullRec };
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(forge, repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return g('Ref', { name: pull.headRef });
        case 'baseRef':
          return g('Ref', { name: pull.baseRef });
        case 'url':
          return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'author':
          return g('User', forge.viewer);
        case 'repository':
          return g('Repository', repo);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.state === 'closed' ? pull.updatedAt : null;
        case 'mergeCommit':
          return null;
        case 'files': {
          const files = pullFiles(forge, repo, pull);
          const { page, pageInfo } = pageOf({
            items: files,
            first: typeof args.first === 'number' ? args.first : undefined,
            after: args.after as string | null | undefined,
            numberOf: (file) => files.indexOf(file) + 1,
          });
          return g('PullRequestChangedFileConnection', {
            nodes: page.map((file) => g('PullRequestChangedFile', { path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() })),
            pageInfo,
            totalCount: files.length,
          });
        }
        default:
          break;
      }
      break;
    }
    case 'IssueComment': {
      const { repo, issue, comment } = obj.v as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string; createdAt: string } };
      switch (name) {
        case 'id':
          return globalId('IssueComment', repo.id, issue.number, comment.id);
        case 'databaseId':
          return comment.id;
        case 'body':
          return comment.body;
        case 'author':
          return g('User', forge.viewer);
        case 'createdAt':
        case 'updatedAt':
          return comment.createdAt;
        case 'url':
          return `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`;
        default:
          break;
      }
      break;
    }
    default:
      break;
  }
  // their stored properties answer directly, after the schema model confirms
  // the field exists on the type.
  const model = TYPE_MODELS[obj.t];
  if (model !== undefined && model.fields !== undefined && !model.fields.includes(name)) {
    throw new GqlError(`Field '${name}' doesn't exist on type '${obj.t}'`);
  }
  if (typeof obj.v === 'object' && obj.v !== null && name in (obj.v as Record<string, unknown>)) {
    return (obj.v as Record<string, unknown>)[name];
  }
  throw new GqlError(`Field '${name}' doesn't exist on type '${obj.t}'`);
}

function resolveMutation(name: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const { forge } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'createIssue': {
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) throw new GqlError('repository not found');
        const issue = createIssue(forge, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        return g('CreateIssuePayload', { issue: g('Issue', { repo, issue }), clientMutationId: input.clientMutationId ?? null });
      }
      case 'closeIssue': {
        const found = issueByGlobalId(forge, String(input.issueId ?? ''));
        if (found === null) throw new GqlError('issue not found');
        found.issue.state = 'closed';
        found.issue.updatedAt = forge.clock.tickIso();
        return g('CloseIssuePayload', { issue: g('Issue', found), clientMutationId: input.clientMutationId ?? null });
      }
      case 'createPullRequest': {
        const repo = repoByGlobalId(forge, String(input.repositoryId ?? ''));
        if (repo === null) throw new GqlError('repository not found');
        const pull = createPull(forge, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? repo.defaultBranch),
        });
        return g('CreatePullRequestPayload', { pullRequest: g('PullRequest', { repo, pull }), clientMutationId: input.clientMutationId ?? null });
      }
      case 'mergePullRequest': {
        const found = pullByGlobalId(forge, String(input.pullRequestId ?? ''));
        if (found === null) throw new GqlError('pull request not found');
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        mergePull(forge, found.repo, found.pull, method);
        return g('MergePullRequestPayload', { pullRequest: g('PullRequest', found), clientMutationId: input.clientMutationId ?? null });
      }
      case 'addComment': {
        const found = issueByGlobalId(forge, String(input.subjectId ?? ''));
        if (found === null) throw new GqlError('subject not found');
        const comment = {
          id: found.repo.nextCommentId,
          body: String(input.body ?? ''),
          createdAt: forge.clock.tickIso(),
          seq: forge.nextSeq(),
        };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        return g('AddCommentPayload', {
          commentEdge: g('IssueCommentEdge', { node: g('IssueComment', { repo: found.repo, issue: found.issue, comment }), cursor: cursorOf(comment.id) }),
          subject: g('Issue', found),
          clientMutationId: input.clientMutationId ?? null,
        });
      }
      default:
        break;
    }
  } catch (err) {
    if (err instanceof ApiError) throw new GqlError(err.message);
    throw err;
  }
  throw new GqlError(`Field '${name}' doesn't exist on type 'Mutation'`);
}

// ---------------------------------------------------------------- completion

function executeSelections(obj: GValue, selections: readonly SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = obj.t;
        continue;
      }
      let value: unknown;
      try {
        value = resolveField(obj, selection, ctx);
      } catch (err) {
        if (err instanceof GqlError) {
          ctx.errors.push({ message: err.message });
          value = null;
        } else {
          throw err;
        }
      }
      out[key] = completeValue(value, selection.selectionSet, ctx);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === obj.t || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelections(obj, selection.selectionSet, ctx));
      }
      continue;
    }
    const fragment = ctx.fragments.get(selection.name);
    if (fragment !== undefined && fragment.typeCondition === obj.t) {
      Object.assign(out, executeSelections(obj, fragment.selectionSet, ctx));
    }
  }
  return out;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selectionSet, ctx));
  if (isGValue(value)) {
    if (selectionSet === null) return null;
    return executeSelections(value, selectionSet, ctx);
  }
  return value;
}

// ---------------------------------------------------------------- entry point

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one operation document body ({query, variables, operationName}). */
function executeOne(forge: Forge, body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query === '') return { errors: [{ message: 'a query document is required' }] };
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    operationName === null
      ? document.operations[0]
      : document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecCtx = {
    forge,
    variables: (body.variables ?? {}) as Record<string, unknown>,
    fragments: document.fragments,
    errors: [],
  };
  const root = g(operation.operation === 'mutation' ? 'Mutation' : 'Query', null);
  const data = executeSelections(root, operation.selectionSet, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

/** POST /api/graphql: one operation, or an array of them answered in order. */
export function handleGraphQL(forge: Forge, payload: unknown): GraphQLReply {
  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => executeOne(forge, (entry ?? {}) as Record<string, unknown>)) };
  }
  if (typeof payload !== 'object' || payload === null) {
    return { status: 400, body: { errors: [{ message: 'the request body must be a JSON object' }] } };
  }
  return { status: 200, body: executeOne(forge, payload as Record<string, unknown>) };
}
