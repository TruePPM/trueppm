# ADR-0078: Team Entity (OSS)

## Status: Proposed (v3 — post-re-VoC, panel cleared 🔴 at 6.5/10 panel avg, 7.5/10 across the four critical reviewers)

## Context

TruePPM has no first-class concept of "team" in the data model. Two converging 0.3 requirements demand one:

1. **ADR-0077 (MCP server) §C.1 and §E** — `team_internals:read` scope requires per-team opt-in to address Morgan's hard NO on PMO sprint surveillance. Opt-in needs an entity to attach to.
2. **0.3 multi-team agile roadmap line** — projects running >1 Scrum team need to identify which team owns which sprint, backlog slice, and capacity plan.

Both point at the same shape: **the Scrum team that owns a sprint commitment.**

P3M layer: **Programs and Projects + Operations.** Project-scoped by every classification test (passes adoption-lens; teams organize a single project's execution; no governance overlay in OSS).

A first VoC pass (v1, all 8 personas) averaged 5.25/10 with a 🔴 from Morgan: project-Admin implicit team-Admin inheritance silently routed around the per-team opt-in consent model that the MCP ADR depended on. v2 incorporates that fix plus six other 🟡 lifts.

## Decision

### A. Team is project-scoped

A `Team` belongs to one `Project`. Same humans running a follow-up project create a new Team in that project. Membership is a subset of project members.

**Rationale (chosen over org-scoped):** adoption-lens (PM running one program doesn't need cross-project team persistence); no conflation with `Resource` (existing org-level capacity entity); OSS/Enterprise boundary stays clean; reversible forward (project→org is a migration; org→project is much harder).

**Enterprise reservation:** an `ENTERPRISE_TEAM_AGGREGATION` slot is reserved now (via ADR-0029 slot pattern) so cross-project Team rollup can register in Enterprise without an OSS schema change.

### B. Data model

New app `apps/teams/`:

```python
class Team(VersionedModel):
    id = UUIDField(primary_key=True, default=uuid4)
    project = ForeignKey(Project, CASCADE, related_name='teams')
    name = CharField(max_length=255)
    short_id = CharField(max_length=8)
    description = TextField(blank=True, default='')
    is_default = BooleanField(default=False, db_index=True)  # auto-created at migration; one per project
    created_by = ForeignKey(User, SET_NULL, null=True)
    created_at = DateTimeField(auto_now_add=True)
    updated_at = DateTimeField(auto_now=True)
    # server_version, is_deleted from VersionedModel

    class Meta:
        constraints = [
            UniqueConstraint(fields=['project', 'name'],
                             condition=Q(is_deleted=False),
                             name='team_name_per_project_unique'),
            UniqueConstraint(fields=['project'],
                             condition=Q(is_default=True),
                             name='team_one_default_per_project'),
        ]


class TeamMembership(VersionedModel):
    """Coordination authority (role) is one axis; facilitation/ownership (is_scrum_master,
    is_product_owner) is a separate axis. A user can be an admin who is also Scrum Master,
    or a member who is also Product Owner — these are independent facets."""
    id = UUIDField(primary_key=True, default=uuid4)
    team = ForeignKey(Team, CASCADE, related_name='memberships')
    user = ForeignKey(User, CASCADE, related_name='team_memberships')
    role = CharField(
        max_length=16,
        choices=[('member', 'Member'), ('admin', 'Admin')],
        default='member',
    )
    is_scrum_master = BooleanField(default=False)
    is_product_owner = BooleanField(default=False)
    created_at = DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            UniqueConstraint(fields=['team', 'user'],
                             condition=Q(is_deleted=False),
                             name='team_member_unique'),
            # Soft constraint: at most one Scrum Master and one Product Owner per team
            # enforced at serializer layer, not DB (allows transitional state during handoff)
        ]
```

**Sprint extension** (`apps/projects/models.py`):
```python
class Sprint(VersionedModel):
    # ... existing fields ...
    team = ForeignKey('teams.Team', SET_NULL, null=True, blank=True, related_name='sprints')
```
Nullable; existing sprints resolve through project default team (see §C).

**Task extension** (optional, for story→team routing — Jordan's gap):
```python
class Task(VersionedModel):
    # ... existing fields ...
    team = ForeignKey('teams.Team', SET_NULL, null=True, blank=True, related_name='tasks')
```
Nullable; serves as a hint for backlog grouping when ≥2 teams exist. When a task is moved into a sprint and `task.team` and `sprint.team` differ, a warning (not a hard reject) fires, the move proceeds with a reason field on the action, and a structured `TaskTeamMismatchEvent` is written to the sprint activity feed (not just a transient toast). Cross-team pairing/spillover is a real workflow; hard-rejecting would push PMs to bypass team tagging entirely.

### C. Default Team migration

One-way data migration (`apps/teams/migrations/0001_initial`):

1. Create tables.
2. For every existing `Project`, create one `Team` with `name='Default Team'`, `is_default=True`, `short_id='T01'`.
3. For every `ProjectMembership(project=P)`, create `TeamMembership(team=default_team_for_P, user=PM.user, role=...)` — `role='admin'` for project Admin (300+) and Owner (400) per ADR-0072; `role='member'` otherwise. `is_scrum_master` and `is_product_owner` both False at migration (no inference; explicit assignment required).
4. Existing sprints leave `team` null; runtime resolution: `sprint.team or sprint.project.teams.filter(is_default=True).first()`.

### D. Permissions — split by action sensitivity (Morgan 🔴 fix)

Project Admin (role 300+) inheritance is **split by action sensitivity**:

**Project Admin inherits team-Admin authority for** (coordination, low consent stakes):
- Rename / edit description
- Add / remove team members
- Create / soft-delete non-default teams
- Toggle Scrum Master / Product Owner facets

**Project Admin does NOT inherit team-Admin authority for** (consent-sensitive — requires explicit `TeamMembership(role='admin')` OR audited override):
- `TeamInternalsOptIn` toggle (the AI Assistant Access switch — load-bearing for ADR-0077's consent model)
- `Sprint.team` rebind on an active sprint
- Bulk membership replacement (>50% of members removed in one operation)

**Audited override path** for the consent-sensitive actions:
- Requires explicit `reason` field
- Emits a `Notification` (source_type='team_admin_override', detail={action, actor, reason}) to every team member, weighted higher for users with `is_scrum_master` or `is_product_owner` facets so override signal does not drown in feed noise
- Logged in team activity feed visible to all team members
- Override is rate-limited (≤ 1 per team per 24h) to prevent silent reuse
- **Per-team override ceiling**: each team can configure a `TeamPermissionSettings` row to disable project-Admin override entirely for `Sprint.team` rebind on active sprints. Default is "override allowed with notification"; teams may set "override prohibited" or "override requires acknowledge-or-revert window (0–24h)". Configurable by `IsTeamAdminExplicit`, not by project Admin. This makes the override a team-configurable ceiling, not a global default.

This makes "project Admin can override" a real, visible escape hatch rather than a silent default. It does not block emergency action, but it does make the action consensual-by-notification.

New permission classes:
- `IsTeamMember`, `IsTeamAdmin` — composable
- `IsTeamAdminExplicit` — requires actual `TeamMembership(role='admin')`, no inheritance. Used on `TeamInternalsOptIn` and `Sprint.team` rebind endpoints.
- Override path uses `IsTeamAdmin` (with inheritance) + `OverrideReasonRequired` (validation) + signal-driven notification + activity-log write.

### E. API

```
GET    /api/v1/projects/{project_id}/teams/
POST   /api/v1/projects/{project_id}/teams/
GET    /api/v1/teams/{team_id}/
PATCH  /api/v1/teams/{team_id}/                 # rename, description
DELETE /api/v1/teams/{team_id}/                 # default team cannot be deleted; soft-delete others
GET    /api/v1/teams/{team_id}/members/
POST   /api/v1/teams/{team_id}/members/
PATCH  /api/v1/teams/{team_id}/members/{user_id}/    # role/facet change
DELETE /api/v1/teams/{team_id}/members/{user_id}/
GET    /api/v1/teams/{team_id}/activity/             # activity feed (memberships, opt-ins, overrides)
GET    /api/v1/users/{user_id}/teams/                # David + Alex's reverse view; cross-project, read-only.
                                                     # Per row returns: team_id, project_id, role, is_scrum_master,
                                                     # is_product_owner, active_sprint_id (if any) — enabling a
                                                     # one-call "what am I facilitating right now across all teams" pivot
```

Sprint association via existing `PATCH /api/v1/sprints/{id}/` with `team` field. Story-team via `PATCH /api/v1/tasks/{id}/` with `team` field.

### F. Reporting contract — single-team invisibility

**Serializer rule:** when `project.teams.filter(is_deleted=False).count() == 1` (i.e., only the default team exists), the `team` field is **omitted entirely** from REST responses, CSV exports, PDF exports, and any portfolio/program rollup payload. The field reappears when a second team is created.

**Web rule:** Project Settings → Teams *tab itself* is conditionally rendered — hidden when count == 1; visible when count ≥ 2. (Web CLAUDE.md will record this as a numbered rule.) The following surfaces are also Team-agnostic when count == 1 (no picker, no team label, no team field): Sprint drawer's Team field, Task drawer's Team field, **mobile time-entry screen**, **WBS task-create dialog** (web + mobile), client PDF/CSV exports, and any portfolio/program rollup payload. Sprint and task inherit default team silently. Sarah's waterfall projects never encounter the concept.

**Auto-membership invariant** (Priya): a signal on `ProjectMembership.post_save` auto-creates/updates the corresponding `TeamMembership` on the project's default team. Permanent invariant, not a one-time migration. New project members never see a second "join the team" step. When a non-default team is soft-deleted, its members fall back to the default team's membership (no orphan state).

### G. Exec reporting commitment (Janet)

**Explicit contract:** No Janet-facing surface — portfolio rollup, RAG dashboard, board PDF, weekly digest, exec API endpoints — counts, groups, or displays Teams as an org-level metric in OSS. If Enterprise later adds an org-scoped `OrgTeam` aggregation via the slot reserved in §A, that becomes the only entity allowed in exec reporting.

Test: an exec-facing PDF for a portfolio of 40 projects must not contain "40 teams" or "Default Team" anywhere in its output. The single-team-invisibility rule (§F) plus the no-Team-in-portfolio-rollup commitment make this safe.

### H. UI (minimal in 0.3)

- Project Settings → Teams tab (only when count ≥ 2 per §F)
- Add / remove team; rename; manage membership; role + facet toggles
- AI Assistant Access toggle on each team's settings page (`TeamInternalsOptIn` surface, requires `IsTeamAdminExplicit`)
- Sprint drawer Team field (only when count ≥ 2)
- Task drawer Team field (only when count ≥ 2; optional)
- Team activity feed (visible to all members; shows membership changes, opt-in toggles, project-Admin overrides with reason)

Out of 0.3: standalone Teams nav surface, team-level dashboards, cross-project team aggregation (Enterprise).

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| Project-scoped Team (chosen) | Clean OSS boundary; no Resource conflation; matches adoption-lens; reversible | Same humans across N projects = N TeamMembership rows |
| Org-scoped Team | Persists across products; one row per real team | Conflates with Resource; enterprise-adjacent; hard to reverse |
| Per-sprint flag | No new model | Every sprint needs opt-in; no shared identity across sprints; insufficient for multi-team agile |
| Per-project flag | Smallest scope | Conflates teams sharing a project; insufficient for Morgan's hard NO |
| Project-Admin == team-Admin everywhere (v1 of this ADR) | Simple inheritance | Silently routes around per-team opt-in consent — Morgan 🔴 |

## Consequences

**Positive:**
- Unblocks MCP per-team opt-in with a real entity backing real consent.
- Unblocks 0.3 multi-team agile (one SM, two teams, distinct sprints).
- SM and PO are now first-class facets — Alex and Jordan can identify role-holders without conflating with project Admin authority.
- Story→team routing closes Jordan's "PM silently injects task into wrong team's sprint" hard NO.
- Single-team invisibility means waterfall projects (Sarah's world) see zero Team UI/data ever.
- Exec-reporting commitment (Janet) is contractual, not aspirational.
- Reversible toward org-scoped if Enterprise needs cross-project teams.

**Negative:**
- New app + new models + non-trivial migration. Estimate: 2 sprint weeks foundation + 1 UI.
- Permission model is more nuanced (split inheritance) — more places to test.
- Override path adds notification + activity-feed surfaces that must be built.
- Two TeamMembership rows for same humans on two projects (acceptable trade-off per §A).

**Risks:**
- Override path could become normalized rather than exceptional. Mitigation: rate-limit (≤ 1 per team per 24h); UI surfaces the action with a warning, not a casual button.
- Activity feed could become noisy. Mitigation: feed shows only membership changes, opt-in toggles, and overrides — not every CRUD action.
- Single-team-invisibility serializer rule must be tested across every export path. Mitigation: integration test that diffs API responses with team_count=1 vs team_count=2.

## Implementation Notes

- **P3M layer**: Programs and Projects + Operations
- **Affected packages**: api (new `apps/teams/`), web (Project Settings → Teams UI, sprint/task drawer team fields, activity feed)
- **Migration required**: yes — additive data migration creating default teams + memberships
- **API changes**: yes — new endpoints under `/teams/`; `Sprint.team`, `Task.team` additions
- **OSS or Enterprise**: **OSS**

### Durable Execution

1. **Broker-down behaviour**: N/A — Team CRUD is synchronous. The first-use-MCP-notification (per ADR-0077 §E) goes through the notification dispatch service, which already follows the outbox pattern per ADR-0075. Override notifications use the same path.
2. **Drain task**: N/A — reuses notification drain from ADR-0075.
3. **Orphan window**: N/A — no new outbox rows.
4. **Service layer**: `apps/teams/services.py` for `create_default_team_for_project()`, `resolve_team(sprint)`, `transfer_membership_on_delete()`, `execute_project_admin_override(actor, action, reason, **kwargs)` (validates, writes activity-log row, dispatches notification).
5. **API response on best-effort dispatch**: N/A — synchronous.
6. **Outbox cleanup**: N/A.
7. **Idempotency**: Team creation keyed on `(project_id, name)` unique constraint. Default-team migration uses `get_or_create(project, is_default=True)`. Auto-membership signal uses `get_or_create(team=default, user=...)`.
8. **Dead-letter / failure handling**: N/A — synchronous; notification dispatch failures handled by the existing notification surface.

## VoC v1 → v2 movement (expected)

v1 panel surfaced one 🔴 (Morgan) and six 🟡 fix categories. v2 incorporates all of them. Expected v2 movement, before re-VoC validates:

- Morgan 4 → 7+: split inheritance + override audit + activity feed addresses sprint-sovereignty hard NO
- Jordan 4 → 7: PO facet + story→team routing addresses backlog ownership + silent-inject hard NOs
- Alex 5 → 7+: SM facet + sprint→team binding addresses team-internals ownership
- Sarah 7 → 8: tab-level suppression + serializer-level invisibility means truly zero Team surface for single-team projects
- Marcus 6 → 7: API/export-layer invisibility addresses portfolio-pollution concern
- Janet 5 → 6: explicit exec-reporting commitment in §G
- David 5 → 6: §E adds `/users/{id}/teams/` reverse view
- Priya 6 → 7: auto-membership-as-invariant + tab suppression

Targeted re-VoC: Morgan, Jordan, Alex, Sarah (the four whose scores would move most).

## References

- ADR-0029 — Slot registry (path for Enterprise org-level Team aggregation, slot reserved per §A)
- ADR-0061 — Project Members Management UI (pattern reused for Team Members)
- ADR-0068 — Project API tokens (extended in ApiToken-scopes prereq)
- ADR-0070 — Program Entity (OSS) (project-grouping entity precedent)
- ADR-0072 — Role Ordinals (300+ = Admin inheritance, split per §D)
- ADR-0075 — Notification surface (notification + activity-feed reuse)
- ADR-0077 — MCP Server Scope (primary driver)
- `CLAUDE.md` — OSS/Enterprise boundary

## Tracking

Tracking: #599 (open, milestone 0.6) — Team entity (OSS), prerequisite for MCP
per-team opt-in.
