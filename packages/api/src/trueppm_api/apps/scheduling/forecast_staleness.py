"""Does this Monte Carlo forecast still describe the current plan? (#3140)

A forecast is a statement about a plan at a moment. The plan moves; the forecast does
not. Every surface that renders a forecast therefore has to answer "is this still
about the plan I am looking at?" — and until now each one answered it for itself.

The web forecast bar answered it with a ``useState(0)`` counter bumped from exactly one
mutation path, which meant the answer was a fact about one component instance's
lifetime rather than about the data: it missed inline edits, estimate edits (the actual
Monte Carlo inputs), a collaborator's write over the WebSocket, and it reset to zero on
every reload. Once #3132 gated the *Rerun action* on that predicate, the state a user
most needs the button in — a plan edited before the page was opened — was precisely the
state that read as "nothing to do".

Per ADR-0599 the authoritative classification of a server-computed outcome is itself
server-computed, so the classification lives here and ships on the payload. No client
re-derives it.

**The plan-version fact is reused, not invented.** ``Project.last_sync_version``
(ADR-0686 / #2491) is the per-project monotonic sequence every synced row write draws
its ``sync_seq`` from (:mod:`trueppm_api.apps.sync.sequence`). It is atomic, monotonic
and authoritative. :mod:`.risk_premium` still carries a comment saying the real stale
trigger "needs a cheap per-project mutation counter that does not exist yet"; that
comment predates ADR-0686 and is corrected there.

Three properties make it the right counter, and all three are load-bearing:

* **It over-approximates, and that is the safe direction.** It bumps for *any* synced
  write in the project — a description edit moves it without moving the plan. So the
  forecast can read stale when it is not. It can never read fresh when it is not, and
  since the defect being fixed is an *unreachable action*, false-stale costs a button
  nobody needed while false-fresh costs the action entirely.
* **A CPM recompute does not bump it.** CPM output writes go through ``bulk_update``
  (ADR-0091) — no ``save()``, no allocation — so a recalc cannot manufacture staleness
  on a plan nobody touched.
* **A Monte Carlo run does not bump it.** ``MonteCarloRun`` is a plain ``models.Model``
  outside the sync union, so a run can never make itself stale.

**The second property also opens the only false-fresh hole, which is why there is a second
term.** A run's ``cpm_finish`` is read from *persisted CPM output* (``max(early_finish)``),
and a recalc rewrites that output without touching the counter. So: an edit bumps the
counter to N+1 and queues a recalc; the user reruns the forecast before the recalc lands,
recording ``plan_version = N+1`` against pre-recalc dates; the recalc then lands and moves
every ``early_finish``. Comparing N+1 to N+1 says ``current`` while the run's
``cpm_finish`` — and therefore its ``delta_vs_cpm`` and its whole risk-premium family —
describes a schedule that no longer exists. The window is not exotic: Rerun sits beside
the drag that queues the recalc.

``Project.recalculated_at`` (ADR-0114) closes it for free. It is stamped when the recalc
task succeeds, so a run older than it provably predates the current CPM output, and every
caller already holds the project row — no extra query.

**What is stored where, because the split is not the obvious one.** ``plan_version`` is an
*observation* made at run time, so it rides both the ``mc_latest`` cache entry and the
persisted ``MonteCarloRun`` row — it cannot be recovered later from either the project or
the clock. Only ``plan_version_current`` and the classification itself are derived per
response. Carrying it on the cache entry is not belt-and-braces: a run triggered by a
**Member** refreshes the cache but persists no attributed row (#1502), so the cache is the
*only* place that run's plan version exists.

Publishing ``plan_version_current`` is not new disclosure. ``Project.last_sync_version``
is already returned verbatim to the same Viewer+ audience as the ``timestamp`` cursor of
every ``GET /api/v1/sync/projects/<pk>/`` response
(:meth:`trueppm_api.apps.sync.views.ProjectSyncView._watermark`); the field comment on the
model says "excluded from the sync serializer", which is true of the row serializer and
easy to misread as "never leaves the server".

The audience is not *identical*, though, and the difference should not be lost: the sync
pull is not an MCP-readable view, while all three surfaces carrying these keys are. So an
``mcp:read`` token can now read this counter where none could before. That is a strict
subset of its owner's own access — the mixin confines tokens to safe methods behind the
same ``IsProjectMember`` gate — but "no new audience" would be the wrong summary.

This module is now a *consumer* of the allocator's monotonicity invariant, whose
writer-side precondition is tracked in #2617 — a change to the allocator changes what
"stale" means here.

**Composes with, and does not supersede, ``risk_premium_state``.** That enum answers a
different question — whether the *added-time number* is still worth reporting — and its
``stale`` occupies the same slot as ``premium``/``zero``/``negative``, so folding plan
drift into it would destroy the Overview card's premium classification. This module
therefore shares :data:`~.risk_premium.STALE_AFTER_DAYS` (one age threshold in the
codebase, so ``aged`` and ``risk_premium_state == "stale"`` can never disagree about the
age term) and *adds* the plan-drift term that age alone cannot see. Age is still needed
on its own: ADR-0132 floors a null status date at today, so an untouched project's
percentiles genuinely drift with the calendar even though its plan version has not moved.
"""

