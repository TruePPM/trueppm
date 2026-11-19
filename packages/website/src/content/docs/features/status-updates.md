---
title: Project status updates
description: Post a RAG call and a narrative with a server-frozen snapshot of the plan, read the history with what has moved since, and share one update read-only.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
Status updates ship in 0.5, as an API first. The composer in the web app and the
PDF and share page arrive later in 0.5. In 0.4 a project has a computed health
band and no posted status a stakeholder can read.
:::

A **status update** is the project manager's report on a project at a point in
time: a RAG call (green, amber or red), a narrative of up to 600 characters, and
a **snapshot** of the plan that the server takes at the moment of posting. The
snapshot is stored and never recomputed. Reading an update later shows what the
plan said when it was posted, and separately what has changed since.

## Who can do what

| Action | Who |
|---|---|
| Post a status update | Project Manager or above, signed in. An API token cannot post, an agent's included, even one acting for the project manager. |
| Read the history | Every project member, Viewer and above. An `mcp:read` token (an agent) can read the history and one update, as the person it acts for, unless the project has turned agent access off. |
| Create or revoke a share link for an update | Project Manager or above. |
| Open a share link | Anyone holding the link, with no sign-in. |

A posted update cannot be edited or deleted. To correct one, post a new update.
Updates on an archived project cannot be posted.

An agent can read status updates and cannot post one. A post sent with any API
token, an `mcp:read` token or a full-access personal access token alike, is
refused with `403`, even when the token belongs to the project manager. Posting
needs the person signed in.

Posting is rate limited per account and per project: every project manager on a
project shares the project's limit.

## What the snapshot holds

Each figure carries its value, the time it was true (`as_of`) and its one-sentence
definition from the [metric vocabulary](/features/metric-vocabulary/). A figure
that cannot be computed is returned as null with a reason, such as `no_forecast`
or `no_baseline`, rather than left out.

- **Forecast**: the P50 and P80 finish from the latest Monte Carlo result, the
  CPM finish, and the CPM finish's variance against the active baseline.
- **Milestones**: each milestone's CPM finish, baseline finish and variance, up to
  50 rows, earliest first. `milestones_truncated` is true when the project has more.
- **Since the previous update**: tasks completed and milestones slipped. On the
  first update both are null with the reason `no_previous_update`.
  - *Completed* counts tasks whose actual finish falls on or after the **day** the
    previous update was posted, in the server's time zone. It is day-granular, so
    two updates posted on the same day both count that day's completions.
  - *Slipped* counts milestones whose CPM finish moved later between the two
    snapshots. Only the milestones inside each snapshot's 50-row cap are compared,
    so a slip on a milestone past the cap is not counted.
- **Top risks**: the three open or mitigating risks with the highest probability
  times impact.
- **Open decisions**: awaiting program decisions linked to a task or risk of this
  project.
- **Computed health**: the health band the counts give at post time, stored beside
  the project manager's RAG call so a reader can see where the two disagreed.

The snapshot holds no cost figures.

Every update is numbered within its project (`seq`), and two posts made at the
same moment take consecutive numbers. The server records a SHA-256 digest at post
time over everything a reader is served (the number, the RAG call, the narrative,
the author, the posting time, the computed health and the snapshot) and checks it
on every read; `snapshot_verified` is false if any of them was changed outside
TruePPM, and a share link for such an update stops resolving. Deleting the
author's account is not a change of that kind: TruePPM re-records the digest
without the author as the account is removed, so the update still verifies and
shows no author.

## What has moved since

When you read an update, `live_diff` lists each snapshot figure whose current
value differs from the frozen one, keyed by its place in the snapshot (for
example `forecast.p80` or `milestones.<task id>.cpm_finish`). Figures that have
not moved are left out. A milestone that has left the plan reads
`{"value": null, "reason": "removed"}`.

## Sharing one update

A share link for a status update is created with the same
`POST /api/v1/projects/{id}/share-links/` call as board and schedule links, with
`content_kind: "status_update"` and the `status_update` id. The link is bound to
that one update. It never moves to a newer one, and it never shows data newer
than that update's snapshot.

The shared view is the frozen snapshot only. It never carries the "what has moved
since" values, and it carries no ids or links into the workspace. Its contents are
filtered on the server:

| Setting | Default | Controls |
|---|---|---|
| `show_milestone_dates` | on | The milestone rows. |
| `show_risks` | off | The top risks. Risk titles are internal, so they are opt-in. |
| `show_decisions` | off | The open decisions. Decision titles are internal, so they are opt-in. |
| `show_assignees` | off | People's names: the author, and risk and decision owners. |

Hiding milestones removes their rows, but the CPM finish and the counts are still
shown. Those can bound a withheld date. The setting withholds the dates and does
not guarantee they cannot be inferred.

The narrative is part of the shared view. Write it knowing that anyone holding the
link reads it.

A status-update link that is unknown, revoked, expired, for a project in Trash, or
blocked by the sharing policy returns the same `404`. Revocation, expiry and the
sharing policy otherwise work as they do for
[board and schedule links](/features/board-sharing/).

## API

- `GET /api/v1/projects/{id}/status-updates/`: the history, newest first, paginated.
- `POST /api/v1/projects/{id}/status-updates/`: post `{rag, narrative}`.
- `GET /api/v1/projects/{id}/status-updates/{update_id}/`: one update.
- `GET /api/v1/share/status-update/{token}/`: the public, read-only shared view.

The full schema is in the [API reference](/api/reference/).

## Related

- [Metric vocabulary](/features/metric-vocabulary/)
- [Public sharing (board & schedule)](/features/board-sharing/)
- [Monte Carlo forecasting](/features/monte-carlo/)
- [Risk register](/features/risk-register/)
