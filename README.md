# makefun-github-forge-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/StarsN/makefun-github-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/StarsN/makefun-github-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node.js process, standard library only: git smart HTTP (protocol v2 ls-refs/fetch plus a v0 fallback, receive-pack with report-status), the REST v3 surface (repos, contents, labels, issues, comments, pull requests with squash merges), a GraphQL v4 endpoint with introspection, and an MCP endpoint (server/discover plus the initialize handshake) — all over one in-memory store, with the git object model and packfiles implemented from scratch on node:crypto and node:zlib.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=8fnx6nps&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
