"""Methodology-aware defaults for a new task's governance/delivery taxonomy (#2667).

``Task.governance_class`` and ``Task.delivery_mode`` (ADR-0036, #407) are purely
additive fields with model-level defaults of ``FLOW`` / ``WATERFALL`` — chosen so
every pre-existing row's semantics stayed unchanged when the taxonomy shipped.
Those literals are also what a brand-new task got on *every* project regardless of
its own resolved methodology, which produces a self-contradictory dialog on a
``WATERFALL`` project (opens on Flow governance — "Agile, sprint- or
kanban-governed work" — for a project with no sprints or board governance) and a
correctness bug on ``AGILE`` (delivery mode stays Waterfall, so the task never
engages point-burndown rollup or agile-aware Monte Carlo).

This module resolves the *project-aware* default, consulted only when the client
omits the field on create (:meth:`TaskSerializer.validate`) — an explicit value
always wins, on create and update alike, so the documented hybrid seam (a single
project deliberately holding tasks in different delivery modes/governance
classes) is untouched. ``HYBRID`` keeps today's literal default (``flow`` /
``waterfall``) since it is the preset that already mixes both models.

Mirrored client-side in ``packages/web/src/lib/taskClassificationDefaults.ts`` so
the create dialog opens on the value this module would pick — the two are
independently maintained (there is no "preview the server default" endpoint) and
must be changed together. Keep them in sync.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from trueppm_api.apps.projects.models import Project


def resolve_default_governance_class(effective_methodology: str) -> str:
    """The governance class a new task should default to for a project's preset.

    ``WATERFALL`` → ``gated`` (phase-gate governance matches a project with no
    sprints or board governance). Every other preset (``AGILE``, ``HYBRID``)
    keeps the existing ``flow`` default — ``HYBRID`` deliberately, because it is
    the preset that mixes both governance overlays and has no single "right"
    class to steer toward.
    """
    from trueppm_api.apps.projects.models import GovernanceClass, Methodology

    if effective_methodology == Methodology.WATERFALL:
        return str(GovernanceClass.GATED)
    return str(GovernanceClass.FLOW)


def resolve_default_delivery_mode(effective_methodology: str, board_cadence: str) -> str:
    """The delivery mode a new task should default to for a project's preset.

    - ``WATERFALL`` / ``HYBRID`` → ``waterfall`` (HYBRID keeps today's literal
      default — the lossless choice for a preset that mixes delivery modes).
    - ``AGILE`` → ``scrum``, unless the project's board runs continuous-flow
      Kanban with no sprint cadence (``board_cadence == 'continuous'``), in which
      case → ``kanban``.

    The scrum/kanban split is resolved from ``board_cadence`` rather than an
    extra board-config lookup: ADR-0164 already models "sprint cadence vs.
    continuous flow" as that exact field, and ``scrum`` is the load-bearing
    choice for a brand-new agile project with nothing configured yet — an
    unpointed ``scrum`` task degrades to identical rollup behavior as a
    ``waterfall`` one (``COALESCE(story_points, duration)``), while defaulting to
    ``kanban`` would immediately binarize percent-complete and equal-weight every
    task regardless of size (see #2667 for the full analysis).
    """
    from trueppm_api.apps.projects.models import BoardCadence, DeliveryMode, Methodology

    if effective_methodology == Methodology.AGILE:
        if board_cadence == BoardCadence.CONTINUOUS:
            return str(DeliveryMode.KANBAN)
        return str(DeliveryMode.SCRUM)
    return str(DeliveryMode.WATERFALL)


def resolve_default_classification(
    project: Project, *, workspace: object | None = None
) -> tuple[str, str]:
    """``(governance_class, delivery_mode)`` defaults for a new task on ``project``.

    Resolves ``project``'s ``effective_methodology`` (workspace → program →
    project precedence, ADR-0107) once and derives both fields from it, so a
    caller needing both never resolves methodology twice. ``workspace`` is
    accepted so a caller iterating many tasks against the same project can pass
    the already-loaded singleton (mirrors the other resolvers in this app);
    otherwise it is loaded here.
    """
    from trueppm_api.apps.projects.methodology import resolve_effective_methodology

    effective_methodology = resolve_effective_methodology(project, workspace=workspace)  # type: ignore[arg-type]
    return (
        resolve_default_governance_class(effective_methodology),
        resolve_default_delivery_mode(effective_methodology, project.board_cadence),
    )