from __future__ import annotations

import datetime
from collections.abc import Mapping
from typing import Any, Literal, TypedDict

from .risk_premium import STALE_AFTER_DAYS

#: The forecast-vs-plan discriminant. Never ``None`` on the wire — a client renders from
#: this value alone and must never have to decide what an absent key means.
#:
#: * ``current`` — the run was computed against the version the project is on now, and it
#:   is not old enough for the calendar to have moved underneath it.
#: * ``project_changed`` — the project has been written to since the run, or its CPM
#:   output has been recomputed since the run.
#: * ``aged`` — nothing has been written, but the run is older than
#:   :data:`~.risk_premium.STALE_AFTER_DAYS`, so the data date has advanced under it
#:   (ADR-0132) and the percentiles no longer describe the same remaining work.
#: * ``unknown`` — the run recorded no plan version (it predates #3140), so no comparison
#:   is possible. Deliberately distinct from ``current``: "we cannot tell" is not "it is
#:   fine", and conflating them is how the original defect read.
#:
#: **``project_changed``, not ``plan_changed``, and the name is the honest part.** The
#: counter behind it — ``Project.last_sync_version`` — advances on *any* synced write in
#: the project, so a description edit or a label moves it without moving a single date.
#: It is therefore a sound *trigger* ("the inputs may have moved; offer the recompute")
#: and would be an unsound *claim* ("your plan changed"). A name that overstates its
#: evidence is worse here than one that understates it, because the value goes to LLM and
#: MCP callers that will narrate it as fact and have nothing else in the payload to check
#: it against. Any consumer wanting the stronger claim must corroborate it separately.
ForecastStaleness = Literal["current", "project_changed", "aged", "unknown"]


class ForecastStalenessFacts(TypedDict):
    """The staleness slice as it appears on a Monte Carlo payload."""

    forecast_staleness: ForecastStaleness
    #: The project's ``last_sync_version`` when the run was computed. ``None`` for runs
    #: recorded before #3140 (nullable with no backfill, the same discipline
    #: ``distribution``/``diagnostic``/``status_date`` already follow on ``MonteCarloRun``).
    plan_version: int | None
    #: The project's ``last_sync_version`` as of *this response*. Carried beside the run's
    #: own version so a reader — including an MCP client — can state the finding
    #: ("computed against 412, plan is at 419") rather than only its verdict.
    plan_version_current: int | None


def classify_forecast_staleness(
    *,
    plan_version: int | None,
    plan_version_current: int | None,
    age_days: int | None,
    recalculated_after_run: bool = False,
) -> ForecastStaleness:
    """Classify one run against the plan it is being read beside.

    Evaluated in a fixed order, and the order is the safety property: **``current`` is
    unreachable without a recorded plan version.** Every run in every install is
    version-less on the day this ships (nullable, no backfill), and a decision order that
    let one of them fall through to ``current`` because it also happened to be younger
    than the age threshold would hide the Rerun button across the entire fleet — the
    original defect, reintroduced by its own fix. So the missing-input branch is decided
    first, exactly as ``unmeasurable`` is decided before the zero branch in
    :func:`~.risk_premium._premium_state`.

    Within that branch the age rule still runs, because it answers a *narrower* question
    the timestamp alone can support: a version-less run past
    :data:`~.risk_premium.STALE_AFTER_DAYS` is provably ``aged``, which is strictly more
    useful to a reader than ``unknown`` and equally non-``current``.

    Args:
        plan_version: The project's plan version when the run was computed, or ``None``
            for a run recorded before #3140.
        plan_version_current: The project's plan version now, or ``None`` when the
            project row could not be read.
        age_days: Whole days between the run and today, or ``None`` when the run carries
            no timestamp.
        recalculated_after_run: Whether the project's CPM output was rewritten after this
            run was taken (``Project.recalculated_at > taken_at``). Closes the one
            false-fresh path the version counter cannot see — see the module docstring.

    Returns:
        The discriminant a client renders from.
    """
    aged = age_days is not None and age_days > STALE_AFTER_DAYS

    if plan_version is None or plan_version_current is None:
        # No comparison is possible. Report what the timestamp *can* prove, and otherwise
        # report that the run is unplaceable — never that it is fine. The client keeps the
        # action reachable on both and withholds the stale claim it cannot support.
        if recalculated_after_run:
            return "project_changed"
        return "aged" if aged else "unknown"

    # Compared with `!=`, not `<`, deliberately: a restored or rolled-back database whose
    # counter went backwards is exactly as unplaceable as one that moved forward, and
    # `<` would call that case `current`.
    if plan_version != plan_version_current or recalculated_after_run:
        return "project_changed"

    if aged:
        return "aged"

    return "current"


