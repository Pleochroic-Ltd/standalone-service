# standalone-service API (v1)

The account service for Alexandrite clients: Alexandrite, alx, and later clients with the Lattice plugin built in.
Every endpoint sits under the `/v1` prefix. A self-hosted install serves it directly; mounted in the Pleochroic
gateway, it shares `https://api.pleochroic.co.uk/v1` with the model API.

Status: sync (config, secrets, the change feed, skills, memory notes), web search and web fetch are implemented. The
browser and Lattice are scaffolds that answer `501 not_implemented`.

## Conventions

| Item | Convention |
|---|---|
| Authentication | `Authorization: Bearer <key>`. On the gateway, a portal `plc-` key; self-hosted, `SERVICE_TOKEN` |
| Client identity | `X-Client: alexandrite/1.2 macbook` (optional), recorded in a document's `updatedBy` and in logs |
| Fields and formats | camelCase; times in UTC ISO 8601; sizes in bytes; money in micro-dollars |
| Revisions | Documents carry `rev`, returned as `ETag: "<rev>"`. Changing an existing document requires `If-Match: "<rev>"`; to create only, send `If-None-Match: *` |
| Ids in paths | An id containing slashes is percent-encoded whole as one path segment, e.g. `openai-compatible%2Fworkbuddy` |
| PUT and DELETE answers | A sync PUT (`/config`, `/secrets`, `/skills`, `/memory`) answers with meta only, with the new `ETag`. `PUT /secrets` needs only the `sync` scope, so it never returns the value, which needs `secrets:read`. Fetch content with GET. DELETE answers `{ "ok": true }` |
| Errors | `{ "error": { "code", "message", ... } }`, the status set by the code, as below |

| code | Status | Meaning |
|---|---|---|
| `invalid_request` | 400 | Bad parameters |
| `unauthorized` | 401 | No key, or an invalid one |
| `insufficient_credits` | 402 | Past the plan's allowance with no credits left |
| `not_entitled` | 403 | The plan does not include the service |
| `missing_scope` | 403 | The key lacks the required scope; the body carries `scope` |
| `not_found` | 404 | |
| `conflict` | 409 | `If-Match` is not the current revision; the body carries `current` (the current meta) |
| `snapshot_required` | 410 | The op log no longer holds every record after `since`; the body carries `oldestSeq`, and the client loads the snapshot again |
| `too_large` | 413 | |
| `precondition_required` | 428 | A change to an existing document without `If-Match` |
| `quota_exceeded` | 429 | Past the allowance; the body carries `service` and `resetsAt` |
| `rate_limited` | 429 | Too many requests, with a `Retry-After` header |
| `internal` | 500 | |
| `not_implemented` | 501 | |
| `upstream_error` | 502 | A search engine, the browser pool or a model failed |

### Scopes

Each key carries a set of scopes. A self-hosted install grants them all. In the portal, older keys have only
`models`, and keys issued by device login have all of them.

| scope | Allows |
|---|---|
| `models` | The gateway's model API, outside this service |
| `sync` | Config, secret metadata, skills, memory, the change feed |
| `secrets:read` | Reading secret values |
| `tools` | Search, fetch, browser |
| `graph` | Lattice graph storage, embeddings, memory model |

## Pleochroic accounts: login and models

The portal and the gateway provide these endpoints; they are outside this service. A client (Alexandrite, alx) with
a Pleochroic account gets a key and uses models as described here. Against a self-hosted install, the client takes
the service address and `SERVICE_TOKEN` directly, with no login.

### Device login (as in RFC 8628)

1. The client calls `POST https://portal.pleochroic.co.uk/api/device/code` with the body
   `{ client, clientVersion?, deviceName? }` (`client` such as `alexandrite` or `alx`), and gets
   `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }`:
   - `userCode` looks like `BCDF-GHJK` (8 letters, without vowels or easily confused characters), `expiresIn` is 600
     seconds, `interval` is 5 seconds;
   - `verificationUri` is `https://portal.pleochroic.co.uk/device`, and `verificationUriComplete` adds
     `?code=<userCode>`.
2. The client shows `userCode` and opens `verificationUriComplete`. Signed in to the portal, the user sees the client
   name, the device name and the scopes to grant, and allows or denies.
