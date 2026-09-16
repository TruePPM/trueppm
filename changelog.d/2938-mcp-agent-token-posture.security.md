- **MCP agent-token posture is now visible and enforced at boot**: `GET /api/v1/auth/me/`
  now echoes the caller's own token scopes and whether it counts as an agent
  credential (`token: {scopes, is_agent} | null`). `trueppm-mcp` reads this at
  startup and refuses to boot on a `legacy:full` personal access token — a
  credential the operator's MCP kill switch and a team's agent read opt-out do
  not govern — instead of running unprotected. Mint an `mcp:read` token for
  `trueppm-mcp` instead.
