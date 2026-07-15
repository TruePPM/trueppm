"""Composable working-calendar resolution (#906, ADR-0251).

A project's effective non-working mask for CPM is the overlay (union) of several
applied calendars: a base ``Project.calendar`` plus zero or more
``ProjectCalendarLayer`` overlays. A day is non-working if *any* applied calendar
marks it so — masks AND-composed, exception ranges unioned.

The fold itself lives in ``trueppm_scheduler.models.Calendar.compose`` (the Apache
package). This module is the Django-side seam: it resolves *which* calendars apply
to a project (through a small resolver registry) and converts them to scheduler
dataclasses via the single ``build_sched_calendar`` primitive.

The resolver registry is the one-way (enterprise → core) extension point
(ADR-0251 §6): OSS registers exactly one resolver (base + overlay layers);
enterprise appends more (per-resource, cross-program calendars) against the same
signature. Because composition is AND-of-masks + union-of-exceptions, any added
resolver is always additive and order-independent, so a new source can never be a
breaking change to an existing project's schedule.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from trueppm_api.apps.scheduling.services import build_sched_calendar

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Calendar, Project

# A resolver maps a project to the ordered Django ``Calendar`` rows it applies.
CalendarLayerResolver = Callable[["Project"], "list[Calendar]"]

_LAYER_RESOLVERS: list[CalendarLayerResolver] = []


def register_calendar_layer_resolver(resolver: CalendarLayerResolver) -> None:
    """Register a resolver that contributes calendars to a project's composed mask.

    Idempotent: registering the same resolver twice is a no-op, so an
    ``AppConfig.ready()`` that runs more than once (or a re-imported test module)
    cannot double-count a source.
    """
    if resolver not in _LAYER_RESOLVERS:
        _LAYER_RESOLVERS.append(resolver)


def oss_project_layers(project: Project) -> list[Calendar]:
    """OSS resolver: the effective base calendar plus its overlay layers, in order.

    The base is resolved through the inheritance chain (ADR-0441): the project's own
    ``calendar`` if set, else its program's, else the workspace default — computed-on-read
    in ``apps.projects.calendar_settings`` so CPM and the serializers can never disagree
    on which calendar a project schedules against. ``None`` up the whole chain means the
    system default, so ``compose`` falls back to Mon-Fri/8h/UTC exactly as before.

    Overlays (``ProjectCalendarLayer``, ADR-0251) still stack on top of the inherited
    base — inheritance only decides the base; it does not change overlay composition.

    Callers must have prefetched ``calendar__exceptions``,
    ``calendar_layers__calendar__exceptions`` and — so the inherited tiers don't N+1 —
    ``program__calendar__exceptions`` when the project may inherit from its program.
    """
    from trueppm_api.apps.projects.calendar_settings import resolve_effective_base_calendar

    calendars: list[Calendar] = []
    base = resolve_effective_base_calendar(project)
    if base is not None:
        calendars.append(base)
    # Ordered by ProjectCalendarLayer.Meta.ordering = ["sort_order"].
    for layer in project.calendar_layers.all():
        calendars.append(layer.calendar)
    return calendars


# Registered here (module import) rather than in AppConfig.ready() because the
# OSS resolver has no app-loading dependency — importing this module is what wires
# it up. Enterprise registers its extra resolvers from its own AppConfig.ready().
register_calendar_layer_resolver(oss_project_layers)


def resolve_applied_calendars(project: Project) -> list[Calendar]:
    """The de-duplicated, ordered list of every ``Calendar`` applied to a project.

    Folds the output of every registered resolver into one ordered list, dropping
    a calendar already contributed by an earlier resolver (the base calendar, for
    instance, must not be counted twice if a later resolver also returns it). The
    first occurrence — the base calendar under the OSS resolver — leads, so its
    scalar ``hours_per_day``/``timezone`` win in :func:`compose_project_calendar`.
    """
    seen: set[Any] = set()
    result: list[Calendar] = []
    for resolver in _LAYER_RESOLVERS:
        for cal in resolver(project):
            if cal.id not in seen:
                seen.add(cal.id)
                result.append(cal)
    return result


def compose_project_calendar(project: Project) -> Any:
    """Fold a project's applied calendars into one scheduler ``Calendar`` (#906).

    ``working_days`` = bitwise-AND of every applied mask; ``exceptions`` = union of
    every applied calendar's ``CalendarException`` ranges; ``hours_per_day`` /
    ``timezone`` from the base (first) calendar. Compute-on-read (ADR-0251 §3): the
    fold is O(layers) and the expensive per-day lookup is already indexed inside
    the scheduler ``Calendar``. A project with no applied calendars falls back to
    the Mon-Fri/8h/UTC default, identical to ``build_sched_calendar(None)``.

    Every scheduling call site (CPM pass, Monte Carlo, program schedule) routes
    through this one helper so composition can never drift between engines. Callers
    must prefetch ``calendar__exceptions`` and
    ``calendar_layers__calendar__exceptions``.
    """
    from trueppm_scheduler.models import Calendar as SchedCalendar

    applied = resolve_applied_calendars(project)
    return SchedCalendar.compose([build_sched_calendar(c) for c in applied])
