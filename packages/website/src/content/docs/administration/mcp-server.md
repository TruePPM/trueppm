---
title: MCP server
description: Operate the read-only TruePPM MCP server — transports (stdio, HTTP, SSE), Docker deployment, token scopes, and the security posture.
documentedFor: "0.4"
---

:::caution[Pre-GA]
The read-only MCP server ships in 0.4, TruePPM's first beta. On unreleased builds
the tool list and the token-scope surface may still change. Expect API contract
changes across 0.x point releases; a stable contract arrives at 1.0.
:::

:::note[Ships in 0.4]
Both agent-access controls on this page — the instance kill switch
(`TRUEPPM_MCP_ENABLED`) and the team read opt-out — become **agent-scoped** in
**TruePPM 0.4**. In `v0.3.0-alpha.3` (the latest release) they apply to *any* API
token, including a member's own full-access (`legacy:full`) personal token, so a
person's own scripts are blocked and their collection reads silently return zero
rows alongside the agent traffic the controls are aimed at (#2877).
:::

This is the operator's reference for `trueppm-mcp`, the read-only
[Model Context Protocol](https://modelcontextprotocol.io) server. For the
user-facing feature overview — what it answers and how it wires into an AI
client — see [MCP server (read-only)](/features/mcp-server/). This page covers
the operational side: how to configure it, which transport to run, how to deploy
it in a container, and what its security posture is.

:::note[Edition]
The MCP server is part of the **Community (OSS)** edition (Apache 2.0). It exposes
only data the requesting token can already read under its existing role. Org-wide
AI governance (cross-program agents, audited automation, approval workflows) is
an Enterprise overlay and is not part of this server.
:::

## Where it runs

`trueppm-mcp` is a thin protocol adapter. It is **not** part of the API
deployment — it runs as a **separate process** that talks to TruePPM only over
HTTP via the public REST API, carrying a personal `mcp:read` access token as a
bearer credential. It never imports Django, never touches the database or the ORM, and
holds no privileged path: your role-based permissions are enforced exactly once,
at the API layer, identically for this server and the web client.

There are two placement models, and the transport you choose follows from the
placement:

- **Next to the AI client (stdio).** The client — Claude Desktop, Cursor, Zed —
  spawns `trueppm-mcp` as a local subprocess and speaks MCP over the pipe. This
  is the primary model and the default transport. Nothing listens on a network
  port.
- **As a network service (HTTP or SSE).** For a web-based or shared assistant
  that cannot spawn a local subprocess, run `trueppm-mcp` as a long-lived
  process (or container) that listens on a port. The AI client connects over
  Streamable HTTP or SSE.

## Prerequisites: mint a scoped token

The server authenticates with a **personal access token** (`tppm_<64-hex>`)
carrying the **`mcp:read` scope**. Mint one from **Personal Settings → API
tokens**; the raw token is shown **once**, so copy it immediately. Only the
SHA-256 digest is stored server-side.

The read surface accepts **only** owner-scoped (personal) tokens — a project- or
program-scoped token is **rejected** here, so it can never be turned into a
credential that reads beyond the single scope it was minted for. Choose the
**`mcp:read` scope** and **set an expiry** (required for `mcp:read`). That scope
grants safe-method (`GET`) access to the viewsets the MCP wraps and is **rejected
at every write path**, and the token acts as *you*: it reads only what your role
permits, cannot write, and cannot outlive its expiry.

**Mint `mcp:read`, not `legacy:full`.** A full-access personal token also
authenticates here — `legacy:full` is a read superset — but it is not an *agent*
credential, and the two agent-access controls below deliberately do not apply to
it: it is your own credential, governed exactly as your browser session is. Point
an MCP client at a `legacy:full` token and neither the instance kill switch nor a
team's read opt-out will restrain it, and its reads leave no rows in the
[agent-action audit log](#agent-action-audit-log). Choosing the read-only scope is
what makes an agent an agent.

## Environment configuration

The server is configured **entirely from the environment** — there is no config
file on disk, which keeps it spawnable as a subprocess with no state to manage.

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUEPPM_API_URL` | yes | Base URL of your instance, e.g. `https://ppm.example.com`. The `/api/v1` suffix is appended automatically if you omit it (and is idempotent if you include it). |
| `TRUEPPM_API_TOKEN` | yes | A personal access token (`tppm_<64-hex>`) with the `mcp:read` scope and an expiry. |

If either variable is missing or blank, the process exits immediately with exit
code `2` and an actionable message on stderr — it names the absent variable and
never echoes the token. On startup the server calls `GET /api/v1/auth/me/` once
to confirm the token authenticates, so a bad token fails the boot with a clear
error rather than letting every query 401 later.

## Transports

Select the transport with `--transport`. `--host` and `--port` apply only to the
network transports and are ignored for stdio.

| Flag | Transport | Default host / port | Use it when |
|------|-----------|---------------------|-------------|
| `--transport stdio` | stdio (default) | — | The AI client spawns the server as a local subprocess. |
| `--transport http` | Streamable HTTP | `127.0.0.1:8000` | A web/shared assistant connects over HTTP. |
| `--transport sse` | Server-Sent Events | `127.0.0.1:8000` | A client that only speaks the older SSE transport. |

### stdio (default)

```bash
pip install trueppm-mcp
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp            # stdio; Ctrl-C to stop
```

For wiring stdio into `claude_desktop_config.json`, see the
[feature guide](/features/mcp-server/#wiring-it-into-claude-desktop).

### HTTP / SSE

```bash
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp --transport http --host 127.0.0.1 --port 8000
```

The default bind host is `127.0.0.1` — loopback only — so an accidental launch
never exposes the server on a public interface. Bind to `0.0.0.0` **only** behind
a reverse proxy that terminates TLS and controls access; the server itself speaks
plain HTTP and holds a live credential, so it must never face the public internet
directly.

:::caution[The HTTP/SSE transport has no client-side authentication]
The network transports authenticate the server *to TruePPM* (with your token),
but they do **not** authenticate clients *to the server*: the MCP session itself
carries no credential, so anyone who can reach the listening port acts as the
token owner and reads everything your role permits. Keep the transport
loopback-only (`127.0.0.1`), or sit it behind an authenticated ingress (a reverse
proxy that terminates TLS and enforces access control). Never bind `0.0.0.0`
without that front door. Transport-level session auth is tracked for a later
release ([#604](https://gitlab.com/trueppm/trueppm/-/issues/604)); until then this
is a deployment responsibility.
:::

## Quickstart for non-Python clients (raw HTTP)

`trueppm-mcp` is a Python package, but nothing about the wire protocol is
Python-specific. This section is a worked `curl` transcript against the
Streamable HTTP transport so a TypeScript, Go, or Rust agent author can build
against it without reverse-engineering the handshake. Use an
[MCP SDK](https://modelcontextprotocol.io) for real work — this is the paved path
for understanding what the SDK does, and for debugging when it misbehaves.

Start the server on loopback first:

```bash
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp --transport http --host 127.0.0.1 --port 8000
```

The Streamable HTTP endpoint is **`POST /mcp`**. Two request headers are
mandatory on every call:

- `Content-Type: application/json`
- `Accept: application/json, text/event-stream` — responses are framed as SSE
  events even for a single reply. Omitting `text/event-stream` returns **406**.

### 1. Initialize

```bash
curl -i -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-06-18","capabilities":{},
        "clientInfo":{"name":"my-agent","version":"1.0"}}}'
```

The response carries the session id in a header — capture it, every later request
needs it:

```http
HTTP/1.1 200 OK
content-type: text/event-stream
mcp-session-id: 9107b4c7e7014f9d86ac599e3b812065

event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",
       "capabilities":{"tools":{"listChanged":false}, ...},
       "serverInfo":{"name":"trueppm","version":"1.28.1"},
       "instructions":"Read-only access to a self-hosted TruePPM instance: ..."}}
```

A request without `Mcp-Session-Id` returns **400**.

### 2. Confirm initialization

```bash
curl -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

This is a notification, not a request — no `id`, and the server answers **202**
with an empty body.

### 3. List the tools

```bash
curl -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

```
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"tools":[
       {"name":"list_projects","description":"List every project you can read...",
        "inputSchema":{"properties":{},"type":"object"},
        "outputSchema":{"type":"object","additionalProperties":true}}, ...]}}
```

### 4. Call a read tool

```bash
curl -X POST http://127.0.0.1:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"list_projects","arguments":{}}}'
```

Every tool result arrives twice over: `content` (the JSON rendered as text, for
models that only read text) and `structuredContent` (the same payload as real
JSON). **Parse `structuredContent`.**

```
event: message
data: {"jsonrpc":"2.0","id":3,"result":{
       "content":[{"type":"text","text":"{\n  \"items\": [],\n  \"total_count\": 0\n}"}],
       "structuredContent":{"items":[],"total_count":0},
       "isError":false}}
```

### 5. Read the inline provenance

The primary-answer tools — `get_task`, `get_schedule_summary`,
`get_monte_carlo_forecast`, and `whatif` — attach a **`why`** block inside
`structuredContent`. It is TruePPM's "computed, not guessed" evidence: the
server-side reason behind the number the tool just returned.

```json
{
  "p80": "2026-11-14",
  "cpm_finish": "2026-10-30",
  "why": {
    "top_driver": {"task_id": "…", "index": 0.62},
    "explanation": "This forecast: the P80 finish 2026-11-14 is 11 working day(s) past the deterministic CPM finish 2026-10-30; the largest single driver of that spread is task ….",
    "see_also": "get_schedule_derivation(project_id, quantity='p50'|'p80'|'p95') for the full risk-premium and per-driver derivation"
  }
}
```

Two properties make `why` cheap to consume: it never triggers a recompute or an
extra API call (it is distilled from fields the tool already fetched), and it is
scope-safe — it re-presents the token's own permission-filtered payload, so it
can never surface a field the token cannot see. It is **omitted entirely** rather
than fabricated when the inputs are absent, so treat it as optional.

### Legacy SSE transport

`--transport sse` serves the older two-endpoint transport instead: open a `GET`
stream on **`/sse`** and post messages to **`/messages/`**. Prefer Streamable
HTTP for anything new; use SSE only for a client that cannot speak the newer one.

## Docker

The package ships a `Dockerfile` (`packages/mcp/Dockerfile`). It is a two-stage,
non-root image with the Python build tools removed from the runtime layer, so it
scans clean and runs as an unprivileged user (UID 1000). Build it from the
package directory:

```bash
docker build -t trueppm-mcp packages/mcp/
```

Run it in stdio mode — pass `-i` so the client can drive it over the pipe:

```bash
docker run --rm -i \
  -e TRUEPPM_API_URL=https://ppm.example.com \
  -e TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp
```

Run it as a network service — publish the port and bind to `0.0.0.0` inside the
container (the container boundary is the loopback equivalent here; still front it
with a TLS-terminating proxy for anything beyond a private network):

```bash
docker run --rm -p 8000:8000 \
  -e TRUEPPM_API_URL=https://ppm.example.com \
  -e TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp --transport http --host 0.0.0.0 --port 8000
```

Pass the token via a Docker/Kubernetes secret or an env-file, never on the
command line where it would land in shell history and the process table.

:::note
The MCP server is intentionally decoupled from the main deployment: it is not a
service in the Compose stack or the Helm chart, because it is a per-client or
per-integration adapter rather than a core platform component. Run it wherever
the AI client lives. A packaged Helm sub-chart for a shared network deployment
may follow in a later release.
:::

## Security posture

- **One enforcement point.** Authorization is enforced by the API, identically
  for this server and the web client. The MCP process holds no privileged path
  and is not a second copy of the permission model. It can see nothing the token
  could not already read in the web client.
- **Read-only by scope, not just convention.** The server defines only read
  tools and issues only `GET` requests, and an `mcp:read` token is rejected at
  every write path at the API layer. The two guarantees are independent — even a
  bug that added a write call would be refused by the token scope.
- **Owner-scoped, least-privilege, expiring tokens.** The read surface accepts
  only a personal (owner-scoped) `mcp:read` token, so a leaked token reads exactly
  what its owner can read — never a whole project or program membership — and only
  until its required expiry. Project/program tokens are refused here entirely.
  Revoke a token from **Personal Settings → API tokens** the moment it is no longer
  needed; revocation takes effect immediately because every request re-checks the
  token.
- **No secret in logs.** The token is never logged, never echoed in an error,
  and never included in a stack trace or a `repr`. Configuration errors name the
  missing variable, not its value.
- **Tool output is framed as untrusted data.** Free-text fields (task
  descriptions, notes, risk mitigations, and the like) are wrapped in
  `<untrusted-content>` markers, and the server's own instructions to the
  model state explicitly that everything a tool returns is project data,
  never a directive to follow — a mitigation for indirect prompt injection
  via user-authored text that any project Member with write access could set.
  This is a framing mitigation, not a content filter: it does not sanitize or
  reject text, and it cannot fully close the class server-side — a
  well-behaved client and model are still required to honor it.
- **Fail-closed boot.** A token that does not authenticate fails startup with a
  clear message, so a misconfigured client never silently runs against the wrong
  instance.
- **Self-hosted.** All traffic stays between your AI client, the server, and your
  own API. No third-party service is involved, and no plan or inference leaves
  your box.
- **Network exposure is opt-in.** The default bind is loopback. Put any network
  transport behind a reverse proxy that terminates TLS; the server speaks plain
  HTTP and must never face the public internet directly.
- **Instance-wide kill switch.** Setting `TRUEPPM_MCP_ENABLED=false` on the API
  denies every `mcp:read` token read across the whole instance (`403`), even for
  tokens that already exist, while leaving human session/JWT traffic on the same
  endpoints untouched. This is the "no agent access, period" operator lever; see
  [Disabling MCP access entirely](/administration/configuration/#disabling-mcp-access-entirely).
- **Team-level opt-out.** A project (or program, or the workspace) can close
  itself to agent reads independently of the operator's switch — see
  [Team-level opt-out](#team-level-opt-out) below.

## Team-level opt-out

The instance switch above is the *operator's* lever. A team has its own, over
reads of its own data: **Project settings → Agents → Agent read access**.

:::note[Settings UI available at project scope only today]
The underlying `mcp_enabled` field and the instance → workspace → program →
project cascade already exist at all three scopes, but only the **project**
settings page has a UI for it. To set program or workspace scope today, use the
API directly: `PATCH /api/v1/programs/{id}/` or `PATCH /api/v1/workspace/` with
`{"mcp_enabled": true|false|null}` (Admin role or above). Every scope's
serializer also exposes read-only `effective_mcp_enabled` and
`inherited_mcp_enabled` fields so a client can show the resolved value without
re-implementing the cascade. Workspace- and program-scope settings pages are
tracked for a future release.
:::

**Project** and **program** scope are three-state: **Inherit** (no opinion of
its own), **Allowed**, or **Blocked**. The **workspace** root has no scope above
it to inherit from, so it is two-state — **Allowed** or **Blocked** — and
defaults to Allowed.

### What the control actually guarantees

It **blocks the read**. It is not an after-the-fact log.

This distinction matters, because TruePPM ships both and they are different
things:

| Surface | Guarantee |
| --- | --- |
| **Agent read access** (this control) | **Prevents** the read. MCP tools return a refusal for the project's data. |
| [Agent oversight](/features/agent-oversight/) | **Records** reads that happened. Visibility, not prevention. |

When a project is blocked, a project-scoped tool call returns `403` and every
collection endpoint simply withholds that project's rows — a cross-project tool
like "my work" keeps working and returns the caller's other projects, so one
team's decision never blanks another team's data. Every refusal is recorded in
the [agent-action audit log](#agent-action-audit-log) as a `policy` refusal.

### Who it affects

Only agent (`mcp:read` token) traffic. **People are never affected** — your team,
anyone signed in through the web or mobile app, and anyone running a script on
their own full-access (`legacy:full`) personal token read exactly what they always
did. Blocking agent access does not hide anything from a human being.

### What it cannot do

It binds **agent credentials**, not people. A member who holds a full-access
personal token can still read the project's data and paste it wherever they like —
including into an AI client, by pointing that client at a `legacy:full` token
instead of an `mcp:read` one. That is the same trust model as a person copying a
task list into a chat window, and no server-side switch reaches it: the credential
carries their own authority, so restraining it would mean restraining them.

What the control does guarantee is that a credential minted *as an agent* is
bound, always, by whichever scope objects. Treat it as the answer to "may an agent
be pointed at this team's data," not as a data-loss-prevention boundary.

### The rules that make it consent rather than a suggestion

1. **Any scope may block; no scope may unblock another's block.** The effective
   answer is the AND of every scope — instance, workspace, program, project. A
   workspace administrator can close agent access org-wide, and **cannot** re-open
   a project that closed itself. There is deliberately no "enforce" or "lock"
   setting that would let a higher scope force agent reads back on.
2. **Inherit means "nobody above has objected"** — never "yes, on your behalf".
3. **An agent cannot lift its own restriction.** `mcp:read` tokens are read-only
   at the API layer, so an agent cannot change this setting under any role.
4. **Changing it requires project Admin or above**, and every change is recorded
   in the project's history.

### Why it is separate from the instance switch

The two are shown as separate facts and never collapsed into one. A team's page
always reflects *the team's* decision, so a toggle never reads "off" for a reason
the team cannot act on. Because the switches are ANDed, turning one on can never
override the other's "off".

## Agent-action audit log

Every read an MCP/agent token makes — and every refusal — is recorded as one
append-only **agent-action** row: the acting token (its 8-character prefix only,
never the secret), the human the token acts for, the operation, the project in
scope, the verdict (`allowed`, or `refused` with an `identity` vs `policy`
reason), a per-request payload hash, and the scheduler engine version at the time.
This answers *what did this agent read, when, and in which project* — the question
a single `last_used_at` timestamp could not.

The rows form a **per-instance, hash-chained** log: each row stores
`sha256(previous_hash ‖ the row's canonical fields)`, so altering or deleting any
row breaks the chain. Verify the chain's integrity at any time:

```bash
python manage.py audit_verify
```

It walks the chain in order, recomputes each hash, and reports the first break (or
confirms the chain is intact). This is the OSS **integrity self-check** — it lets a
team detect tampering on its own instance. External notarization, a cryptographic
signature over the chain, *enforced* retention policy, legal hold, and an org-wide
cross-instance trail are Enterprise (ADR-0112).

The log is append-only and grows without limit. To bound it, an operator can prune the
oldest records with [`audit_prune`](/administration/management-commands/#maintenance-commands),
which deletes a block of the oldest rows and writes a checkpoint so `audit_verify` keeps
verifying the records that remain. Pruning is **manual and never automatic** — TruePPM
does not delete audit history on its own; cron the command yourself if you want periodic
rotation.

Project members read their team's agent actions at `GET /api/v1/agent-actions/`,
scoped to the projects they belong to (plus their own agent's actions). Only
**agent** (`mcp:read`) traffic is recorded: a human session read on the same views
is not, and neither is a read made with a member's own full-access (`legacy:full`)
personal token — that is a person's credential, and recording it as agent activity
would misattribute a script to an agent that does not exist. Auditing what a
full-access token does across the whole API is separate, tracked work; the token's
own mint and revoke history is at
[`GET /api/v1/me/api-token-audit/`](/features/personal-access-tokens/#your-token-history).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Exit code `2`, "Configuration error" on stderr | `TRUEPPM_API_URL` or `TRUEPPM_API_TOKEN` is unset or blank. |
| Boot fails with "the TruePPM API rejected the configured token (HTTP 401)" | The token is missing, malformed, or revoked. Mint a fresh `mcp:read` token. |
| A tool returns a 404 for a resource you expect to see | The token's role on its project/program does not permit reading that resource — 404 is the deliberate existence oracle, identical to the web client. |
| A tool that used to work now errors on a write | An `mcp:read` token is refused at write paths by design; this server issues no writes, so this indicates a misrouted call, not a permission gap to widen. |
