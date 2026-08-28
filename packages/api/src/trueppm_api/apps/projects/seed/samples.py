"""Bundled sample projects and the demo-data loader (issue #375).

Sample seed files are committed JSON fixtures (ADR-0109 format) under
``apps/projects/fixtures/seeds/``. ``load_sample`` imports one through the
shared importer and flags every created project ``is_sample`` so the UI can
show a "this is demo data" banner and offer one-click teardown.

The registry is the single source of truth for which samples ship; the other
sample issues (#617/#618/#619) register their fixtures here.
"""

from __future__ import annotations

import hashlib
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
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.services import ensure_project_resource

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
        """Absolute path to the fixture.

        Built from the *package* directory and this entry's own ``filename`` —
        never from caller input. The download endpoint (#2490) reaches a path
        only by looking a key up in :data:`SAMPLES` and reading this attribute,
        so no request-supplied string ever participates in path construction.
        """
        return _SEEDS_DIR / self.filename


@dataclass(frozen=True)
class SampleMetadata:
    """Everything the catalog advertises about one fixture, from a single read.

    ``size_bytes``, ``sha256`` and the entity counts are all derived from *one*
    read of *one* byte string, so the hash a client verifies and the counts it
    was shown provably describe the same file. Computing them separately would
    let them drift across a fixture edit and silently make the advertised digest
    a lie.

    ``schema_version`` and the counts are ``None`` when the document could not be
    parsed — a fixture we cannot summarize is still bytes on disk, and those
    bytes are exactly what an auditor wants, so the file stays downloadable
    (#2490 state 3). ``available`` is False only when the registered file is
    absent from disk, which means a broken install rather than a bad document.
    """

    available: bool
    size_bytes: int | None
    sha256: str | None
    schema_version: str | None
    project_count: int | None
    task_count: int | None
    resource_count: int | None


# Memo keyed on (path, st_mtime_ns, st_size) — see `sample_metadata`.
_METADATA_CACHE: dict[tuple[str, int, int], SampleMetadata] = {}

_MISSING = SampleMetadata(
    available=False,
    size_bytes=None,
    sha256=None,
    schema_version=None,
    project_count=None,
    task_count=None,
    resource_count=None,
)


