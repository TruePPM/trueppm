# ADR-1500: The allocation booking lives on the roster row, and one function judges it

## Status

Accepted (2026-11-25), #4806

## Context

The Pass 3 design checks an allocation before it is saved and assumes
`ProjectResource.share_pct` per week with `Resource.max_units` as the ceiling.
`share_pct` did not exist. `ProjectResource` carried a capacity override
(`units_override`), an advisory engagement window and `availability_percent`
(ADR-0190), none of which is a booking. Load was counted only from
`TaskResource.units`.

## Decision

1. A booking is `share_pct` over an inclusive `share_start`..`share_end` window on
   `ProjectResource`. One booking per person per project. `availability_percent`
   is not reused (it defaults to 100, so every roster row would read as fully
   booked), and neither is the engagement window (`engaged_to` marks a contractor).
2. `POST /api/v1/allocations/` is the only write. `?dry_run=1` returns the same
   verdict and writes nothing. `ProjectResourceSerializer` exposes the fields
   read-only.
3. Per day, a project draws the larger of its booked share and its assigned task
   units, so tasks consume a booking instead of stacking on it. Weekly load is the
   busiest day plus time off, judged against `max_units`, over only the days of the
   week inside the proposed window. A week **breaks** when the proposal leaves it
   over the ceiling *and* higher than it is today (with this project's stored
   booking in place); only a breaking week refuses a save. Lowering a booking, or
   booking into a week already over without raising its busiest day, is never
   refused. Draft projects are not counted and archived ones are, as on
   `/me/people-load/` (ADR-1314).
4. Accept-with-reason is stored on the same row (`overage_reason`,
   `overage_week`, `overage_accepted_by`, `overage_accepted_at`). It describes the
   current booking; a save that leaves no week over, or a removal, clears it, and
   a save that breaks nothing while a week stays over keeps it. It is not a
   history log. No load figure is stored: its readers are every Resource Manager on
   the project, who need not see the projects the figure was built from.
5. A save locks the `Resource` row and recomputes under the lock.
6. Both dry run and save need Scheduler or above on the target project. Accepting
   needs no higher role. Agent (read-only MCP) tokens are refused; agent access is
   a follow-up (#5146).
7. Visibility mirrors `/me/people-load/` (ADR-1314) and the ADR-0104 `capacity`
   signal. The person must be on the live roster of a live, non-draft project where
   the caller is Scheduler or above; otherwise the request gets the same `400` as
   an unknown resource. A project's load is shown as a number only where the
   caller is Scheduler or above *and* the project's `capacity` signal reaches the
   caller's role band; this includes the target project's own task units. All other
   load counts in full toward `fits`, `over` and `breaks`, but it is never
   displayed as a number: it is one unnamed `other_work` line with a null `pct`, and every figure
   it is part of (the week's `load_pct`, `peak_pct`, each resolution's
   `peak_pct`) is null with reason `withheld`, in the 200, the 409 body and the
   notification alike (see Consequences for what the verdict
   itself implies). The proposal's own share is always shown. A project that
   passes the role gate but not the signal gate still lets its Resource Manager
   book; its team's policy withholds the figures, not the booking.
8. Bookings count only in this check. People load, utilization and capacity read
   `TaskResource.units` and are unchanged, so a booking with no task behind it
   does not appear there. The `allocation.load_pct` definition says so.

## Consequences

- The ceiling is enforced on bookings only. A task assignment still warns and
  saves (ADR-0028); a booking check sees that load afterwards.
- Tasks with no scheduled dates are not counted, as on the heat map.
- Load the caller cannot see is never displayed as a number, and the ceiling is
  still enforced against it. It is not private from the caller: because the check
  answers fits or does not fit, that load can be inferred from repeated checks.
  This is accepted.
- A second, differently shared window on one project needs a booking table (#741).