3. Every `interval` seconds the client calls `POST https://portal.pleochroic.co.uk/api/device/token` with the body
   `{ deviceCode }`:
   - not confirmed yet: `400 { error: "authorization_pending" }`; polling too fast: `400 { error: "slow_down" }`
     (add 5 seconds to the interval from then on);
   - denied: `400 { error: "access_denied" }`; expired: `400 { error: "expired_token" }`;
   - allowed: `200 { key, keyId, scopes, account: { username, name, plan: { id, name } }, apiBase: "https://api.pleochroic.co.uk/v1" }`.
     `key` is a new `plc-` key with every scope, shown only here, and listed in the portal's keys as
     "<client> · <deviceName>".
4. Sign-out: the client calls `DELETE https://api.pleochroic.co.uk/v1/key` with that key, which revokes it. The user
   can also revoke it in the portal.

These two endpoints follow RFC 8628 and answer errors as a flat string, `{ error: "<code>" }`, the shape existing
OAuth device-flow client libraries expect. The rest of this API answers `{ error: { code, message } }`.

These two endpoints need no cookie and are exempt from the portal's same-origin rule for POST: a request is let
through only when it has no `Origin`, which a cross-site browser request always sends. Allow and deny on the
`/device` page are still same-origin POSTs.

### Models

- A client treats Pleochroic as an OpenAI-compatible provider: `baseUrl = apiBase`
  (`https://api.pleochroic.co.uk/v1`), `Authorization: Bearer <key>`, Chat Completions (`POST /chat/completions`,
  the native path, with thinking in `reasoning_content`). `/v1/responses` and `/v1/messages` (Anthropic format) are
  also available.
- Model list: `GET /v1/models`. Each entry carries OpenRouter-shaped capability fields: `context_length`,
  `top_provider.max_completion_tokens`, `architecture.input_modalities`, `supported_parameters` (when it includes
  `reasoning_effort`, the thinking level can be set).
- Requests should carry `X-Client` (as above). Each response carries `x-request-id`, and rate-limit state is in the
  `x-ratelimit-*` headers.
- When the plan's allowance runs out, the answer is `429` with `error.code` `token_limit` and `Retry-After`.

## Account and entitlements

### `GET /v1/service`

Who the caller is and what they may use. A client calls it at start and after a 403 or 429 to decide which features
to show or hide. The server still decides on every request, so a stale answer at worst hides a feature too many or
leads to a clear refusal.

```json
{
  "service": { "name": "pleochroic", "version": "0.1.0", "apiVersion": 1 },
  "account": { "id": "42", "name": "John", "plan": { "id": "intermodal", "name": "Intermodal" } },
  "scopes": ["models", "sync", "secrets:read", "tools", "graph"],
  "credits": { "balanceMicros": 12500000 },
  "services": {
    "sync":    { "enabled": true, "quota": { "unit": "bytes", "period": null, "limit": 1073741824, "used": 3145728, "resetsAt": null }, "overage": "stop", "priceMicros": null },
    "search":  { "enabled": true, "quota": { "unit": "requests", "period": "month", "limit": 2000, "used": 37, "resetsAt": "2026-11-01T00:00:00Z" }, "overage": "credits", "priceMicros": 5000 },
    "browser": { "enabled": true, "quota": { "unit": "minutes", ... }, "extra": { "concurrent": 1, "sessionMinutes": 30 }, "overage": "credits", "priceMicros": 2000 },
    "fetch": { ... }, "graph": { ... }, "embeddings": { ... }, "memoryModel": { ... }
  }
}
```

There are seven services: `sync`, `search`, `fetch`, `browser`, `graph`, `embeddings`, `memoryModel`.

- **Quota units**: bytes, requests, minutes, tokens, graphs (the number of graphs).
- **`overage`**: what happens past the allowance.
  - `credits`: use continues, charged to credits at `priceMicros`, per million for tokens and per unit otherwise.
  - `stop`: the answer is 429.

## Sync

### Config documents

| Method | Path | Description |
|---|---|---|
| GET | `/config?kind=` | Meta of every document, deleted ones left out |
| GET | `/config/:kind/:id` | `{ kind, id, rev, size, updatedAt, updatedBy, data }` |
| PUT | `/config/:kind/:id` | `{ data }`, at most 256 KiB |
| DELETE | `/config/:kind/:id` | Requires `If-Match` |

