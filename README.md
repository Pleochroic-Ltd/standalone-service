# standalone-service

Account services for Alexandrite clients. It is open source under the MIT license, can be self-hosted, and is the
same code that runs behind the Pleochroic gateway (api.pleochroic.co.uk).

- **Sync**: providers (endpoint configs), secrets, agents, sub-agents, MCP servers, personal settings, instruction
  files, skills and memory notes, kept in step across devices through one change feed.
- **Tools**: web search, web fetch and headless browsers.
- **Lattice**: graph storage (an op log plus snapshots), and embedding and memory-model calls (extraction, duplicate
  judging, sleep-time consolidation).

[docs/API.md](docs/API.md) describes every endpoint. Sync (config, secrets, the change feed, skills, memory notes),
web search and web fetch are implemented. The headless browser and Lattice (graph storage, embeddings,
`/lattice/complete`) are scaffolds that answer `501 not_implemented`.

```bash
SERVICE_TOKEN=$(openssl rand -hex 24) npm start    # self-hosted, on http://127.0.0.1:8791
npm test                                          # node:test
npm run check                                     # type check
```

Environment variables for a self-hosted install (read in `src/standalone/host.ts`):

| Variable | Purpose |
|---|---|
| `SERVICE_TOKEN` (or `SERVICE_TOKEN_FILE`) | The clients' Bearer token, at least 16 characters |
| `SERVICE_DATA` | Directory for the database and the key, default `./data` |
| `SERVICE_SECRET_KEY_FILE` | AES-256-GCM key that encrypts secrets (64 hex characters). When unset, one is generated at `SERVICE_DATA/secret.key` (mode 0600). **Back it up with the database**: without it, the stored secrets cannot be decrypted |
| `SEARXNG_URL` (optional `SEARXNG_TOKEN`), `BRAVE_API_KEY`, `TAVILY_API_KEY` | Web search backends, tried in this order. With none set, `/search` answers `501`. `SEARXNG_URL` points at a SearXNG instance of your own (or Pleochroic's), and `SEARXNG_TOKEN` sends `Authorization: Bearer` to a private one |
| `CACHE_MAX_BYTES` | Byte cap of the result cache shared by `/search` and `/fetch`, default 64 MB, oldest entries evicted first |

By default `SEARXNG_URL` points at Pleochroic Search on the same machine. It is the `search/` git submodule of this
repository, [Pleochroic-Ltd/pleochroic-search](https://github.com/Pleochroic-Ltd/pleochroic-search), a fork of
SearXNG (clone with `--recurse-submodules`). It listens on 127.0.0.1 only, and this service is its only caller.
[search/pleochroic/README.md](search/pleochroic/README.md) covers how to deploy it, what the branding changes, and
how to set an outbound proxy in a private override file.

**License**: `search/` is AGPL-3.0-or-later, with SearXNG's license and copyright notices unchanged. The rest of the
repository, this service, is MIT.

Fetching (`/fetch`) needs no configuration. Its SSRF protection is always on: it refuses loopback, private,
link-local, CGNAT, multicast, unspecified and cloud metadata addresses, and their IPv4-mapped IPv6 forms, checks
again on every redirect, and pins each connection to the resolved address against DNS rebinding.

`/search` and `/fetch` both look in the shared cache first; results are public data and are shared across accounts.
A hit answers with `cached: true` and is still metered as one request.

As in the portal, Node runs the TypeScript directly (type stripping, Node 22.18 or later), and there are no runtime
dependencies.

```
src/index.ts             createService(host): mounts in any Node HTTP server
src/host.ts              The Host interface: auth, entitlements, metering, storage, search/fetch/browser/model engines
src/types.ts             Types of every request and response
src/http.ts              Routing, errors, JSON, revisions (ETag)
src/limits.ts            Per-request size limits and naming rules
src/services/            Endpoint groups: account, sync, skills, memory, web, browser, graph, lattice
src/store/sqlite.ts      Sync storage: a node:sqlite Store (documents, change feed, secret encryption)
src/store/cache.ts       Shared /search and /fetch result cache: a node:sqlite Cache (expiry, eviction by bytes)
src/engines/             Search (SearXNG, Brave, Tavily, firstOf fallback) and fetch (SSRF protection, HTML to Markdown/text)
src/standalone/          The Host and entry point for a self-hosted install
test/                    node:test
```
