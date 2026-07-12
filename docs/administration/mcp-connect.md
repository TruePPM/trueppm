# Connect your MCP client

This is the client-side companion to the [MCP server](./mcp-server.md) reference:
how to connect the three MCP clients most self-hosters reach for — **Claude
Desktop, Cursor, and Zed** — to your own TruePPM instance. Each connects the same
way: it spawns `trueppm-mcp` as a local subprocess (stdio) and passes your
instance URL and a read-only token through the environment.

> The read-only MCP server ships in 0.4, TruePPM's first beta. On unreleased
> builds the tool list and token-scope surface may still change.

## Step 1 — Mint a read-only token

The server authenticates with a **personal access token** (`tppm_<64-hex>`)
carrying the `mcp:read` scope. The read surface accepts **only owner-scoped
(personal) tokens** — a project- or program-scoped token is rejected here — so
mint the token from your personal settings, not the project Integrations page.

1. Open **Personal Settings → API tokens → Create token**.
2. Choose the **"Read-only for AI assistants"** scope (`mcp:read`). It grants
   safe-method (`GET`) access only and is rejected at every write path.
3. **Set an expiration date** — it is required for an `mcp:read` token, so a
   leaked read credential is self-limiting.
4. The reveal dialog shows the raw token **once** — copy it immediately. Only its
   SHA-256 digest is stored server-side.

The token acts as you and can read only what your role permits across the
projects and programs you belong to. The reveal dialog also offers a
ready-to-paste `claude_desktop_config.json` snippet — if you use Claude Desktop,
that is the fastest path.

## Step 2 — Add the server to your client

Every snippet points `trueppm-mcp` at your instance with two environment
variables:

| Variable | Description |
|----------|-------------|
| `TRUEPPM_API_URL` | Base URL of your instance, e.g. `https://ppm.example.com` (the `/api/v1` suffix is appended automatically if omitted). |
| `TRUEPPM_API_TOKEN` | The `tppm_<64-hex>` token from Step 1, with the `mcp:read` scope. |

Install the server first (or use the bundled Docker image):

```bash
pip install trueppm-mcp        # or: uv tool install trueppm-mcp
```

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

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

Restart Claude Desktop; it spawns `trueppm-mcp` on demand.

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

Reload Cursor and confirm the server shows as connected under **Settings → MCP**.

### Zed

Add a custom context server to Zed's `settings.json`:

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

Zed launches the server for the Agent Panel.

## Step 3 — Verify

Ask your assistant to run the `whoami` tool. It returns the identity behind your
token — a quick confirmation the URL, token, and scope are correct. On startup
the server also calls `GET /api/v1/auth/me/` once, so a bad token fails the
launch immediately with a clear message.

## What you can ask

The server exposes **18 read-only tools**, each mapping to one existing REST
endpoint and returning only what your role permits:

- **Projects & programs** — `list_projects`, `get_project`, `list_programs`,
  `get_program_health` (single-program only; cross-program rollups are Enterprise),
  `list_program_backlog` (a program's backlog intake pool; single-program only).
- **Tasks & work** — `list_tasks`, `get_task`, `get_board_state`, `list_my_work`.
- **Schedule & risk** — `get_schedule_summary`, `get_monte_carlo_forecast`
  (latest persisted run; read-only), `get_release_forecast` (velocity-based
  backlog delivery forecast — P50/P80 sprint counts and dates),
  `whatif` (perturb one task's duration and
  recompute in memory — "what breaks if this task slips?"),
  `get_schedule_derivation` (the *why* behind a
  computed CPM value or Monte Carlo percentile), `list_risks`.
- **Sprints** — `list_sprints`, `get_sprint` (aggregates and health bands only).
- **Identity** — `whoami`.

For the full per-tool reference and example prompts, see the
[MCP server feature page](../features/mcp-server.md) and the
[MCP server operator reference](./mcp-server.md).