Each `kind` maps to one place in Alexandrite's config:

| kind | Place in Alexandrite | id |
|---|---|---|
| `provider` | `providers.<plugin>.endpoints.<name>` (EndpointConfig) | `<plugin>/<name>` |
| `agent` | `agent.agents.<id>` (AgentConfig) | agent id |
| `profile` | Sub-agent profile (AgentProfile) | profile id |
| `mcp` | `mcp.servers.<name>` (ServerConfig) | server name |
| `settings` | `app.*`, a plugin's personal settings | `app` or the plugin id |
| `instructions` | A Markdown file, `data: { text }` | `AGENTS.md`, `agents/<id>/PERSONA.md` |

`data` holds references such as `${secret:NAME}` in place of the keys themselves. Locally Alexandrite writes
`${env:NAME}` with `secrets.env`, and the client converts between the two when it syncs. The server rejects `data`
containing a string that looks like a key.

### Secrets

| Method | Path | Description |
|---|---|---|
| GET | `/secrets` | Names and meta, without values |
| GET | `/secrets/:name` | The value; requires `secrets:read` |
| PUT | `/secrets/:name` | `{ value }` or `{ sealed: { alg, data, keyId? } }` |
| DELETE | `/secrets/:name` | |

- `name` format: `^[A-Z][A-Z0-9_]{0,63}$`.
- With `value`, the server encrypts it with its own key before storing it (AES-256-GCM, as the portal stores TOTP
  seeds).
- With `sealed`, the client has already encrypted it. The server stores it as it is and never opens it, for end-to-end
  encryption.

### Change feed

`GET /sync/changes?since=<seq>&limit=` returns `{ changes: [{ seq, area, kind, id, rev, deleted, at }], cursor, more }`.

- `area` is one of `config`, `secret`, `skill`, `memory`.
- Deleted documents appear too, with `deleted` true.
- The client keeps `cursor` and continues from it next time. `since=0` returns the complete history (the sync feed is
  never compacted), so a first sync can use it as the snapshot.
- Secret entries have no kind: `kind` is `null`.
- When a document changed both locally and remotely, the client merges and writes back with the new `If-Match`.

## Skills

| Method | Path | Description |
|---|---|---|
| GET | `/skills?scope=` | `[{ name, description, scope, rev, size, updatedAt }]` |
| GET | `/skills/:scope/:name` | `{ files: [{ path, encoding: "utf8"\|"base64", content }] }` |
| PUT | `/skills/:scope/:name` | `{ files }` |
| DELETE | `/skills/:scope/:name` | |

**scope**, shared by skills and memory:

| scope | Local directory |
|---|---|
| `global` | `<config>/skills/` |
| `agent:<id>` | `<config>/agents/<id>/skills/` |
| `project:<hash>` | A stable hash of the project root. Project skills sync only when the user opts in, since the source directory may not be trusted |

**Validation**:

- The name follows the Agent Skills naming rule and matches the name in `SKILL.md`'s front matter.
- `SKILL.md` is at most 64 KiB. A whole folder is at most 200 files and 4 MiB.
- Paths are relative and contain no `..`.

## Memory (plain-text notes)

| Method | Path | Description |
|---|---|---|
| GET | `/memory?scope=&tag=&q=&limit=` | Meta list, by relevance with `q`, newest first otherwise |
| GET | `/memory/:scope/:id` | `{ title, content, tags, ... }` |
| PUT | `/memory/:scope/:id` | `{ title, content, tags? }`, at most 64 KiB |
| DELETE | `/memory/:scope/:id` | |

The client generates ids (a slug or a UUID), so the same note written on two offline devices lands on one document
after sync. These notes are for clients without Lattice and for notes users write themselves; Lattice's graphs live
under `/graphs`.

## Web search and fetch

| Method | Path | Request → response | Metered |
|---|---|---|---|
| POST | `/search` | `{ query, count≤20, freshness?, sites?, language? }` → `{ results: [{ title, url, snippet, publishedAt }], backend, cached? }` | search: 1 request |
| POST | `/fetch` | `{ url, format: markdown\|text\|html, maxChars? }` → `{ url, status, contentType, title, content, truncated, cached? }` | fetch: 1 request |

