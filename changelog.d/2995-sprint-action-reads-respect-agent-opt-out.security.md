Sprint detail endpoints now honor a project's agent-read opt-out. `SprintViewSet`
enforces ADR-0678 by filtering the queryset — for its scope, the permission class
deliberately allows the request and the queryset is the only enforcement point — but
its per-action routes resolved their sprint from the bare model manager, which never
consults that queryset. An `mcp:read` API token could therefore read burndown,
outcome, capacity, daily delta, scope changes, incoming carryover, retro board and
pulse data for a project whose team had explicitly opted out of agent reads. Because
the opt-out is a team-consent control rather than an access-control setting, this was
a consent bypass.

Every read on the viewset now resolves through a single shared helper, so a future
action cannot reintroduce the gap by copying the pattern from a neighbor. Four write
actions that take a row lock keep their own lookup; they were never part of this,
because an agent token is refused on any non-safe method before the request body runs.

Two side effects of resolving through the membership-scoped queryset: a non-member now
receives 404 rather than 403 from these routes, which removes a way to test whether a
sprint id is real; and a `?state=` query parameter is applied only to the sprint list,
where it belongs — on a detail route it could previously filter away the very sprint
the URL named.
