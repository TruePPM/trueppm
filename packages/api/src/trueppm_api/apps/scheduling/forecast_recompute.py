"""Tell extensions when a project's forecast has gone stale (#2798).

Staleness itself is a derived fact (:mod:`.forecast_staleness`) computed per response,
so there is no stored state whose *transition* could be observed. This module picks the
one point where the transition is cheap and meaningful and fires
:data:`~.signals.forecast_recompute_requested` there.

**Why the end of a schedule recalculation, and not the write.** The plan counter bumps
on every synced row write, including every task PATCH. Dispatching there would add a
query and a signal to the hottest write path in the product, and would fire once per
keystroke of a bulk edit. A recalculation is already asynchronous, already coalesced
by the schedule outbox, and its success is exactly the moment the forecast's CPM
baseline moved under it — so one dispatch per settled burst of edits.

**Why a once-per-run guard.** Recalculations also run for reasons unrelated to a new
edit (imports, calendar changes, retries). The guard keys on the run id, so a receiver
is told once per stale run, and again only after a new run is taken and then goes stale.
The guard is a cache ``add`` and fails open: a cache outage may repeat a signal, never
swallow one, and receivers are required to be idempotent.
"""

from __future__ import annotations

import logging
from typing import Any

from django.core.cache import cache
from django.utils import timezone

from trueppm_api.core.extension_signals import dispatch_extension_signal

from .forecast_staleness import forecast_staleness_from_run
from .signals import forecast_recompute_requested

logger = logging.getLogger(__name__)

#: Long enough to outlive any realistic burst of recalculations after one stale run, and
#: bounded so abandoned keys do not accumulate.
_GUARD_TTL_SECONDS = 7 * 24 * 3600

#: The classifications that mean "the run no longer describes the plan". ``unknown``
#: (a pre-#3140 run, or never simulated) is excluded: we cannot say it moved, and
#: signaling every legacy project on its first recalculation would be a fleet-wide storm.
#: ``engine_superseded`` (#5064) is excluded for the same reason: an epoch bump supersedes
#: every project's run at once, so signaling it would fire for the whole fleet on each
#: project's next recalculation — and it keeps the ``staleness`` values this extension
#: point carries the ones enterprise receivers were written against.
_SIGNALED = frozenset({"project_changed", "aged"})


def _guard_key(run_id: Any) -> str:
    return f"forecast_recompute_signaled:{run_id}"


def notify_if_forecast_stale(project_id: Any) -> bool:
    """Fire ``forecast_recompute_requested`` if the latest run is stale and not yet signaled.

    Called after a successful recalculation. Never raises: the caller is the schedule
    recalculation task, and a failure here must not turn a good recalculation into a
    retry. Returns whether a signal was dispatched (for tests).
    """
    from trueppm_api.apps.projects.models import Project

    from .models import MonteCarloRun

    try:
        if not forecast_recompute_requested.receivers:
            return False
        run = MonteCarloRun.objects.filter(project_id=project_id).first()
        if run is None:
            return False
        current, recalculated_at = Project.objects.filter(pk=project_id).values_list(
            "last_sync_version", "recalculated_at"
        ).first() or (None, None)
        facts = forecast_staleness_from_run(
            run,
            plan_version_current=current,
            recalculated_at=recalculated_at,
            today=timezone.localdate(),
        )
        if facts["forecast_staleness"] not in _SIGNALED:
            return False
        try:
            first_time = cache.add(_guard_key(run.pk), 1, _GUARD_TTL_SECONDS)
        except Exception:
            # Fail open (see module docstring): a repeat is harmless, a swallowed
            # announcement is not.
            logger.warning("forecast_recompute guard unavailable; signaling anyway", exc_info=True)
            first_time = True
        if not first_time:
            return False
        dispatch_extension_signal(
            forecast_recompute_requested,
            sender=MonteCarloRun,
            project_id=project_id,
            run_id=run.pk,
            staleness=facts["forecast_staleness"],
            plan_version=facts["plan_version"],
            plan_version_current=facts["plan_version_current"],
        )
        return True
    except Exception:
        logger.exception("forecast_recompute_requested dispatch failed for %s", project_id)
        return False
