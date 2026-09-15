# trueppm-mcp

[![PyPI version](https://img.shields.io/pypi/v/trueppm-mcp.svg)](https://pypi.org/project/trueppm-mcp/)
[![PyPI downloads](https://img.shields.io/pypi/dm/trueppm-mcp.svg)](https://pypi.org/project/trueppm-mcp/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

**A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for self-hosted [TruePPM](https://trueppm.com).**

Point any MCP client — Claude Desktop and the like — at your self-hosted TruePPM
instance and ask real questions of the live schedule: critical path, sprint
status, the risk register, My Work. Every answer is computed server-side by the
same engine the web UI uses — never an LLM guess, never leaving your box.

**Why reach for this instead of just asking a model?** A model has no access to
your schedule and no CPM/Monte Carlo engine to run — asked "what happens if we
slip this task three days," it can only guess in prose. This server lets the
same question hit your actual engine: `whatif` reruns the real Monte Carlo
simulation in memory and returns the percentile shift, `get_schedule_derivation`
names the *actual* dependency that set a date instead of a plausible-sounding
one. The answer is computed, cited, and reproducible — never invented.

**Read-only by design.** This server exposes no write tools; the write surface is
deliberately held to a later release.

## Requirements

- Python 3.11+
- A running, network-reachable **self-hosted TruePPM instance on `0.4.0-beta.1`
  or later** — earlier releases don't expose the endpoints these tools call
  (e.g. the non-mutating what-if endpoint, #993, is a 0.4 addition). There is
  nothing to connect to without one; this package is a protocol adapter, not a
  standalone tool.
- A **personal access token** minted on that instance with the `mcp:read`
  scope and an expiry (see Quick start below) — the server has no other way
  to authenticate.

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
| `TRUEPPM_API_TOKEN` | yes | A **personal access token** (`tppm_<64-hex>`) minted with the **`mcp:read` scope** and an **expiry**, from **Personal Settings → API tokens** |

**Mint the right token.** The MCP read surface accepts only a personal (owner-scoped)
token carrying the `mcp:read` scope — a project- or program-scoped token is rejected
there so it can never read beyond the single scope it was minted for. Choose the
`mcp:read` scope and set an expiry (required for `mcp:read`): the token acts as *you*,
reads only what your role permits, and cannot write or outlive its expiry — so a leaked
token is read-only and self-limiting.

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

See [`packages/website/src/content/docs/administration/mcp-server.md`](https://docs.trueppm.com/administration/mcp-server/)
for wiring it into Claude Desktop's `claude_desktop_config.json`.

## Example

Once connected, ask the client a real question about your schedule in plain
language:

> "If the API redesign task slips three days, do we still hit the March 3
> launch?"

The client calls the `whatif` tool — `GET
/projects/<id>/monte-carlo/whatif/` — which reruns Monte Carlo in memory with
the perturbed duration and returns the shifted P50/P80/P95, the delta against
the current forecast, and whether the task is still on the critical path.
Nothing is written; the same call can be made as many times as you like.

## Dependencies

Pulled in automatically by `pip install trueppm-mcp` — nothing to install
separately:

| Package | Why |
|---|---|
| [`mcp[cli]`](https://pypi.org/project/mcp/) | The official Model Context Protocol SDK (FastMCP) — server runtime, tool registration, and the stdio/SSE/streamable-HTTP transports. |
| [`httpx`](https://pypi.org/project/httpx/) | Async HTTP client used for every call to the TruePPM REST API. |
| [`cryptography`](https://pypi.org/project/cryptography/) | A transitive dependency of `mcp[cli]` (via `pyjwt[crypto]`), pinned directly here only to force a resolver floor past a fixed CVE — not used by this package's own code. |

## Status

The read-tool surface ships in 0.4: **19 read-only tools** across projects and
programs, tasks and My Work, schedule and risk (including non-mutating what-if
and schedule derivation), and sprints — each mapping to one existing REST
endpoint and returning only what your role permits. The
`mcp:read` token scope that marks a token read-only at the API layer lands
alongside; the read surface admits only owner-scoped `mcp:read` tokens, which
must carry an expiry. Write tools are deliberately held to a later release.

## License

Apache-2.0. Part of the TruePPM Community edition.
