# ADR-1460: Workspace capability toggles — hide-only areas, with Agents bound to MCP consent

## Status

Proposed (2026-11-22)

> **Implementation status (2026-11-22):** design only. Verified on `main`: there is no
> capability model or field. `Workspace` (`apps/workspace/models.py`) carries
> `mcp_enabled` (ADR-0678), which this ADR reuses. Nothing else here exists.

## Context

Layer: **Programs and Projects** (workspace-scoped presentation in a single-team install), so this is **OSS** (#4888).

A workspace admin wants to hide whole domain areas (Agile, Resources, Time & cost, Agents) for everyone. The Pass 4 design (canvas section 1) settled several things:
- Everything is on by default.
- Turning an area off hides it and keeps its data.
- A deep link into an off area renders an explained page, not a 404.
- For Agile, Resources and Time & cost, the toggle is **not a security boundary** (decision Q1.1a, 2026-11-22). Roles still decide access, and the API keeps working.
- **Agents is enforced** (decision 2026-11-22, threat-model D1). Until #1063 introduces agent actor kinds, it refuses **all** MCP tokens.

Existing ADRs constrain the shape:
- **ADR-0162** and **ADR-0139:** presentation-level hiding never changes RBAC or what is fetched. The three hide-only areas follow this.
- **ADR-0193** and **ADR-0107:** per-project surface hides are nullable tri-state inherit columns. Capabilities sit *above* them, so a workspace-off area is off for every project regardless of the project columns.
- **ADR-0678** and **ADR-0497:** MCP read consent is already enforced fail-closed. The AND cascade runs instance switch ∧ `Workspace.mcp_enabled` ∧ program ∧ project, and human JWT and session requests always pass. Today the only agent actor kind is `MCP_TOKEN` (`agents/models.py`). That is exactly the D1 semantics.

## Decision

1. **Three hide-only capabilities** (`agile`, `resources`, `time_cost`) are new non-null boolean columns on the `Workspace` singleton. They default to true, with `db_default=True` so a rolling update is safe (migration rule 8). There is no new model and no per-project override in 0.5. ADR-0193's project columns keep working beneath them as an AND.
   - The server exposes them as `capabilities[]` on `GET /workspace/`, each as `{key, enabled, enforced, changed_by, changed_at}`.
   - Their only effects are web navigation and route guards, ⌘K results, notification-row visibility, and the explained `AreaOff` page.
   - API endpoints are unaffected.
2. **The Agents capability *is* `Workspace.mcp_enabled`.** It is the same column, surfaced as `capabilities[key=agents]` with `enforced: true`. It gets no new middleware and no new enforcement point. The ADR-0497/0678 guard (`McpReadableViewMixin.mcp_token_guards`, `McpScope`) is the enforcement, and it already fails closed for every MCP token and leaves human sessions alone.
   - Turning Agents off also hides the Agents area and agent alerts.
   - When #1063 adds agent actor kinds, *Agents off* narrows to refusing those actors. Whether a person's own `mcp:read` token should then keep working becomes a #1063 decision, recorded there.
   - Because ADR-0678 is restrictive-only, nothing here may let a toggle **grant** MCP back over a program or project denial.
3. **Writes:**
   - `PATCH /workspace/` capability fields require `IsWorkspaceAdminStrict`. `IsOrgAdmin` is self-grantable through project creation and is not acceptable.
   - Turning off an area with data requires the client to echo the server's counts timestamp, so the confirm step can't be skipped.
   - Turning off `agile` while a sprint is active requires `confirm_text`, and the response lists the POs and SMs who were notified (canvas 1A pin 7).
   - Every change writes a workspace `AuditEvent` and emits `capabilities.changed` (webhook and WS, ID-level payload).
4. **Fail open for hide-only areas, fail closed for Agents.** If the capability read fails, the web renders hidden areas normally (cosmetic). MCP denial stays fail-closed per ADR-0497.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| A new `WorkspaceCapability` table keyed by name (the handoff doc's first draft) | Open-ended set | The set is deliberately fixed. A table invites growth and needs a missing-row-means-on rule. Columns are what `Workspace` already does. |
| A new Agents middleware gate | Covers non-MCP token paths too | It duplicates ADR-0497/0678 and creates a second, divergent enforcement point. Non-MCP (`legacy:full`) token governance is #2749, a different question. |
| Enforce all four capabilities at the API | One rule | It contradicts ADR-0162 and Q1.1a. Hiding becomes an authorization boundary, so a cosmetic setting breaks integrations. |
| Per-project or per-program overrides | Fine-grained | It doubles the matrix (Q1.2). ADR-0193 already covers per-project surfaces. |

## Consequences

- Easier: one switch per area with a server fact behind it. The Agents switch is honest, because it is the existing consent control.
- Harder: the web must thread capability state through navigation, ⌘K and the notification matrix UI, all fed by one server field.
- Risks:
  - Admins may read the three hide-only toggles as access control. The UI banner and docs must say they are not (VoC round 2, Marcus and Nadia).
  - *Agents off* also stops a person's own MCP tokens until #1063. That is deliberate and stated in the UI.

## Implementation Notes

- P3M layer: Programs and Projects (workspace scope, single team).
- Affected packages: api, web, docs. Not mcp: the server needs no change, because the guard already exists.
- Migration: yes. Three `AddField` with `db_default=True`.
- API changes: yes. `capabilities[]` on `GET /workspace/`, the PATCH fields, and the `capabilities.changed` event.
- OSS.

### Durable Execution
1. Broker-down behavior: the `capabilities.changed` webhook goes through the existing webhook outbox. The sprint-owner notices go through the notification outbox.
2. Drain task: reuses the webhook and notification drains, whose semantics match.
3. Orphan window: the existing 5 minutes for webhooks.
4. Service layer: new `workspace/services.py::set_capability()`.
5. API response: synchronous 200, because the toggle write is local. Events are best-effort through the outbox.
6. Outbox cleanup: existing purges.
7. Idempotency: PATCH is idempotent by value. `IdempotencyMixin` already applies to `WorkspaceSettingsView`.
8. Dead-letter: existing webhook dead-letter handling.

### AI-review amendments (2026-11-22)
- **Write safety:** capability writes, including `mcp_enabled`, require `IsWorkspaceAdminStrict` **and** `IsNotTokenAuthenticated`, so no token can turn Agents back on, which would be a self-unlock. A refused token write records an `AgentAction` (verdict `refused`, reason `policy`).
- **MCP:** a `get_workspace_capabilities` read tool, for the three hide-only areas. When Agents is off, MCP itself is refused, which is the point.
- **Decision memory:** a toggle change carries an optional `reason`, stored on the `AuditEvent` and fed to the #1059 decision store once that lands.

### Enterprise-check (2026-11-22)
**OSS.**
- A per-workspace toggle that a self-hoster flips is OSS (#4888 edition note). Forcing toggles across workspaces by org policy would be Enterprise, and is out of scope.
- *Agents = `mcp_enabled`* reuses ADR-0678's consent control, which is OSS by design: there is deliberately no enforcement-provider seam, and the only org lever is turning MCP off at the workspace scope.
- Rule 231 check of the Pass 4 frames: **0** Enterprise affordances appear in rendered UI. The word appears only in spec and notes text.

### On Acceptance
- [ ] `python3 scripts/adr-accepted-issue-sweep.py --adr 1460`, and record the count (#4888 at least).
- [ ] Rewrite any issue carrying pre-ADR scope, title and body, with a dated correction note.
