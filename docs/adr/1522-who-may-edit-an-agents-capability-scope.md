# ADR-1522: Who may edit an agent's capability scope

## Status

Accepted (2026-11-27), #5111

> **Implementation status (2026-11-27, #5111):** the *decision* stands, and #4814
> shipped the OSS half: `can_manage` and the control writes in
> `packages/api/src/trueppm_api/apps/agents/control.py`, and the ceiling cap in
> `agent_scope.validate_grant` / `principal_ceiling` in
> `packages/api/src/trueppm_api/apps/projects/agent_scope.py`. The
> Enterprise scope-ceiling provider hook in Decision 4 is **not** built: no slot
> exists yet, because no Enterprise provider exists to register against it. The
> per-project `propose` intersection in Decision 5 waits on plan mode (#1813).

## Context

#4814 shipped the workspace Agents page. An *agent* is a controlled agent: an
owner-scoped API token that carries `mcp:read` and not the full scope
(`agent_scope.is_controlled_agent`). It acts for one person, its owner, the
*principal*. Its capability scope is one level per area (Schedule & tasks,
Dependencies, Resources, Baselines) on the ladder `none < read < propose < write`.

Who may change that scope was settled during #4814 and written down only in the
`agents/control.py` module docstring and the user docs
(`features/agent-oversight.md`). The #4814 enterprise-check asked for an ADR,
because this is the seam an Enterprise scope-ceiling provider would extend:
org-wide policy over what agents may do is governance, and governance is
Enterprise. An unrecorded rule is easy to widen by accident, and Enterprise
would have no stated contract to build on.

P3M layer: Programs and Projects (one person's agent, used on the projects that
person works on). The org policy over it is the Portfolio/Senior Leadership
layer and is Enterprise.

## Decision

1. **Who may edit.** Two people may pause, resume, edit the scope of, or revoke
   an agent: its **principal**, and a **workspace Admin** (workspace role ADMIN
   or above). No one else may. A project or program Admin may not, because an
   agent acts across every project its principal belongs to, and a project role
   says nothing about the other projects. `control.can_manage` is the one
   predicate, and every control endpoint uses it.

2. **Only from a signed-in session.** The control endpoints refuse every
   token-authenticated request, the agent's own included. An agent can never
   resume itself, widen its own scope, or act on another agent.

3. **Capped at the principal, whoever edits.** An edit is validated against the
   **principal's** ceiling (`agent_scope.principal_ceiling`), never the editor's.
   A workspace Admin editing Alice's agent cannot grant it more than Alice could
   do herself. Only an area the edit **raises** is checked against the ceiling.
   An area kept at, or lowered from, a stored level above the ceiling is
   accepted, so after a demotion anyone allowed to edit can still narrow the
   agent. The effective scope used on each call is the stored grant intersected
   with the principal's **current** ceiling (`effective_scope`), so a demotion
   narrows the agent on its next call whether or not anyone edits it. `write` is
   not grantable in 0.5. The server refuses it whatever the client sends.

   Each edit appends a `PERSON` row (`agent.scope_edit`) to the AgentAction hash
   chain in the same transaction. The row is in the principal's log and names
   the acting person. An Admin's edit is therefore visible to the principal and
   provable afterwards.

4. **The Enterprise seam is the ceiling, and it can only narrow.** An Enterprise
   build may register **one** scope-ceiling provider. When it lands, the slot
   will have this shape:

   - a single-provider hook in `agent_scope`, registered through
     `core.extension_providers.guard_single_provider` and called only through
     `invoke_extension_provider` (the #3866 containment rule, enforced by
     `scripts/check-extension-points.py`);
   - signature `(principal, token, project_id: UUID | None) -> dict[area, level] | None`.
     `project_id` is `None` for the workspace-wide ceiling used at edit time and
     for reads, and a project id for a per-project check (Decision 5). `None`
     means the provider has no opinion;
   - OSS **intersects** the returned ceiling with its own. A provider can lower
     an area and can never raise one, so no Enterprise policy can grant an agent
     more than its principal can do;
   - when the provider raises, the fallback is the OSS ceiling alone, and the
     failure is logged. That is the same containment as every other provider: an
     Enterprise bug cannot break the OSS read path. An Enterprise policy that
     must fail closed returns a narrow ceiling and does not raise.

   The seam covers **what** an agent may be granted, not **who** may grant it.
   Decision 1 is not an extension point. Letting an Enterprise custom role manage
   agents would need its own ADR.

5. **`propose` must intersect per project once plan mode ships.** The ceiling is
   workspace-wide today: the principal's highest role on any live project. That
   is enough to cap an edit. It is not enough to authorize a dry run. When plan
   mode (#1813) starts consuming `propose`, the effective level for a dry run on
   project P must be the grant intersected with the principal's role on **P**,
   and with the provider's ceiling for P. An Admin on project A must not preview
   Admin-only changes on project B, where they are a Member. #1813 owns that
   change, and `principal_ceiling`'s docstring records it at the code.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Principal only | Simplest. No one else can touch your agent. | An Admin cannot contain a misbehaving agent of someone who is away, which is the incident case. |
| Principal or workspace Admin, capped at the principal (chosen) | Admins can contain an agent. The cap means Admin rights never become a way to grant more than the principal holds. Every edit is chained. | An Admin can narrow or pause another person's agent without asking. Mitigated by the edit being named in the principal's own log. |
| Admin edits capped at the editor's own ceiling | Feels like ordinary delegation. | A workspace Admin's ceiling is everything, so the cap means nothing. The agent acts as the principal, so the principal's rights are the right bound. |
| Project/program Admins may manage agents active in their projects | Closer to the work. | An agent spans all of its principal's projects. A project Admin editing it changes what it can do on projects they do not run. |
| Enterprise provider may widen as well as narrow | More flexible policy. | Breaks the invariant that an agent never exceeds its principal, which the threat model on #4814 depends on. |

## Consequences

- Easier: Enterprise can add org policy ("no agent reads Resources") by
  registering one provider, with no OSS fork and no change to the control
  endpoints. The invariant "never above the principal" holds with or without it.
- Easier: an auditor can answer "who changed this agent's scope" from the chain
  alone.
- Harder: the ceiling has to be computed per principal on every agent call, and
  per project once #1813 lands. `principal_ceilings` batches it for list
  endpoints. A provider adds its own cost to that path.
- Risk: a failing provider falls back to the OSS ceiling, so an Enterprise policy
  lapses (logged) rather than blocking every agent. That is a deliberate choice
  for availability. A policy that needs fail-closed has to be written to return a
  narrow ceiling.

## Implementation Notes

- P3M layer: Programs and Projects (OSS); org policy over the ceiling is
  Portfolio (Enterprise).
- Affected packages: api (`agents/control.py`, `projects/agent_scope.py`), web
  (Agents page).
- Migration required: no.
- API changes: no. This records the rules behind the #4814 endpoints. The
  provider hook in Decision 4 adds no endpoint.
- OSS or Enterprise: the rules in Decisions 1-3 and 5 and the hook slot are OSS
  (`trueppm-suite`). A provider registered against the slot is Enterprise
  (`trueppm-enterprise`).

### Durable Execution

1. Broker-down behaviour: N/A. Scope edits are synchronous DB writes. The chain
   row is written in the same transaction, with no Celery dispatch.
2. Drain task: N/A.
3. Orphan window: N/A.
4. Service layer: `agents.control.edit_scope`, `pause`, `resume`, `revoke`.
5. API response on best-effort dispatch: synchronous.
6. Outbox cleanup: N/A.
7. Idempotency: an edit that changes nothing writes nothing (no chain row).
   Pause and resume are idempotent the same way.
8. Dead-letter / failure handling: N/A. A provider failure is contained by
   `invoke_extension_provider` and logged (Decision 4).
