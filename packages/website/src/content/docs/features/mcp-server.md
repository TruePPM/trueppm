---
title: MCP server (read-only)
description: Point any MCP client — Claude Desktop, Cursor, Zed — at your self-hosted TruePPM instance and ask real questions of the live schedule. Every answer is computed server-side by the same engine the web UI uses, never guessed by a model, never leaving your box.
---

:::note[Coming in 0.4]
The read-only MCP server ships in 0.4, TruePPM's first beta. On unreleased
builds the tool list may still be changing.
:::

TruePPM ships a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server, `trueppm-mcp`, that lets any MCP client — Claude Desktop, Cursor, Zed,
and the like — ask real questions of your self-hosted instance: the critical
path, a Monte Carlo slip forecast, sprint status, the risk register, My Work.
Answers are computed server-side by the same CPM/Monte Carlo engine the web UI
uses, never guessed by a model, and nothing leaves your box.

The MCP server is the first place you feel TruePPM's AI principle —
**computed, not guessed.** Every incumbent bolts an LLM onto a project database
and lets the model guess dates; here the model only translates your question into
an engine call, and the CPM/Monte Carlo engine supplies the number. The answer is
a computation with a derivation, not a language model's opinion. See
[Computed, not guessed](/architecture/overview/#computed-not-guessed)
for the full architectural picture.

:::note[Edition]
The MCP server is part of the **Community (OSS)** edition (Apache 2.0). It
exposes only data the requesting user can already read under their existing
role. Org-wide AI governance (cross-program agents, audited automation, approval
workflows) is an Enterprise overlay and is not part of this server.
:::

:::caution[Read-only by design]
This server exposes **no write tools** and issues only `GET` requests. The write
surface (create/update task, move card, log time) is deliberately held to a
later release.
:::

## How it works

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

## Quickstart

The server is configured entirely from the environment — no config file on disk.
It authenticates with a **project API token** (`tppm_<64-hex>`), the same token
used for [inbound integrations](/features/inbound-task-sync/). Mint one from a
project's settings; the raw token is shown once, so copy it immediately.

| Variable | Required | Description |
|----------|----------|-------------|
| `TRUEPPM_API_URL` | yes | Base URL of your instance, e.g. `https://ppm.example.com` (the `/api/v1` suffix is added automatically if omitted) |
| `TRUEPPM_API_TOKEN` | yes | A project API token (`tppm_<64-hex>`) |

Install from PyPI and run it as a local subprocess (the primary, stdio
transport):

```bash
pip install trueppm-mcp
TRUEPPM_API_URL=https://ppm.example.com \
TRUEPPM_API_TOKEN=tppm_your_token_here \
  trueppm-mcp            # stdio (default); Ctrl-C to stop
```

On startup the server calls `GET /api/v1/auth/me/` once to confirm the token
authenticates, so a bad token fails the boot immediately with a clear message
rather than letting every query fail later.

### Wiring it into Claude Desktop

stdio is the primary transport: the AI client launches the server as a
subprocess and speaks MCP over the pipe. For Claude Desktop, add an entry to
`claude_desktop_config.json`:

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

Restart the client; it will spawn `trueppm-mcp` on demand. A dedicated
administration guide covering the HTTP/SSE transports, Docker, and the full
security notes is planned (tracked in issue 1616).

## What it can answer

The server registers **14 read-only tools**, each mapping to one existing REST
endpoint and returning only what your role permits. Results are compacted for an
LLM context budget: empty and null fields are omitted, long free-text fields are
truncated (with a `"truncated": true` marker), and project/program results carry
a `caller_role` field — your own authoritative role, passed straight through from
the API.

### Projects & programs

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_projects` | — | Every project you can read, each with your `caller_role`. |
| `get_project` | `project_id` | Full project metadata and a health overview, with `caller_role`. |
| `list_programs` | — | Every program you can read, each with your `caller_role`. |
| `get_program_health` | `program_id` | Rollup health for one program (single-program; cross-program rollups are Enterprise). |

### Tasks & work

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_tasks` | `project_id`, and optional `status`, `assignee`, `sprint`, `is_critical`, `type`, `updated_after` (alias `since`) | A project's tasks, filtered and compacted. |
| `get_task` | `task_id` | Full detail for one task (dates, assignee, acceptance criteria, sprint). |
| `get_board_state` | `project_id` | The board's columns and their task cards for one project. |
| `list_my_work` | — | Your assigned tasks across every project you belong to. |

### Schedule & risk

| Tool | Arguments | Returns |
|------|-----------|---------|
| `get_schedule_summary` | `project_id` | CPM finish, Monte Carlo P50/P80/P95, SPI, and the critical-task count. |
| `get_monte_carlo_forecast` | `project_id` | The latest **persisted** Monte Carlo run (P50/P80/P95, `cpm_finish`, delta). Read-only — never triggers a new simulation. |
| `list_risks` | `project_id` | The project's risk register (impact, probability, status). |

### Sprints

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_sprints` | `project_id` | The project's sprints (health bands and aggregates only — no per-person velocity). |
| `get_sprint` | `sprint_id` | One sprint with its project's health band (aggregates only). |

### Identity

| Tool | Arguments | Returns |
|------|-----------|---------|
| `whoami` | — | The identity behind your configured token — a quick connection check. |

## Example prompts

Once connected, ask your assistant natural-language questions and it will pick
the right tool:

- "Which of my projects are behind their P80 forecast?"
- "Show me the critical path for the Apollo project and how much slack the near-critical tasks have."
- "What's on my plate this sprint?"
- "List the open high-impact risks for the Mercury program."

## Security notes

- **One enforcement point.** Authorization is enforced by the API, identically
  for this server and the web client. The MCP process holds no privileged path
  and is not a second copy of the permission model.
- **No secret in logs.** The token is never logged, never echoed in an error,
  and never included in a stack trace.
- **Read-only.** The server defines only read tools and issues only `GET`
  requests. The write surface is held to a later release.
- **Self-hosted.** All traffic stays between your AI client, the server, and
  your own API — no third-party service is involved.