def sample_metadata(sample: Sample) -> SampleMetadata:
    """Return size, digest and entity counts for a bundled fixture (#2490).

    Lazy and memoized rather than computed at import time: precomputing would
    move ~174 KB of JSON parsing into every worker boot *and* every management
    command — including ``migrate`` and ``collectstatic``, which have no business
    reading fixtures — and would turn a malformed fixture into a startup crash
    instead of one degraded row.

    The memo key includes ``st_mtime_ns`` and ``st_size`` so a developer editing
    a fixture sees fresh numbers without restarting the server. It is a plain
    module-level dict, not the Django cache: these are read-only files inside the
    installed package, so there is no invalidation problem to solve, and a shared
    cache would add a failure mode (an entry surviving a deploy) that a
    process-local dict cannot have.

    The counts come from ``inspect_seed`` — the same pure function backing the
    dry run (ADR-0651). Never a second counting implementation: if this listing
    and ``POST /programs/import/validate/`` could disagree about a file, the
    catalog would have failed at its one job.
    """
    from trueppm_api.apps.projects.seed.validation import inspect_seed

    path = sample.path
    try:
        stat = path.stat()
    except OSError:
        # Registered but not on disk — a broken install. Reported honestly
        # rather than 500ing the whole catalog for one bad entry.
        return _MISSING

    cache_key = (str(path), stat.st_mtime_ns, stat.st_size)
    cached = _METADATA_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        raw = path.read_bytes()
    except OSError:
        return _MISSING

    digest = hashlib.sha256(raw).hexdigest()
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        payload = None

    if isinstance(payload, dict):
        report = inspect_seed(payload)
        metadata = SampleMetadata(
            available=True,
            size_bytes=len(raw),
            sha256=digest,
            schema_version=report.schema_version,
            project_count=report.project_count,
            task_count=report.task_count,
            resource_count=report.resource_count,
        )
    else:
        # Unparseable, but present: advertise what we can prove from the bytes
        # (size, digest) and leave the summary blank. Download stays available.
        metadata = SampleMetadata(
            available=True,
            size_bytes=len(raw),
            sha256=digest,
            schema_version=None,
            project_count=None,
            task_count=None,
            resource_count=None,
        )

    _METADATA_CACHE[cache_key] = metadata
    return metadata


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
            "Agile-only — a mobile team running the sprint lifecycle: an epic-grouped "
            "backlog, velocity history, and a Kanban board. No CPM, no estimates: the "
            "pure-scrum tour."
        ),
        filename="aurora-mobile-app.json",
    ),
    "bayside-civic-center": Sample(
        key="bayside-civic-center",
        title="Bayside Civic Center",
        description=(
            "Waterfall-only construction program — two phased projects (structure + "
            "fit-out) joined by cross-project dependencies, with all four dependency "
            "types, three-point estimates, a contract baseline plus a change-order "
            "rebaseline, and a populated risk register."
        ),
        filename="bayside-civic-center.json",
    ),
    "ga-launch": Sample(
        key="ga-launch",
        title="1.0 GA Launch",
        description=(
            "Program coordination — four workstreams (platform, SOC 2, security, launch) "
            "shipping one outcome, joined by cross-project dependencies and shared people "
            "who over-allocate. Carries the per-project 5-role matrix and a WIP-limited "
            "remediation board."
        ),
        filename="ga-launch.json",
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


def sample_accounts(key: str) -> list[dict[str, Any]]:
    """Return a sample fixture's ``accounts[]`` entries (username, display_name, …).

    Lets ``load_sample_project --with-personas`` print the real, sample-namespaced
    persona usernames (e.g. ``atlas-alex``) an evaluator must actually sign in as —
    the gap that made the evaluation guide's "Sign in as Alex" instructions dead-end
    (#1760).

    Raises:
        UnknownSampleError: if ``key`` is not registered.
    """
    sample = SAMPLES.get(key)
    if sample is None:
        raise UnknownSampleError(f"Unknown sample {key!r}. Known: {sorted(SAMPLES)}")
    payload: dict[str, Any] = json.loads(sample.path.read_text(encoding="utf-8"))
    accounts: list[dict[str, Any]] = payload.get("accounts", [])
    return accounts


def load_sample(
    key: str,
    *,
    owner: Any,
    create_users: bool = True,
    persona_password: str | None = None,
) -> Program:
    """Import a bundled sample and mark its projects as sample data.

    ``create_users`` defaults True: a sample references its demo personas, and
    loading the demo is an explicit owner/admin action, so the persona accounts
    are created to make the board render fully. This differs from the generic
    import endpoint, which never mints logins.

    ``persona_password`` (default ``None``) leaves those created personas with an
    unusable password. When set — only via ``load_sample_project --with-personas``,
    which gates the value behind DEBUG/env (#1760, mirroring #1350) — the created
    personas become loginable so an evaluator can sign in as each one.

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
        program = import_seed(
            payload,
            owner=owner,
            create_users=create_users,
            is_sample=True,
            persona_password=persona_password,
            # "Load demo data" is a reload-in-place button, so the consent that
            # ADR-0726 requires of a caller-authored import is given here once,
            # structurally. It is safe to hard-code because the sample path
            # cannot reach real work: `_replace_existing` refuses any program
            # holding a non-sample project (#2476), so replace=True can only
            # ever tear down demo data the same click created.
            replace=True,
        )
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

    _move_allocation_to_user(tasks, user, sprint.project)
    return sprint.project


def _move_allocation_to_user(tasks: list[Task], user: Any, project: Project) -> None:
    """Re-point the reassigned tasks' allocation at the loading user (#2900).

    Reassigning ``assignee`` alone leaves ``TaskResource`` pointing at the demo
    persona, so the two disagree: the board shows the evaluator owning the work
    while every capacity surface still bills it to somebody else. That is the same
    split this issue exists to close, reintroduced one layer up — capacity,
    utilization and the heatmap read ``TaskResource.units`` and never
    ``Task.assignee``.

    The loading user needs a ``Resource`` of their own to receive it. One is
    created on demand and reused on a reload (matched on the ``user`` FK, which is
    the identity link — ``name``/``email`` are not unique on ``Resource``).

    Allocation is *moved*, not added: the units the persona held on that task
    transfer, so a task never ends up double-billed to two people. Tasks the seed
    left unallocated stay unallocated — there is nothing to move.
    """
    if not tasks:
        return

    rows = list(TaskResource.objects.filter(task__in=tasks))
    if not rows:
        return

    resource = Resource.objects.filter(user=user).first()
    if resource is None:
        display = (user.get_full_name() or "").strip() or user.get_username()
        resource = Resource.objects.create(name=display, email=user.email or "", user=user)

    moved: list[TaskResource] = []
    for row in rows:
        if row.resource_id == resource.pk:
            # Idempotent: a reload finds the allocation already moved.
            continue
        # A task can legitimately carry several people. Only the row that was
        # billed to the previous assignee moves; a genuine co-assignment stays.
        row.resource = resource
        moved.append(row)

    if moved:
        # The unique (task, resource) constraint makes a collision possible if the
        # loading user was ALREADY allocated to one of these tasks. Drop the
        # duplicate rather than fail the whole demo load — the user keeps one
        # allocation on that task either way.
        existing = set(
            TaskResource.objects.filter(task__in=tasks, resource=resource).values_list(
                "task_id", flat=True
            )
        )
        keep = [row for row in moved if row.task_id not in existing]
        drop = [row.pk for row in moved if row.task_id in existing]
        if drop:
            TaskResource.objects.filter(pk__in=drop).delete()
        if keep:
            TaskResource.objects.bulk_update(keep, ["resource"])

    ensure_project_resource(project, resource)
