"""Bundled sample projects and the demo-data loader (issue #375).

Sample seed files are committed JSON fixtures (ADR-0109 format) under
``apps/projects/fixtures/seeds/``. ``load_sample`` imports one through the
shared importer and flags every created project ``is_sample`` so the UI can
show a "this is demo data" banner and offer one-click teardown.

The registry is the single source of truth for which samples ship; the other
sample issues (#617/#618/#619) register their fixtures here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from django.db import transaction

from trueppm_api.apps.projects.models import (
    Program,
    Project,
    Sprint,
    SprintState,
    Task,
)
from trueppm_api.apps.projects.seed.importer import import_seed

_SEEDS_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "seeds"


@dataclass(frozen=True)
class Sample:
    """A bundled sample project available to the demo-data loader."""

    key: str
    title: str
    description: str
    filename: str

    @property
    def path(self) -> Path:
        return _SEEDS_DIR / self.filename


# The default sample is the launch demo (#620): the hybrid-large program that
# proves the agile/waterfall bridge end to end.
SAMPLES: dict[str, Sample] = {
    "atlas-platform-launch": Sample(
        key="atlas-platform-launch",
        title="Atlas Platform Launch",
        description=(
            "Hybrid-large launch program — three projects (agile, waterfall, hybrid), "
            "cross-project dependencies, three-point estimates, baselines, and a risk register."
        ),
        filename="atlas-platform-launch.json",
    ),
    "aurora-mobile-app": Sample(
        key="aurora-mobile-app",
        title="Aurora Mobile App",
        description=(
            "Agile-only — a mobile team running the sprint lifecycle with velocity history "
            "and a Kanban board. No CPM, no estimates: the pure-scrum tour."
        ),
        filename="aurora-mobile-app.json",
    ),
    "bayside-civic-center": Sample(
        key="bayside-civic-center",
        title="Bayside Civic Center",
        description=(
            "Waterfall-only construction project — CPM with all four dependency types, "
            "three-point estimates, a captured baseline, and a populated risk register."
        ),
        filename="bayside-civic-center.json",
    ),
    "helios-crm-replacement": Sample(
        key="helios-crm-replacement",
        title="Helios CRM Replacement",
        description=(
            "Hybrid-small — a completed waterfall planning phase feeding an agile build "
            "phase, with a cross-phase dependency. The entry-level hybrid story."
        ),
        filename="helios-crm-replacement.json",
    ),
}

DEFAULT_SAMPLE = "atlas-platform-launch"


class UnknownSampleError(ValueError):
    """Raised when a sample key is not in the registry."""


def load_sample(key: str, *, owner: Any, create_users: bool = True) -> Program:
    """Import a bundled sample and mark its projects as sample data.

    ``create_users`` defaults True: a sample references its demo personas, and
    loading the demo is an explicit owner/admin action, so the persona accounts
    are created (with unusable passwords) to make the board render fully. This
    differs from the generic import endpoint, which never mints logins.

    Raises:
        UnknownSampleError: if ``key`` is not registered.
        SeedValidationError: if the bundled fixture fails validation.
    """
    sample = SAMPLES.get(key)
    if sample is None:
        raise UnknownSampleError(f"Unknown sample {key!r}. Known: {sorted(SAMPLES)}")

    payload: dict[str, Any] = json.loads(sample.path.read_text(encoding="utf-8"))

    with transaction.atomic():
        # is_sample marks every created project as demo data (for the UI banner +
        # teardown) and selects the demo importer semantics: shared-persona
        # resource reuse and the sample-safe idempotency guard in
        # _replace_existing.
        program = import_seed(payload, owner=owner, create_users=create_users, is_sample=True)
    return program


def _first_open_sprint(program: Program) -> Sprint | None:
    """Return the program's earliest *open* sprint (ACTIVE, else PLANNED).

    "Open" = a sprint a contributor can still pick up work in. ACTIVE wins over
    PLANNED so a freshly-loaded demo drops the evaluator into the sprint that is
    live *now*; within a state the earliest ``start_date`` is the natural first
    one to walk. Returns ``None`` for an all-completed or sprintless sample
    (e.g. the waterfall-only Bayside sample has no sprints).
    """
    base = Sprint.objects.filter(
        project__program=program,
        project__is_deleted=False,
        is_deleted=False,
    )
    for state in (SprintState.ACTIVE, SprintState.PLANNED):
        sprint = base.filter(state=state).order_by("start_date", "name").first()
        if sprint is not None:
            return sprint
    return None


def prepare_sample_for_user(program: Program, user: Any) -> Project | None:
    """Assign the first open sprint's work to ``user`` so My Work is populated (#1054).

    A contributor who loads a demo from the My Work empty state needs to *see
    their own assigned work* immediately — otherwise the page they land on is as
    empty as the one they left, and the adoption flywheel never starts. We take
    the program's first open sprint (see :func:`_first_open_sprint`) and reassign
    its non-milestone tasks to the loading user, returning the owning project so
    the caller can land them on that board.

    Idempotent: tasks already assigned to ``user`` are skipped, so re-loading the
    same sample does not churn ``server_version``. Returns ``None`` when the
    sample has no open sprint — the caller then falls back to the program
    overview.
    """
    sprint = _first_open_sprint(program)
    if sprint is None:
        return None

    # Milestones are gates, not work you pick up; leave them off a contributor's
    # My Work list. Already-assigned tasks are skipped to keep the call idempotent.
    tasks = list(
        Task.objects.filter(sprint=sprint, is_deleted=False, is_milestone=False).exclude(
            assignee=user
        )
    )
    for task in tasks:
        task.assignee = user
        # Attribute the reassignment to the loading user in the audit history.
        task._history_user = user  # type: ignore[attr-defined]
        # save() force-bumps server_version (VersionedModel) so the sync delta
        # carries the new assignee. No board broadcast is needed: the program was
        # just created and has no live subscribers, and Task has no post_save
        # broadcast signal — board events are emitted explicitly at the view layer.
        task.save(update_fields=["assignee"])
    return sprint.project