def forecast_staleness_facts(
    *,
    plan_version: int | None,
    plan_version_current: int | None,
    taken_at: datetime.datetime | None,
    recalculated_at: datetime.datetime | None,
    today: datetime.date,
) -> ForecastStalenessFacts:
    """Build the staleness slice for one forecast response.

    The single entry point — the live run, the cached read and the from-history fallback
    all reach :func:`classify_forecast_staleness` through here, so the platform has one
    derivation of what "stale" means for a forecast.

    Derived per response and never stored, for the same reason the risk premium is
    (ADR-0698 §2): both of its inputs move underneath a 24-hour cache entry. The plan
    version advances every time anyone writes to the project, and ``today`` advances on
    its own.
    """
    age_days = (today - taken_at.date()).days if taken_at is not None else None
    # Both timestamps are timezone-aware in practice, but a legacy cache entry can carry a
    # naive one; comparing the two would raise TypeError and 500 a read path. Treat an
    # unusable pair as "no evidence of a recalc" rather than letting it decide anything.
    recalculated_after_run = False
    if recalculated_at is not None and taken_at is not None:
        naive = (recalculated_at.tzinfo is None) != (taken_at.tzinfo is None)
        recalculated_after_run = not naive and recalculated_at > taken_at
    return ForecastStalenessFacts(
        forecast_staleness=classify_forecast_staleness(
            plan_version=plan_version,
            plan_version_current=plan_version_current,
            age_days=age_days,
            recalculated_after_run=recalculated_after_run,
        ),
        plan_version=plan_version,
        plan_version_current=plan_version_current,
    )


def forecast_staleness_from_run(
    run: Any | None,
    *,
    plan_version_current: int | None,
    recalculated_at: datetime.datetime | None,
    today: datetime.date,
) -> ForecastStalenessFacts:
    """Derive the staleness slice from a persisted :class:`.models.MonteCarloRun`.

    ``run`` is ``None`` when the project has never been simulated, which classifies as
    ``unknown`` — there is no run to place against a plan. Thin adapter over
    :func:`forecast_staleness_facts`, which owns the derivation, and the counterpart to
    :func:`~.risk_premium.build_risk_premium`.

    Kept value-shaped rather than request- or response-bound on purpose: an Enterprise
    drift digest (``trueppm-enterprise#192``) has to be able to read this OSS fact by
    importing it — enterprise → core, the one sanctioned direction — instead of
    re-deriving its own answer beside ours and drifting from it.
    """
    if run is None:
        return forecast_staleness_facts(
            plan_version=None,
            plan_version_current=plan_version_current,
            taken_at=None,
            recalculated_at=recalculated_at,
            today=today,
        )
    return forecast_staleness_facts(
        plan_version=run.plan_version,
        plan_version_current=plan_version_current,
        taken_at=run.taken_at,
        recalculated_at=recalculated_at,
        today=today,
    )


def _parse_int(value: Any) -> int | None:
    """Best-effort int; ``None`` for anything that is not one.

    The cache entry is a plain dict written by a possibly older deploy, so its
    ``plan_version`` is only an int by convention. A ``bool`` is rejected explicitly —
    it is an ``int`` subclass, and letting ``True`` through would compare as ``1`` and
    silently classify a forecast against plan version one.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return int(value)


def forecast_staleness_for_payload(
    payload: Mapping[str, Any],
    *,
    plan_version_current: int | None,
    recalculated_at: datetime.datetime | None,
    today: datetime.date,
) -> ForecastStalenessFacts:
    """Derive the staleness slice from a cached Monte Carlo forecast dict.

    Absence is tolerated rather than trusted, mirroring
    :func:`~.risk_premium.risk_premium_for_forecast_payload`: a ``plan_version`` key that
    is missing, ``None`` or not an int resolves to ``unknown`` — "we do not know" —
    instead of inventing a comparison from a partial payload.
    """
    taken_at = payload.get("last_run_at")
    parsed_at: datetime.datetime | None = None
    if isinstance(taken_at, datetime.datetime):
        parsed_at = taken_at
    elif isinstance(taken_at, str):
        try:
            parsed_at = datetime.datetime.fromisoformat(taken_at)
        except ValueError:
            parsed_at = None

    return forecast_staleness_facts(
        plan_version=_parse_int(payload.get("plan_version")),
        plan_version_current=plan_version_current,
        taken_at=parsed_at,
        recalculated_at=recalculated_at,
        today=today,
    )
