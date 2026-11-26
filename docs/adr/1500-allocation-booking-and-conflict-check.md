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
   busiest day plus time off, judged against `max_units`.
4. Accept-with-reason is stored on the same row (`overage_reason`,
   `overage_peak_pct`, `overage_week`, `overage_accepted_by`,
   `overage_accepted_at`). It describes the current booking; a later save that fits
   clears it. It is not a history log.
5. A save locks the `Resource` row and recomputes under the lock.
6. Both dry run and save need Scheduler or above on the target project. Accepting
   needs no higher role. Agent (read-only MCP) tokens are refused.
7. Load from projects the caller is not a member of counts in full and is shown as
   one unnamed `other_work` figure.

## Consequences

- The ceiling is enforced on bookings only. A task assignment still warns and
  saves (ADR-0028); a booking check sees that load afterwards.
- Tasks with no scheduled dates are not counted, as on the heat map.
- A Scheduler on any project can learn a person's total booked percentage per week
  for the weeks they ask about. That is the price of a true ceiling.
- A second, differently shared window on one project needs a booking table (#741).
