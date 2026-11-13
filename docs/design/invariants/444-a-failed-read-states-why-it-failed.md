# Rule 444 — A failed-read state says WHY it failed: a 403 offers no Retry, a 429 counts down and retries itself, everything else keeps the generic message

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text (#3874, #3621). Binding everywhere a TanStack Query read can fail.

**Passing the query's `error` to `QueryErrorState`** (`error={error}`) **is opt-in, not automatic**: a surface that omits it keeps the generic message + Retry for every failure, including a 403. Wire it in whenever you touch a surface that has the query's error in hand. The component reads it through `classifyQueryError` (`lib/queryErrorKind.ts`) and renders the one honest state per server verdict:

| Failure | State | Why |
|---|---|---|
| 403 | "You don't have access to this." + the access-changed help line; **no Retry button** | The identical request fails identically forever; Retry is a false promise. |
| 429 | "Too many requests. Retrying in Ns." with a **Retry now** button; fires the caller's `onRetry` once at zero | It is a verdict about *now*. Auto-retry only through a caller-supplied `onRetry`: the default retry is a full page reload and never fires on a timer. `Retry-After` is honored (clamped to 60 s, default 5 s). |
| anything else (5xx, network) | The caller's `message` + Retry | Unchanged. |

A read whose 429 or 403 falls through to the empty branch is the rule-301 shape: a client-side reading of a server verdict taking the neutral branch.

**Surfaces wired today** (they pass `error`): ProjectShell (429 only), ProgramListPage, ScheduleView, SprintsView, CalendarView, DefaultMemberRoleSetting, the settings pages WorkspaceGeneral / WorkspaceMethodology / WorkspaceGroups / WorkspaceCalendar / WorkspaceAttachments / WorkspaceFeedback, ProjectSharing / ProjectLabels / ProjectWorkflow / ProjectMethodology / ProjectTeamWorkflow, ProgramCalendar, and the `RequireAdminSettings` / `RequireWorkspaceAdmin` guards (via the `error` field on `useAdminSettingsAccess` / `useWorkspaceAdminStatus`). Every other `QueryErrorState` call site is unwired and still shows the generic state on a 403 or 429; grep `<QueryErrorState` for the current set.

A 429 restarts its countdown when a repeat throttle arrives, even with an identical `Retry-After`, because the countdown is keyed on the error object's identity, not just the seconds.
