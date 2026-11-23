# Pass 4 — API and operations delta (architect handoff)

> **Superseded in part by ADR-1460…1465 (2026-11-22, Proposed).** Where this handoff and an ADR differ, the ADR wins. Architect research corrected these points:
> - **Agents** is the existing `Workspace.mcp_enabled` (ADR-0678/0497), already enforced fail-closed. There is no new middleware and no `WorkspaceCapability` table: the three hide-only areas are `Workspace` columns ([ADR-1460](../../../adr/1460-workspace-capability-toggles.md)).
> - **Pools:** `CapacityPool` is program-scoped in OSS ([ADR-1461](../../../adr/1461-capacity-pools-and-resourcing-asks.md)).
> - **Expenses** answer ADR-1324's #2557 deferral and have no currency field. The rate grant reuses ADR-1324's endpoint and audit ([ADR-1462](../../../adr/1462-non-labor-expenses-and-rate-editor-grant.md)).
> - **Push:** [ADR-1463](../../../adr/1463-web-push-via-notification-matrix.md).
> - **Health:** “ADR-0133” in this doc is wrong. ADR-0133 is about task capabilities, and the health rule has no ADR of its own. The derived band thresholds the existing `p80_delta_vs_commitment_days` ([ADR-1464](../../../adr/1464-health-band-derived-from-p80-vs-commitment.md)).
> - **Workspace health:** enterprise-check (2026-11-22) removed even the counts. A cross-program count is Enterprise under the #3901 ruling, so the `counts{…}` in §2.5 and the decisions table is **not** OSS.
> - **Offline:** updates replay through `PATCH` with `X-Base-Version` (ADR-0217 merge), not a new `tasks/bulk` precondition; only creates and links go through `tasks/bulk`. The queue TTL is **72 h**, not 7 days ([ADR-1465](../../../adr/1465-web-offline-schedule-outbox.md)).
> - **VoC round 3 (2026-11-22, simulated panel, not user research)** added these to the ADRs:
>   - a project's own optional `commitment_date`, plus batch reconfirm (ADR-1464);
>   - an acknowledgment step for assignments into an active sprint, webhooks for ask transitions, and inert agent drafts (ADR-1461);
>   - push delivery metrics and an alert, plus coalesced `agent_refused` (ADR-1463);
>   - a visible refused-token count (ADR-1460);
>   - Retry all and Discard all for the outbox (ADR-1465).
>   §2–§8 below are updated to match (2026-11-23).
> - **Enterprise counterparts:** trueppm-enterprise#208 (cross-program pools), #209 (multi-step ask approval), #210 (workspace and portfolio health summary).