- **Search backends**: set by the Host, with fallback in order. The Pleochroic gateway tries its own SearXNG
  (`searxngSearch`) first, then Brave and Tavily. A self-hosted install uses the same order, trying those that
  `SEARXNG_URL` (optional `SEARXNG_TOKEN`), `BRAVE_API_KEY` and `TAVILY_API_KEY` configure.
- **Pleochroic Search**: the SearXNG instance `searxngSearch` points at by default is the `search/` submodule of this
  repository, a private fork of SearXNG with its own branding and engine selection, and deploy scripts in
  `search/pleochroic/`. It listens on 127.0.0.1 only, and this service is its only caller. **License**: `search/` is
  AGPL-3.0-or-later, with SearXNG's license and copyright notices unchanged; the rest of the repository, this service
  included, is MIT. [search/pleochroic/README.md](../search/pleochroic/README.md) covers deployment, the branding
  changes, the outbound proxy in a private override file, and rebasing onto upstream.
- **Alexandrite integration**: a new `WebSearchBackend` with id `pleochroic` calls `/search`; `web.fetch` can also go
  through `/fetch`.
- **Fetch safety limits**:
  - after DNS resolution, private, loopback and link-local addresses are refused, and every redirect is checked again;
  - at most 5 redirects are followed;
  - at most a few MB of the body are read.
- **Cache**: both endpoints may first check a cache shared across accounts (results are public data). `/search` keys
  on the query, `count`, `freshness`, the sorted `sites` and `language`, and keeps an answer for 12 hours (15 minutes
  with `freshness=day`, 2 hours with `week`). `/fetch` keys on the URL and `format`, keeps an answer for 6 hours, and
  caches only 2xx text responses, skipping any the origin marks `Cache-Control: no-store` or `private`. On a hit the
  response carries `cached: true`; on a miss, or with no cache, the field is absent. A hit is still metered as one
  request, and the Host sees `cached: true` in `record` and decides whether to charge credits for it. A self-hosted
  install caps the cache in bytes and evicts the oldest entries first.

## Headless browser

| Method | Path | Description |
|---|---|---|
| POST | `/browser/sessions` | `{ viewport?, locale?, idleSeconds? }` → `{ id, createdAt, expiresAt, url, cdpUrl }` |
| GET | `/browser/sessions` | The caller's open sessions |
| POST | `/browser/sessions/:id/actions` | Runs one action and returns `{ url, title, snapshot?, screenshot?, value? }` |
| DELETE | `/browser/sessions/:id` | Closes the session, metered in minutes |

**Actions**:

| Category | Actions |
|---|---|
| Navigation | `navigate`, `back`, `forward`, `reload` |
| Interaction | `click`, `type` (optional `submit`), `press`, `scroll`, `select` |
| Waiting | `wait` (for some seconds, or until some text appears) |
| Reading | `snapshot` (accessibility tree as text), `screenshot` (PNG, base64) |
| Scripting | `evaluate` |

- **Elements**: named by a ref from the snapshot (such as `e12`) or by a CSS selector. Refs expire when the page
  changes.
- **CDP**: `cdpUrl` is a DevTools-protocol WebSocket for clients that drive the browser themselves. A server may not
  offer it, in which case it is null.
- **Session lifetime**:
  - sessions are billed by the minute from open to close, a part minute counting as a whole one;
  - a session closes itself after `idleSeconds` without an action, or at the plan's longest session;
  - the plan also sets how many sessions may be open at once.
- **Isolation**: each session is its own Chromium context, and its cookies and storage are cleared when it ends.

## Lattice

Lattice keeps its graph in client memory, and recall and consolidation run in the client. The server stores graphs
and provides model calls.

### Graph storage

Lattice's own LatticeStore writes through: every change goes to storage at once, and the whole graph loads at start.
The remote LatticeStore maps onto these endpoints.

