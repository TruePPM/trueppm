# MCP server (read-only)

TruePPM ships a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server, `trueppm-mcp`, that lets any MCP client — Claude Desktop and the like —
ask real questions of your self-hosted instance. Answers are computed
server-side by the same engine the web UI uses, never guessed by a model, and
nothing leaves your box.

> **Edition.** The MCP server is part of the Community edition (Apache 2.0). It
> exposes only data the requesting user can already read under their existing
> role. Org-wide AI governance (cross-program agents, audited automation,
> approval workflows) is an Enterprise overlay and is not part of this server.

> **Read-only by design.** This server exposes no write tools and issues only
> `GET` requests. The write surface is deliberately held to a later release.

## How it fits together

`trueppm-mcp` is a thin protocol adapter. It runs **next to your AI client** —
typically as a local subprocess the client spawns — and talks to TruePPM **only
over HTTP** via the public REST API, carrying your API token as a bearer
credential. It never touches the database or the ORM, so your role-based
permissions are enforced exactly once, at the API layer. The server can see
nothing you could not already read in the web client with the same token.

```
┌────────────────┐   stdio    ┌──────────────┐   HTTPS + Bearer   ┌──────────────┐
│  AI client     │◀──────────▶│ trueppm-mcp  │◀──────────────────▶│  TruePPM API │
│ (Claude etc.)  │   (MCP)    │  subprocess  │   GET /api/v1/...  │ (self-hosted)│
└────────────────┘            └──────────────┘                    └──────────────┘
```

## Authentication

The server authenticates with a **personal access token** carrying the
**`mcp:read`** scope. The MCP read surface accepts **only** owner-scoped
(personal) tokens: a project- or program-scoped token is rejected there, so it
can never be turned into a credential that reads beyond the single scope it was
minted for. The token acts as *you* and returns only what your role permits.

Mint one at **Personal Settings → API tokens → Create token**: choose the
**"Read-only for AI assistants"** scope (`mcp:read`) and **set an expiry**
(required for `mcp:read`). The reveal dialog shows the raw token once and a
ready-to-paste `claude_desktop_config.json` snippet built from it — copy that
straight into your client's config and skip the manual assembly below. A
**"Full access"** (`legacy:full`) token is for inbound sync and is never
appropriate for an MCP client — and is refused on this surface regardless.

The token is read from the environment and is never written to logs or echoed
in an error message. Treat it like a password: anyone holding it can read
everything your role can read — but only until it expires, and it can never
write.

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUEPPM_API_URL` | yes | Base URL of your instance, e.g. `https://ppm.example.com` (the `/api/v1` suffix is added automatically if omitted) |
| `TRUEPPM_API_TOKEN` | yes | A personal access token (`tppm_<64-hex>`) with the `mcp:read` scope and an expiry |

On startup the server calls `GET /api/v1/auth/me/` once to confirm the token
authenticates. A rejected token (HTTP 401) fails the boot immediately with a
clear message rather than letting every query fail later.

## Running it

Install from PyPI (or build the bundled Docker image):

```bash
pip install trueppm-mcp
```

### stdio (primary)

stdio is the primary transport: the AI client launches the server as a
subprocess and speaks MCP over the pipe. If you minted an `mcp:read` token
from the **Personal Settings → API tokens** page, paste the snippet it gave you
and skip ahead. Otherwise, for Claude Desktop, add an entry to
`claude_desktop_config.json` by hand:

```json
{
  "mcpServers": {
    "trueppm": {
      "command": "trueppm-mcp",
      "env": {
        "TRUEPPM_API_URL": "https://ppm.example.com",
        "TRUEPPM_API_TOKEN": "tppm_your_token_here"
      }
    }
  }
}
```

Restart the client; it will spawn `trueppm-mcp` on demand. You can verify the
command works on its own first:

```bash
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp        # stdio (default); Ctrl-C to stop
```

### HTTP / SSE (for web assistants)

For a web-based assistant that connects over the network instead of spawning a
subprocess, run the HTTP (streamable-http) or SSE transport:

```bash
trueppm-mcp --transport http --host 127.0.0.1 --port 8000
# or: --transport sse
```

Bind to `127.0.0.1` and put it behind your own TLS-terminating proxy if you
expose it beyond localhost. An in-cluster, shared multi-user MCP endpoint (a
Helm chart addition) is a later, separate piece of work and is not part of this
release.

### Docker

The package ships a Dockerfile. stdio is the default entry point; pass transport
flags as container arguments:

```bash
docker build -t trueppm-mcp packages/mcp/

# stdio (interactive pipe)
docker run --rm -i \
  -e TRUEPPM_API_URL=https://ppm.example.com \
  -e TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp

# HTTP transport on port 8000
docker run --rm -p 8000:8000 \
  -e TRUEPPM_API_URL=https://ppm.example.com \
  -e TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp --transport http --host 0.0.0.0 --port 8000
```

## What it can answer

The read-tool surface ships in 0.4: **18 read-only tools**, each mapping to one
existing REST endpoint and returning only what your role permits. Results are
compacted for an LLM context budget (empty fields omitted, long free-text
truncated), and project/program results carry a `caller_role` field passed
straight through from the API.

- **Projects & programs** — `list_projects`, `get_project`, `list_programs`,
  `get_program_health` (single-program only; cross-program rollups are Enterprise),
  `list_program_backlog` (a program's backlog intake pool; single-program only).
- **Tasks & work** — `list_tasks` (filterable by status, assignee, sprint,
  criticality, type, and `updated_after`), `get_task`, `get_board_state`,
  `list_my_work`.
- **Schedule & risk** — `get_schedule_summary` (CPM finish, P50/P80/P95, SPI,
  critical-task count), `get_monte_carlo_forecast` (latest persisted run;
  read-only, never triggers a new simulation), `get_release_forecast`
  (velocity-based backlog delivery forecast — P50/P80 sprint counts and dates),
  `whatif` (perturb one task's
  duration and recompute CPM + Monte Carlo in memory — persists nothing — for
  "what breaks if this task slips?"), `get_schedule_derivation` (the
  server-computed *why* behind a CPM value or Monte Carlo percentile — the driving
  predecessor/successor, binding constraint, lag, and calendar contribution),
  `list_risks`.
- **Sprints** — `list_sprints`, `get_sprint` (aggregates and health bands only).
- **Identity** — `whoami` (connection check).

The dedicated `mcp:read` token scope marks a token read-only at the API layer
regardless of which client uses it. For the full tool reference and example
prompts, see the [MCP server feature page](../features/mcp-server.md).

## Security notes

- **One enforcement point.** Authorization is enforced by the API, identically
  for this server and the web client. The MCP process holds no privileged path
  and is not a second copy of the permission model.
- **No secret in logs.** The token is never logged, never echoed in an error,
  and never included in a stack trace.
- **Read-only.** The server defines only read tools and issues only `GET`
  requests; the `mcp:read` token scope additionally rejects any write even if
  the token is replayed directly against a write endpoint.
- **Owner-scoped and expiring.** The read surface accepts only a personal
  (owner-scoped) `mcp:read` token, so a leaked token reads exactly what its owner
  can read — never a whole project or program membership — and only until its
  required expiry. Project/program tokens are refused here entirely.
- **Self-hosted.** All traffic stays between your AI client, the server, and
  your own API — no third-party service is involved.
