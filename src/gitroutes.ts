// The git route dispatch: /{owner}/{repo}.git/... onto src/gitproto.ts.
//
// Kept apart from the server so the protocol module answers pure
// request-in/response-out calls. A repository that was never created over
// REST does not exist here either: info/refs for it is a 404 for both
// services, and a push cannot invent one.

import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './gitproto.ts';
import type { Forge } from './store.ts';

export function handleGitRoute(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: Buffer,
  gitProtocolHeader: string | string[] | undefined,
): GitResponse {
  const owner = segments[0]!;
  const repoName = segments[1]!.slice(0, -'.git'.length);
  const tail = segments.slice(2).join('/');
  const repo = forge.getRepo(owner, repoName);
  const protocolText = Array.isArray(gitProtocolHeader) ? gitProtocolHeader.join(',') : (gitProtocolHeader ?? '');
  const wantsV2 = protocolText.split(/[\s,]+/).includes('version=2');

  if (method === 'GET' && tail === 'info/refs') {
    return handleInfoRefs(forge, repo, query.get('service'), wantsV2);
  }
  if (method === 'POST' && tail === 'git-upload-pack') {
    return handleUploadPack(forge, repo, body, wantsV2);
  }
  if (method === 'POST' && tail === 'git-receive-pack') {
    return handleReceivePack(forge, repo, body);
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}
