---
title: Connect your MCP client
description: Wire Claude Desktop, Cursor, or Zed to your self-hosted TruePPM MCP server — mint a read-only token, drop in the config snippet, and ask your assistant real questions of the live schedule.
---

:::note[Coming in 0.4]
The read-only MCP server ships in 0.4, TruePPM's first beta. On unreleased
builds the tool list and token-scope surface may still be changing.
:::

This page is the client-side companion to the
[MCP server feature overview](/features/mcp-server/): how to connect the three
MCP clients most self-hosters reach for — **Claude Desktop, Cursor, and Zed** —
to your own TruePPM instance. Each connects the same way: it spawns
`trueppm-mcp` as a local subprocess (stdio) and passes your instance URL and a
read-only token through the environment. Pick your client below, paste the
snippet, restart, and ask.

For the operator's reference — transports, Docker, and the security posture —
see the [MCP server administration guide](/administration/mcp-server/).

## Step 1 — Mint a read-only token

The server authenticates with a **project API token** (`tppm_<64-hex>`) — the
same token type used for [inbound task sync](/features/inbound-task-sync/),
scoped read-only for AI clients.

1. Open **Project or Program → Settings → Integrations → API Tokens → Create
   token**.
2. Choose the **"Read-only for AI assistants"** scope (`mcp:read`). This grants
   safe-method (`GET`) access only and is rejected at every write path, so it is
   the correct least-privilege credential for an assistant.
3. The reveal dialog shows the raw token **once** — copy it immediately. Only its
   SHA-256 digest is stored server-side, so a lost token cannot be recovered,
   only revoked and re-minted.

A token is bound to a single project or a single program and can read only what
your role on that scope permits. The reveal dialog also offers a ready-to-paste
`claude_desktop_config.json` snippet built from the token — if you use Claude
Desktop, that snippet is the fastest path and you can skip the manual assembly
below.

:::caution
Treat the token like a password. Anyone holding it can read everything your role
can read on that project or program. Pass it through your client's `env` block or
a secret store — never commit it to a shared config file.
:::

## Step 2 — Add the server to your client

Every snippet below points `trueppm-mcp` at your instance with two environment
variables:

| Variable | Description |
|----------|-------------|
| `TRUEPPM_API_URL` | Base URL of your instance, e.g. `https://ppm.example.com`. The `/api/v1` suffix is appended automatically if you omit it. |
| `TRUEPPM_API_TOKEN` | The `tppm_<64-hex>` token from Step 1, with the `mcp:read` scope. |

Install the server first (or use the [Docker image](/administration/mcp-server/#docker)):

```bash
pip install trueppm-mcp        # or: uv tool install trueppm-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit
Config) and add a `trueppm` entry under `mcpServers`:

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

Restart Claude Desktop; it spawns `trueppm-mcp` on demand and the TruePPM tools
appear in the tools menu.

### Cursor

Create or edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).
Cursor uses the same `mcpServers` shape as Claude Desktop:

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

Reload Cursor, then confirm the server shows as connected under **Settings →
MCP**.

### Zed

Add a custom context server to Zed's `settings.json` (Zed → Settings, or
`cmd`/`ctrl` + `,`):

```json
{
  "context_servers": {
    "trueppm": {
      "source": "custom",
      "command": "trueppm-mcp",
      "args": [],
      "env": {
        "TRUEPPM_API_URL": "https://ppm.example.com",
        "TRUEPPM_API_TOKEN": "tppm_your_token_here"
      }
    }
  }
}
```

Zed launches the server for the Agent Panel; the TruePPM tools become available
to the assistant there.

## Step 3 — Verify the connection

Ask your assistant to run the `whoami` tool (or just ask "who am I in TruePPM?").
It returns the identity behind your token — a quick confirmation that the URL,
token, and scope are all correct. On startup the server also calls
`GET /api/v1/auth/me/` once, so a bad token fails the launch immediately with a
clear message rather than letting every later query fail.

## What you can ask

The server exposes **14 read-only tools**, each mapping to one existing REST
endpoint and returning only what your role permits:

- **Projects & programs** — `list_projects`, `get_project`, `list_programs`,
  `get_program_health` (single-program only; cross-program rollups are Enterprise).
- **Tasks & work** — `list_tasks` (filterable by status, assignee, sprint,
  criticality, type, and `updated_after`), `get_task`, `get_board_state`,
  `list_my_work`.
- **Schedule & risk** — `get_schedule_summary`, `get_monte_carlo_forecast`
  (latest persisted run; read-only, never triggers a new simulation), `list_risks`.
- **Sprints** — `list_sprints`, `get_sprint` (aggregates and health bands only).
- **Identity** — `whoami`.

For the full per-tool argument reference and example prompts, see the
[MCP server feature page](/features/mcp-server/#what-it-can-answer).

Some questions to try once connected:

- "Which of my projects are behind their P80 forecast?"
- "Show me the critical path for the Apollo project."
- "What's on my plate this sprint?"
- "List the open high-impact risks for the Mercury program."

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Client reports the server exited immediately | `TRUEPPM_API_URL` or `TRUEPPM_API_TOKEN` is unset or blank. Check the `env` block. |
| Launch fails with "the TruePPM API rejected the configured token (HTTP 401)" | The token is missing, malformed, or revoked. Mint a fresh `mcp:read` token. |
| A tool returns a 404 for something you expect to see | Your role on that project or program does not permit reading it — 404 is the deliberate existence oracle, identical to the web client. |
| The `trueppm-mcp` command is not found | The install landed outside your client's `PATH`. Use an absolute path in `command`, or point it at the [Docker image](/administration/mcp-server/#docker). |
