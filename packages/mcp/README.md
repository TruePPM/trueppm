# trueppm-mcp

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for self-hosted [TruePPM](https://trueppm.com).**

Point any MCP client — Claude Desktop and the like — at your self-hosted TruePPM
instance and ask real questions of the live schedule: critical path, sprint
status, the risk register, My Work. Every answer is computed server-side by the
same engine the web UI uses — never an LLM guess, never leaving your box.

**Read-only by design.** This server exposes no write tools; the write surface is
deliberately held to a later release.

## How it works

`trueppm-mcp` is a thin protocol adapter. It talks to TruePPM **only over HTTP**
via the public REST API, carrying your API token as a bearer credential. It never
touches the database or the ORM — your role-based permissions are enforced exactly
once, at the API layer. The server can see nothing you could not already read in
the web client with the same token.

```
┌────────────────┐   stdio    ┌──────────────┐   HTTPS + Bearer   ┌──────────────┐
│  AI client     │◀──────────▶│ trueppm-mcp  │◀──────────────────▶│  TruePPM API │
│ (Claude etc.)  │   (MCP)    │  (this pkg)  │   GET /api/v1/...  │ (self-hosted)│
└────────────────┘            └──────────────┘                    └──────────────┘
```

## Quick start

The server is configured entirely from the environment:

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUEPPM_API_URL` | yes | Base URL of your TruePPM instance, e.g. `https://ppm.example.com` |
| `TRUEPPM_API_TOKEN` | yes | A project API token (`tppm_<64-hex>`), minted in project settings |

Run it as a local subprocess (the primary, stdio transport):

```bash
pip install trueppm-mcp
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp            # stdio (default)
```

Or expose the HTTP/SSE transport for a web-based assistant:

```bash
trueppm-mcp --transport http --host 127.0.0.1 --port 8000
```

See [`docs/administration/mcp-server.md`](https://docs.trueppm.com/administration/mcp-server)
for wiring it into Claude Desktop's `claude_desktop_config.json`.

## Status

The read-tool surface ships in 0.4: **14 read-only tools** across projects and
programs, tasks and My Work, schedule and risk, and sprints — each mapping to
one existing REST endpoint and returning only what your role permits. The
`mcp:read` token scope that marks a token read-only at the API layer lands
alongside. Write tools are deliberately held to a later release.

## License

Apache-2.0. Part of the TruePPM Community edition.