| Method | Path | Description |
|---|---|---|
| GET | `/graphs` | `[{ name, seq, oldestSeq, engrams, edges, embedding: { model, dimension }, size, updatedAt }]` |
| POST | `/graphs` | `{ name, embedding }`, creates a graph. Metered by count |
| GET / DELETE | `/graphs/:name` | Reads or deletes a graph |
| GET | `/graphs/:name/snapshot` | NDJSON: a first line `{ seq }`, then one op per line for the current state |
| POST | `/graphs/:name/ops` | `{ baseSeq?, ops }` → `{ seq }`. The batch is written in one transaction |
| GET | `/graphs/:name/ops?since=` | `{ ops: [...+seq], seq, more }`, the ops other devices wrote |

**Op kinds**:

| op | Meaning |
|---|---|
| `putEngram` | Writes a memory node. Its embedding is L2-normalized little-endian float32 bytes, base64-encoded |
| `deleteEngram` | Deletes a node with its edges and memberships |
| `putEdge`, `deleteEdge` | Writes or deletes an edge |
| `putRecord`, `deleteRecord` | Every other record (entities, scenes, threads, periods, eras, duplicate verdicts and so on) as `{ type, key, data }`, so the server needn't follow Lattice's schema |

**Conflicts**: when `baseSeq` is behind the graph's current seq, the answer is 409 with the current `seq`. The client
pulls `/ops?since=`, merges locally, and submits again.

**Op log compaction**: every Lattice sleep decays the weights of many edges, so a log kept whole would soon outgrow
the graph. The server compacts it:

- an op that a later op on the same record overwrites or deletes is dropped at once;
- the remaining ops are kept for 30 days (`OP_LOG_DAYS`), so a device offline for less catches up from the log;
- a device further behind gets `410 snapshot_required` from `/ops?since=` and loads the snapshot again;
- storage is metered on the graph's current state (`size`), without the log.

**Namespaces**: the graph name is the namespace, one graph per Lattice instance (an agent, say). Lattice's own nodes
have no tenant field, so graphs provide that isolation.

**One embedding model per graph**: `dimension` is fixed when the graph is created, and vectors of another dimension
are rejected.

### Model calls

| Method | Path | Description | Metered |
|---|---|---|---|
| POST | `/embeddings` | OpenAI embeddings format. Lattice's OpenAI-compatible embedder works with only the base URL and key changed | embeddings: tokens |
| POST | `/lattice/complete` | `{ task, system, user }` → `{ text, model, usage }` | memoryModel: tokens |

- **`task` values**: `extract`, `judge`, `abstract`, `entities`, `narrate`, `scenes`, `periods`.
- **The server picks the model**: the client names none, and the server chooses one per task.
- **On the Pleochroic gateway**: an administrator sets the model for each task. Calls count toward the account's
  5-hour and weekly allowances, scaled by that model's limit weight; with a model of weight 0, sleep-time
  consolidation is free.

## Mounting and the Host

```ts
import { createService } from 'standalone-service';
const service = createService(host, { prefix: '/v1' });
// In your own HTTP server:
if (await service.handle(req, res)) return;   // answers the service's own routes and leaves the rest untouched
```

`host` (`src/host.ts`) provides:

| Method or field | Responsibility |
|---|---|
| `authenticate` | Authenticates and returns a Principal: `{ accountId, keyId, scopes, client }` |
| `status` | Builds the `/service` answer |
| `admit(p, service, units)`, `record(...)` | Decides before a request whether to let it through, and records actual use after it (`cached` in `record`'s detail marks a cache hit) |
| `store`, `graphs` | Storage |
| `search`, `fetcher`, `browsers`, `models` | Search, fetch, browser, models. Each is optional; without it the matching endpoints answer 501 |
| `cache` | The shared `/search` and `/fetch` result cache, common to all accounts. Without it every call goes upstream |

The two Hosts:

| Host | Authentication | Entitlements and metering | Storage and engines |
|---|---|---|---|
| Self-hosted (`src/standalone/host.ts`) | A single token | Everything allowed, nothing metered | SQLite (`migrateStore`/`sqliteStore` in `src/store/sqlite.ts`, `migrateCache`/`sqliteCache` in `src/store/cache.ts`); search in the order SearXNG → Brave → Tavily, built-in fetch, all configured through environment variables; model calls not wired yet |
| Pleochroic gateway (`portal/service-host.ts`) | Portal keys and scopes | Entitlements per plan, overage charged to credits | The portal database |
