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

The server authenticates with a **project API token** — the same `tppm_<64-hex>`
token used for inbound integrations (see [Sharing and access](./sharing-and-access.md)).
Mint one from a project's settings; the raw token is shown once, so copy it
immediately.

The token is read from the environment and is never written to logs or echoed
in an error message. Treat it like a password: anyone holding it can read
everything your role can read in that project.

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUEPPM_API_URL` | yes | Base URL of your instance, e.g. `https://ppm.example.com` (the `/api/v1` suffix is added automatically if omitted) |
| `TRUEPPM_API_TOKEN` | yes | A project API token (`tppm_<64-hex>`) |

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
subprocess and speaks MCP over the pipe. Configure it in your client. For Claude
Desktop, add an entry to `claude_desktop_config.json`:

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

This release is the **server scaffold**: it boots, authenticates, and registers
its tool list. The read-tool surface — projects, tasks, board state, schedule
summary, risks, sprints, Monte Carlo forecast, My Work, and single-program
health — registers in a follow-up, along with the dedicated `mcp:read` token
scope that marks a token read-only at the API layer. Each tool maps to one
existing REST endpoint and returns only what your role permits.

## Security notes

- **One enforcement point.** Authorization is enforced by the API, identically
  for this server and the web client. The MCP process holds no privileged path
  and is not a second copy of the permission model.
- **No secret in logs.** The token is never logged, never echoed in an error,
  and never included in a stack trace.
- **Read-only.** The server defines only read tools and issues only `GET`
  requests; the forthcoming `mcp:read` token scope additionally rejects any
  write even if the token is replayed directly against a write endpoint.
- **Self-hosted.** All traffic stays between your AI client, the server, and
  your own API — no third-party service is involved.
