---
title: MCP server
description: Operate the read-only TruePPM MCP server — transports (stdio, HTTP, SSE), Docker deployment, token scopes, and the security posture.
---

:::caution[Pre-GA]
The read-only MCP server ships in 0.4, TruePPM's first beta. On unreleased builds
the tool list and the token-scope surface may still change. Expect API contract
changes across 0.x point releases; a stable contract arrives at 1.0.
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
permits, cannot write, and cannot outlive its expiry. The unrestricted
`legacy:full` token is for inbound sync and is refused on this surface.

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
- **Fail-closed boot.** A token that does not authenticate fails startup with a
  clear message, so a misconfigured client never silently runs against the wrong
  instance.
- **Self-hosted.** All traffic stays between your AI client, the server, and your
  own API. No third-party service is involved, and no plan or inference leaves
  your box.
- **Network exposure is opt-in.** The default bind is loopback. Put any network
  transport behind a reverse proxy that terminates TLS; the server speaks plain
  HTTP and must never face the public internet directly.

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
scoped to the projects they belong to (plus their own agent's actions). A human
session read on the same views is **not** recorded — only token/agent traffic is.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Exit code `2`, "Configuration error" on stderr | `TRUEPPM_API_URL` or `TRUEPPM_API_TOKEN` is unset or blank. |
| Boot fails with "the TruePPM API rejected the configured token (HTTP 401)" | The token is missing, malformed, or revoked. Mint a fresh `mcp:read` token. |
| A tool returns a 404 for a resource you expect to see | The token's role on its project/program does not permit reading that resource — 404 is the deliberate existence oracle, identical to the web client. |
| A tool that used to work now errors on a write | An `mcp:read` token is refused at write paths by design; this server issues no writes, so this indicates a misrouted call, not a permission gap to widen. |
