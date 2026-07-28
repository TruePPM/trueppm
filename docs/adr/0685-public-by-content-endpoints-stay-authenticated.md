# ADR-0685: Public-by-content read endpoints stay authenticated; publication is a deployment decision

## Status
Accepted

## Context

#2490 adds two read endpoints that serve the bundled demo fixtures: a catalog
(`GET /programs/samples/`) and a download (`GET /programs/samples/{key}/download/`).
The fixtures are Apache 2.0, committed in this repository, and already readable by
anyone with a browser and the repo URL. Nothing about them is secret.

That fact produced a genuinely reasonable argument for `AllowAny`: the feature
exists to let someone decide whether to trust the demo loader *before* using it,
and the most valuable moment for that is when a prospective user is evaluating a
hosted demo — before they have an account. Requiring authentication to audit a
public file reads, at first glance, as ceremony.

A growing set of endpoints fit the same description: the schema registry,
changelog metadata, health summaries, the edition probe. Each is individually a
defensible `AllowAny`. Decided one at a time, on the merits of its payload, the
set only ever grows, and the reasoning is spread across a dozen view docstrings
where no reviewer can see it as a policy.

There is also already a mechanism for this. The Helm demo-mode endpoint allowlist
(#2440, ADR-0658) exists precisely to decide what a public demo deployment
exposes, and it does so per-deployment, in values, reviewable in a diff and
revocable without a release.

## Decision

**DRF permission classes describe authorization, not publication.** An endpoint is
not made anonymous because its payload happens to be public.

1. Read endpoints keep the authorization their viewset implies —
   `IsAuthenticated` for both #2490 routes.
2. Anonymous exposure is granted **per-deployment**, via the demo-mode allowlist,
   not in code.
3. A new endpoint may declare allowlist **eligibility** in its docstring — "safe
   to publish in demo mode" — but it does not grant it. Eligibility and
   enforcement stay in different places on purpose.

## Consequences

**What this costs, stated plainly.** On a hosted demo as configured today, an
anonymous visitor cannot audit the fixtures before signing up. That is one
deployment change away, and the person who makes it is the person who owns the
perimeter — which is the same person the audit path is for. We are trading a
small amount of pre-signup convenience for a permission model that stays
readable.

**What it buys.** The next "but it's already public" argument has one place to be
answered, and answering it does not require a code change or a release. A
reviewer reading a permission class learns who may read the data, not what the
marketing site would like to show. And the allowlist accumulates the record of
what a public deployment actually exposes, in one file, instead of that record
being implicit in thirty scattered permission lists.

**Where it does not apply.** This is about endpoints whose *content* is
non-sensitive. It says nothing about endpoints that are unauthenticated for
protocol reasons — login, token refresh, health probes, the OIDC callback — which
are anonymous because they must be, not because their payload is uninteresting.

## Alternatives considered

**`AllowAny` on the two #2490 routes.** Rejected. It buys anonymous pre-signup
audit on hosted demos, and costs the property that a permission class means one
thing. The precedent is the real cost: auth widened for a non-security reason
ratchets in one direction only, and the second endpoint to cite this one would
not have to argue its own case.

**A dedicated `IsPublicContent` permission class.** Rejected as the worst of both.
It puts the publication decision back in code while adding a class whose name
invites use on things that are not, in fact, public.

## References

- #2490 — browsable + downloadable demo seed files
- ADR-0658 / #2440 — Helm demo mode and its endpoint allowlist
- ADR-0109 — canonical JSON seed format
- ADR-0651 — seed import dry run, the other half of the inspect-before-import chain