**Source design:** Claude Design canvas "TruePPM Redesign — Pass 4"
(https://claude.ai/artifact/J42mduLLSusGEmuGakkw6e), sections 1–8, as revised 2026-11-22.
**Status:** proposal for `architect`. Nothing here is built. Where this doc and an accepted
ADR disagree, the ADR wins until superseded.
**Why this exists:** a simulated persona panel (round 2, sheet 8B) raised blockers that
belong in the API and operations contract, not in frames:
- Nadia: no events, and the `enforced` flag only proposed.
- Omar: no operational delta.
- Theo: no provenance and no MCP parity.

This document answers those findings on their merits. It is not customer feedback.

Decisions already taken (2026-11-22) that this doc assumes:

| Decision | Effect |
|---|---|
| Q1.1a | Capability toggles hide UI only. The API keeps reads and writes working. |
| Agents enforced | **Agents** is the one enforced capability. When off, the server refuses agent-actor tokens. |
| Q2.1, Q2.2 | Asks go to a **pool**. Covered tasks are required. Approval **assigns** people to those tasks. |
| Q3.1 | Rates: workspace admins see and edit all. Project Owners and Admins see totals only. Rate-editor grantees see and edit their pools. Everyone else gets the field omitted. |
| Health | The band is **P80 vs commitment**. The PM override is kept and labeled. Worst-child rollup stops at Program. Workspace shows **counts only** *(superseded: no Workspace health or counts in OSS, ADR-1464)*. This supersedes ADR-0133's derived rule. |
| Push | Push rides the **existing** notification preference matrix (#2132). See §4: it is the matrix's existing `mobile_push` column. |

---

## 1. Data model (all additive, expand-only)

| Model | App (layer) | Fields (summary) | Notes |
|---|---|---|---|
| `WorkspaceCapability` *(superseded: three `Workspace` columns plus `mcp_enabled`, ADR-1460)* | `workspace` (core) | `key` ∈ {agile, resources, time_cost, agents}, `enabled`, `changed_by`, `changed_at` | A missing row means enabled. That gives existing installs default-on with no data migration. |
| `CapacityPool` | `resources` (core) | `name`, `program` (FK, required in OSS), `managers` (M2M User), `members` (M2M Resource) | **New concept** (ADR-1461). It avoids the name `resource_pool`, which is the per-project roster. It is scoped to one program; pools spanning programs are an Enterprise hook (enterprise-check ran 2026-11-22). |
| `ResourceAsk` | `resources` | `pool`, `project`, `role`, `count`, `units`, `start`, `duration_wd`, `covered_tasks` (M2M Task, ≥1), `note`, `state` ∈ {draft, sent, seen, approved, approved_pending_sprint_ack, countered, declined, withdrawn}, `requested_by`, `actor_kind` (human/agent), `decided_by`, `decided_at`, `decline_constraint` (JSON: name, value, limit, window, found_by, confirmed_by) | `draft` exists for agent-authored asks, and only a human sends. State transitions are server-enforced. |
| `AskOfferLine` | `resources` | `ask`, `resource`, `units`, `start`, `end`, `task` (nullable FK) | Counter-offer lines carry a proposed person→task mapping (Q2.9). |
| `AskEvent` | `resources` | `ask`, `from_state`, `to_state`, `actor`, `at`, `run_id` (nullable) | Backs the status trail. Append-only. |
| `Expense` | `projects` (core) | `project`, `category` ∈ {rental, cloud, license, agent_tokens, travel, other}, `kind` ∈ {one_time, recurring}, `amount` (Decimal; in `Workspace.currency`, with no currency field — ADR-1462), `date` or `start` / `end` / `cadence`, `task` (nullable), `note` | Occurrences are **computed**, never stored (to-date and planned are server facts). |
| `RateEditorGrant` | `access` (core) | `user`, `scope_all` (bool), `pools` (M2M), `granted_by`, `granted_at` | A grant, not a role. The 5-role matrix is unchanged. Changes go to workspace history. |
| `PushSubscription` | `notifications` (core) | `user`, `endpoint`, `p256dh`, `auth`, `label` (UA summary), `created_at`, `last_delivered_at`, `failed_count` | Deleted on logout, on a 404/410 from the push service, and when the device is removed. |
| `ImportReport` | `msproject` (satellite) | `project`, `source_name`, `created_by`, `rows` (JSON: task, constraint, date, outcome kept/converted/deadline/dropped), `dismissed_at` | Backs the 7B review and the Plan chip. Exportable as CSV. |
| `Project.health_reported_at` | `projects` | DateTimeField, nullable | Needed for override age and reconfirmation (Q5.8). |
| `Project.health_report_note` | `projects` | TextField, blank | An optional note on a PM override (ADR-1464, AI-review). |
| `Project.commitment_date` | `projects` | DateField, nullable | The project's own commitment, used after the active baseline and before the program target (ADR-1464). |

Migration rules (CLAUDE.md, Migration discipline):
- Every operation is `CreateModel` or a nullable `AddField`. There is **no `RemoveField`** and no constraint on a populated table in 0.5, so rules 7 and 8 do not trigger.
- One migration per app per feature.
- Old pods tolerate the new tables, because nothing they run reads them. That is the rolling-update compatibility statement Omar asked for.
- `VersionedModel` / `server_version`: `ResourceAsk` and `Expense` are user-visible project data. Decide whether they join the sync protocol. Recommended: not in 0.5, because the offline queue in §6 covers schedule structure only.

## 2. API surface

All new endpoints go through `rbac-check`, `security-review` and `api-docs`. Every number is server-computed.

### 2.1 Capabilities
- `GET /workspace/` gains `capabilities: [{key, enabled, enforced, changed_by, changed_at}]`.
  - `enforced` is **required** on every entry: `true` only for `agents`.
- Capability fields are written through `PATCH /workspace/` (Agents is the existing `mcp_enabled` field). Writes need `IsWorkspaceAdminStrict` **and** a human session (ADR-1460).
  - With data present, the request must carry `confirm_counts_seen_at`, so the UI can't skip the confirm step.
  - Turning off `agile` with an active sprint requires `confirm_text: "AGILE"`. The server returns the list of notified POs and SMs.
- *(Superseded: Agents reuses the existing fail-closed `mcp_enabled` enforcement, ADR-1460.)* **Agents enforcement is middleware, not a DRF default permission class.** A gate added to `DEFAULT_PERMISSION_CLASSES` is silently inert, because most views override it.
  - When `agents` is off, any request authenticated as an agent actor (ADR-0112) gets a 403 with `{"code": "capability_off", "capability": "agents"}`.
  - **Until #1063** introduces agent actor kinds, every MCP token is refused (threat-model D1, decided 2026-11-22), because today's only actor kind, `MCP_TOKEN`, is a person's own token. After #1063, only agent actors are refused.

### 2.2 Pools, asks, outcomes
- `/capacity-pools/` CRUD (workspace admin), and `/capacity-pools/{id}/load/?from=&to=`.
  - Per-person weekly load, **plus pending-ask holds**: `holds: [{week, asked_fte, free_fte, asks: [id]}]`.
  - Holds never count as bookings.
- `/resource-asks/`:
  - `POST` creates the ask. An agent actor's ask is forced to `state=draft`, and only a human can send it. A draft is inert: no hold, no queue entry, no notice.
  - `covered_tasks` takes a list, and the web offers multi-select plus "all leaves under a summary task".
  - `POST /resource-asks/preview/` is **non-mutating**. It returns the allocation-check fit and the what-if impact (`metrics[{label, from, to}]`, `run_id`, `_provenance`).
- Transitions are plain POSTs: `/send`, `/approve`, `/counter`, `/accept-counter`, `/decline`, `/withdraw`.
  - `seen` is set server-side the first time a pool manager reads the ask.
  - `/decline` **requires** `decline_constraint`, prefilled from the server's own allocation check.
  - Batch: `POST /resource-asks/batch-approve/ {ids}` approves only asks whose current fit is `fits` and refuses the rest per item. Partial success uses 207 or a per-id result list.
- `/approve` and `/accept-counter`, in one transaction:
  - create the task assignments, **except** for covered tasks in an active sprint. Those wait in `approved_pending_sprint_ack` until the sprint's PO or SM calls `/acknowledge-sprint` or `/decline-sprint` (with a reason). Nothing applies on a timeout, and there is a reminder after 2 working days (ADR-1461);
  - write an `AskEvent`;
  - enqueue the CPM recompute through the outbox. `transaction.on_commit` never dispatches Celery without an outbox row, and `make on-commit-durability-check` applies.
- `GET /resource-asks/{id}/outcome/` returns:
  - `kind` (change or refusal), `run_id`, `metrics`, and `chain[{task_id, text}]`;
  - `sprint_impacts[{sprint_id, task_ids, notified: [user], ack_state}]`, so 2C's "Waiting on Sprint 14 · 2 tasks" is a server fact;
  - `earliest_fit_date` on a refusal.

### 2.3 Cost
- `/projects/{id}/expenses/` CRUD.
  - Responses include computed `to_date` and `planned`. The cost summary gains `expenses_to_date` and `expenses_at_completion`.
- `cost_rate` on `Resource` is **optional in the schema**, and absent for callers without visibility. **No `bill_rate`** (ADR-1462, Q3.7).
  - Document this as optional, because the e2e schema guard doesn't enforce `missing-required`, so a typed client would otherwise break silently.
- `/grants/rate-editor/` CRUD, workspace admin only.
- Expense and grant writes are human-only (`IsNotTokenAuthenticated`) in 0.5. Expense amounts are readable by project Admin and Owner. `?explain=1` lists the occurrences behind a total.

### 2.4 Push (#2132)
- `/me/push-subscriptions/` supports `GET`, `POST` and `DELETE`.
- Delivery rides the existing per-project matrix (`PROJECT_NOTIFICATION_DEFAULT_MATRIX`), which already has a `MOBILE_PUSH` column.
  - That column is listed in `PROJECT_NOTIFICATION_UNDELIVERABLE_CHANNELS` today (TODO #3252).
  - Shipping push means **removing `MOBILE_PUSH` from the undeliverable set in the same change that wires delivery**, and keeping the column's default OFF.
  - Contributors therefore start quiet. Only rows with a dispatcher (#3016) can deliver at all.
- New matrix rows are needed: `agent_refused`, `resource_ask_received`, `resource_ask_decided`, `sprint_changed_externally`. Each ships OFF in every channel except in-app, until its dispatcher lands.
- Existing quiet hours (`quiet_hours_enabled`, default 20:00–07:00) apply to push.
- `agent_refused` is coalesced: the first refusal per token in 15 minutes pushes, and later ones update the same notification with a count.
- **Lock screen:** a per-user "Show details on lock screen" setting (default on). Helm `push.lockScreenDetails: minimal` forces minimal.
- **Subscriptions:** the endpoint host must be on an allowlist (FCM, Mozilla, Apple, Windows, extendable in Helm). It must be HTTPS and must not resolve to a private IP. Subscription writes are human-only.

### 2.5 Health
- `health_band` keeps its name and values (`on_track`, `at_risk`, `critical`), plus `not_computable` with `health_reason`.
- New fields:
  - `band_basis` ∈ {p80_vs_commitment, float_counts}, always present;
  - `engine_band` (the computed band, even when a PM report overrides it);
  - `health_reported_at`, and an optional `health_report_note` on the override;
  - `derivation{basis, p80, commitment_date, commitment_source, delta, mc_run_id, as_of}`.
- **Commitment sources, in order:** active baseline → new `Project.commitment_date` (`project_target`) → program `target_date`. A ⊘ "no commitment" badge offers Set commitment.
- `health_band` is documented as an **open enum**.
- `POST /projects/reconfirm-health/ {ids}` batch-reconfirms PM overrides, with a result per ID.
- `health_band_source` ∈ {reported, derived} is kept.
- `?health_basis=float_counts` returns the old derivation for **one minor release**, with `Deprecation` and `Sunset` headers and a changelog `changed` fragment that names the removal version.
- Program rollup: `derivation{rule: "worst_child", driver_project, total, computable, reported}`.
- Workspace *(superseded: not OSS, ADR-1464)*: `counts{on_track, at_risk, critical, not_computable}`. **No workspace band field** (the #3901 ruling). #3901 gets a superseding note.
- Decided in ADR-1464. There was no earlier ADR for the derived rule.

### 2.6 Offline replay (web)
- Creates and links replay through the existing `tasks/bulk` endpoint with `Idempotency-Key` and client IDs (ADR-0772). Updates and reparents replay through `PATCH /tasks/{id}/` with `X-Base-Version` (ADR-1465).
- **Conflict contract:** the existing ADR-0217 409 `MergeConflict` body, not a new one. Values and names appear only if the caller can read them. The body carries `run_id`.
- Refusals return 422 with `{"code", "reason"}`.
- Idempotency retention stays **24 h**, because `X-Base-Version` is the overwrite guard (D2). Entries older than 72 h show "✕ Expired — not sent", and the review sheet offers Retry all and Discard all. Delete is never queued.
- An agent token may never replay a human's queue. The queue is bound to the session user.

### 2.7 Constraints (0.5)
- There is no schema change. `planned_start` stays SNET, and `Task.deadline` stays the soft deadline (#690).
- The task detail exposes the engine derivation's binding contribution as `start_driver: {kind: "constraint" | "predecessor" | "data_date" | "project_start", ref, date}`. The source is `trueppm_scheduler.derive`'s `is_binding`. The UI never infers it.
- `GET /projects/{id}/import-reports/` (with CSV export) and `POST /msproject/preview/`, a dry run returning the date comparison before commit.
- The `constraint_type` enum arrives in 0.6 (#1441, ADR-1049).

## 3. Events

| Event | Webhook | WS | Notes |
|---|---|---|---|
| `resource_ask.transitioned` | new | new | Signed webhook as well as WS. Payload: `ask_id` and the new state, IDs only (ADR-1461). No note text. |
| `expense.created` / `.updated` / `.deleted` | new | new | Payload: IDs only (`expense_id`, `project_id`), never amounts (ADR-1462). |
| `capabilities.changed` | new | new | `key`, `enabled`, `enforced`, `changed_by`. |
| `task.assigned` | **exists** (`WebhookEventType.TASK_ASSIGNED`) | exists | Approvals already surface here, if they go through the same assignment service. Assert this in a test. |
| `sprint.scope_changed` | **exists** (#1073) | exists | Must fire when an **acknowledged** ask assignment lands in an active sprint. The ack or decline is the trail entry in 2C. |

New WS event names must be added to `FROZEN_WS_EVENT_TYPES` and pass `docs:ws-event-reachability`: each must fan out on a group a client can join.

## 4. Token scopes and agent rules
- New scopes: `asks:read`, `asks:write` (drafts only for agents), `expenses:read` and `rates:read`. There is no `capabilities:admin` scope: capability writes are human-only (ADR-1460). `expenses:write` and `rates:write` are **not issuable in 0.5**, because those writes are human-only (ADR-1462); they are reserved for the 0.6 agent-write gate (ADR-0112).
  - `rates:*` also requires the grant or workspace admin, intersected with the token owner's role (RC5).
- Agent actors:
  - can draft asks only;
  - can never send, approve, counter, decline or batch-approve (refusals are recorded as `AgentAction` rows);
  - get dry-run verdicts only in 0.5 (#1813);
  - are refused everywhere when `agents` is off.
- Every agent action is recorded through `agent_action_recorded` with `on_behalf_of`.
- `_provenance` (engine version, `run_id`, inputs) is stamped on these derived values: `health_band` / `engine_band`, the program derivation, ask preview and outcome, `start_driver`, the import dry run, and the offline conflict explanation.
- **MCP parity:** every fact above is reachable as an MCP tool in the same release (`trueppm-mcp`). That is the read-only server, so the write paths stay API-only.

## 5. Operations delta (Helm, workers, runbooks)

| Area | Change |
|---|---|
| Migrations | Expand-only, as in §1. The upgrade note states that old pods are compatible. There is no destructive step in 0.5. |
| Recompute after approval | Goes through the outbox into a Celery task tracked by `taskruns`. Adds a queue-depth metric and a dead-letter alert, as for existing recomputes. The ask outcome endpoint reports `recompute: pending|done|failed`, so a stuck run is visible in the UI and not silent. |
| Push metrics | `trueppm_push_deliveries_recent{outcome}`, `trueppm_push_dead_letter_parked`, `trueppm_push_subscriptions_disabled` and `trueppm_push_relay_responses_recent{status_class}`, plus a `PushDeadLetterGrowing` rule in `prometheusrule.yaml` (the ADR-0084 pattern). There is also `trueppm_mcp_refusals_recent{constraint}` for Agents-off refusals. |
| Push | `push.enabled: false` by default in `values.yaml`, so a default install makes **zero** outbound push calls. When enabled, VAPID keys come from `push.vapid.existingSecret`, or are chart-generated with `lookup` so `helm upgrade` never rotates them. Document the egress hostnames (FCM, Mozilla autopush, Apple push) with a NetworkPolicy example. The VAPID secret is listed in the backup runbook. |
| Service worker | It is shared by the PWA install, push and the offline outbox. It is versioned with the web image and respects the ADR-1249 previous-asset window. The server sends a kill-switch header that unregisters it. The outbox stamps an API contract version and refuses to replay across an incompatible change. Queued edits are kept per user per device, purged on sign-out and user switch, and expire after 72 h (ADR-1465). There is no "encrypted at rest" claim. Each release's upgrade notes say what happens to queued edits. |
| Capability defaults | `workspace.defaultCapabilities` in Helm values seeds new workspaces. Whether values can **pin** a capability that the UI can't widen is open (Q1-ops). |
| Sizing | Asks and expenses are small tables. Expense occurrences are computed, not stored. Push fan-out adds worker load in proportion to subscribed devices × events, with a sizing note in `administration/sizing.md`. |
| Backup | The new tables are covered by the logical backup. The only new secret is VAPID. |

## 6. Gates this triggers (CLAUDE.md)

`threat-model` has run: [THREAT-MODEL.md](THREAT-MODEL.md). Its decisions D1–D6 amend this doc where they conflict. In particular:
- §2.1 Agents enforcement can't tell agent from human until #1063 lands.
- §2.6 replay needs `server_version` preconditions, because idempotency keys live 24 h. *(Resolved: `X-Base-Version` on PATCH, ADR-1465.)*
- §2.4 push endpoints need a host allowlist (SSRF).
- `threat-model` before `architect`:
  - Agents enforcement (a new authorization boundary);
  - Web Push (new egress, plus a subscription ingress);
  - the pool and ask approval path (who may assign whom);
  - the offline outbox (client-held writes).
- `enterprise-check`:
  - pools spanning programs (Q2.3) *(ran 2026-11-22: one program in OSS, plus an Enterprise hook; ADR-1461)*;
  - the Rate editor grant vs custom roles (Q3.8) *(ran 2026-11-22: OSS, as one fixed grant; ADR-1462)*;
  - Workspace counts (#3901 ruling). *(Superseded: counts are Enterprise, trueppm-enterprise#210.)*
- `ai-review`: every new computed value and mutation in §2.
- `migration-check`, `broadcast-check` (ask and expense writes are board-scoped), `api-docs`, `rbac-check`, `security-review`.
- Docs: `administration/` pages for capabilities, push (Helm values, egress, VAPID) and the rate-editor grant. Each has a `documentedFor: "0.5"` and a `Ships in 0.5` callout until 0.5 ships.

## 7. Open questions

**Resolved (ADRs 1460–1465 unless noted, 2026-11-22):**
- Q1.8: until #1063, every MCP token counts as an agent actor (D1).
- Q1.9: sprint owners get a notice, plus a typed confirm.
- Q2.3: pools belong to one program.
- Q5.7: one minor release.
- Q5.8: 14-day reconfirm, batchable.
- Q6.1: yes, from the TS worker.
- Q6.5: claim dropped.
- Q7.5: `start_driver` comes from the engine derivation's `is_binding` (§2.7 of this handoff, built on ADR-0218; not an ADR-146x decision).
- Q2.9: the counter-offer line carries a proposed `task` (`AskOfferLine`, ADR-1461).
- Q3.2: accepted for 0.5, with no suppression (ADR-1462 consequences).
- Q3.3: deferred to 0.6 (ADR-1462).
- Q3.4 and Q5.2: deferred (single workspace currency; thresholds are module constants).
- Also decided, not otherwise listed: Q3.6 and Q3.7 (ADR-1462); Q6.3 and Q6.4 (ADR-1465).

**Still open (from the canvas notes; decide before or during implementation):**
- **Q1-ops:** can Helm values pin capabilities?
- **Q1.4–Q1.7:** labor cost when Resources is off; a sprint that is running when Agile is turned off; who sees the "N areas off" disclosure; Inbox notice vs history.
- **Q2.4–Q2.6, Q2.8–Q2.10:**
  - ask expiry;
  - the "Seen" receipt;
  - counter-of-counter;
  - what "Release assignments" undoes;
  - who confirms the offer-line task mapping (proposed: the PM can reassign before accepting);
  - whether a direct assignment to a pool member shows as booked.
- **Q3.5:** receipts and attachments on expenses (proposed: out of 0.5).
- **Q4.2, Q4.7:** how often the soft ask returns; whether Agents off suppresses refusal pushes.
- **Q5.4, Q5.6:** a weighted rollup; the stale marker.
- **Q6.6:** a multi-tab outbox.
- **Q7.1–Q7.4, Q7.6:**
  - FNLT and MFO on import;
  - whether #804 lands in 0.5;
  - showing the 0.6 constraint types;
  - SNET drag clamping;
  - deadline probability.
- **Q8.1–Q8.4:**
  - 2 or 3 chrome rows (#4502);
  - a design pass for role-lens seeding (#3715);
  - #3150 in Pass 5;
  - rebaselining on a phone.

## 8. Issue map
- #4888 → capabilities
- #3362, #3122 → asks and outcome
- #4905 → expenses
- #4849 → rate grant
- #2132 → push
- #3901 → health (superseding note)
- #3045 → offline replay
- #3345, #1441 → constraints
- #4814 → agents scope and dry run (8e: Write column "Ships in 0.6", Propose renamed Dry run per #1813)
- #2557 → answered for 0.5 by ADR-1462 through #4905
- #1413 → getting-started checklist (8c, 8f-4)
- #4501, #4502 → partly resolved by Pass 2 (8a). #4502 waits on Q8.1
- #3715, #3887 → not resolved (8b). They need their own design pass (Q8.2)
- #3150 → not covered by a frame. It is now 0.5 `release::committed` (2026-11-23), so its design pass (Q8.3) is due in 0.5
- #2557 moved to 0.5 `release::committed` (2026-11-23)
- Enterprise: trueppm-enterprise#208, #209, #210
