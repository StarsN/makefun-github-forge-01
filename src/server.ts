// The HTTP server: routing, authentication and response plumbing.
//
// One process serves four surfaces off one Forge store:
//   GET  /healthz                       the env's boot probe (no auth)
//   /api/v3/...                         the REST surface (src/rest.ts)
//   POST /api/graphql                   the GraphQL surface (src/graphql.ts)
//   POST /mcp                           the MCP surface (src/mcp.ts)
//   /{owner}/{repo}.git/...             git smart HTTP (src/gitproto.ts)
//
// Every route but /healthz requires the trial's bearer token; a missing or
// wrong one is a 401 with a JSON message, on every surface alike. Every
// response carries a non-empty X-GitHub-Request-Id. REST bodies that are not
// valid JSON are a 400 before any handler runs; the MCP endpoint parses its
// own body because its contract answers a parse error in JSON-RPC terms.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitRoute } from './gitroutes.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import type { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

export interface AppOptions {
  /** The bearer token requests must present; '' accepts any presented token. */
  token: string;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Read a request body whole. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; a malformed one is the protocol's 400. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  return expectedToken === '' || presented === expectedToken;
}

export function createApp(forge: Forge, options: AppOptions): Server {
  let requestCounter = 0;

  const sendBuffer = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter}`);
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://forge');
    } catch {
      throw new HttpError(400, 'unparseable request URL');
    }
    const path = url.pathname;

    if (method === 'GET' && path === '/healthz') {
      sendBuffer(res, 200, JSON_TYPE, Buffer.from(JSON.stringify({ ok: true })));
      return;
    }

    const segments = path
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });

    // Git smart HTTP lives at /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
      if (!isAuthorized(req, options.token)) throw new HttpError(401, 'Bad credentials');
      const raw = method === 'POST' || method === 'PUT' ? await readBody(req) : Buffer.alloc(0);
      const reply = handleGitRoute(forge, method, segments, url.searchParams, raw, req.headers['git-protocol']);
      sendBuffer(res, reply.status, reply.contentType, reply.body);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
      if (method !== 'POST') throw new HttpError(404, 'Not Found');
      if (!isAuthorized(req, options.token)) throw new HttpError(401, 'Bad credentials');
      const raw = await readBody(req);
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Malformed JSON body');
      }
      const reply = handleGraphQL(forge, payload);
      sendBuffer(res, reply.status, JSON_TYPE, Buffer.from(JSON.stringify(reply.body)));
      return;
    }

    if (segments[0] === 'mcp' && segments.length === 1) {
      if (method === 'DELETE') {
        sendBuffer(res, 204, JSON_TYPE, Buffer.alloc(0));
        return;
      }
      if (method !== 'POST') throw new HttpError(405, 'Method Not Allowed');
      if (!isAuthorized(req, options.token)) throw new HttpError(401, 'Bad credentials');
      const raw = await readBody(req);
      const reply = handleMcp(forge, raw);
      if (reply.body === null) {
        sendBuffer(res, reply.status, JSON_TYPE, Buffer.alloc(0));
      } else {
        sendBuffer(res, reply.status, JSON_TYPE, Buffer.from(JSON.stringify(reply.body)));
      }
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (!isAuthorized(req, options.token)) throw new HttpError(401, 'Bad credentials');
      let body: Record<string, unknown> | null = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
        if (raw.length > 0 && parsed !== null && body === null) throw new HttpError(400, 'Malformed JSON body');
      }
      const origin = `http://${req.headers.host ?? 'localhost'}`;
      const reply = handleRest(forge, method, segments.slice(2), url.searchParams, body, origin);
      const headers: Record<string, string> = { 'content-type': JSON_TYPE, ...(reply.headers ?? {}) };
      if (reply.status === 204 || reply.body === null) {
        res.writeHead(reply.status, headers);
        res.end();
        return;
      }
      const text = JSON.stringify(reply.body);
      res.writeHead(reply.status, { ...headers, 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }

    throw new HttpError(404, 'Not Found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Internal Server Error';
      if (!(err instanceof HttpError)) {
        process.stderr.write(`[forge] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      }
      if (!res.headersSent) {
        const text = JSON.stringify({ message });
        res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
        res.end(text);
      } else {
        res.end();
      }
    });
  });
  return server;
}
