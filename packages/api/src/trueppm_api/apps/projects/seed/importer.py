"""Import a canonical JSON seed document into the database (ADR-0109, issue #615).

``import_seed`` validates a payload (#614) and then materializes one program,
its projects, tasks, dependencies, sprints, baselines, risks, resources, and
memberships inside a single transaction. File-local slugs and ltree wbs paths
are resolved to freshly-minted UUIDs through in-memory symbol tables; nothing in
the seed file carries a UUID.

Re-import is keyed on the program slug (persisted in ``Program.code``). The seed
format carries no stable entity ids until 0.5 (#1959), so a field-level merge has
nothing to key on and wipe-then-rebuild remains the right idempotency model —
but it is destructive, so as of ADR-0726 it requires explicit consent
(``replace=True``) and is *recoverable*: a real program's subtree is
**soft**-deleted into Trash with tombstones and per-project delete broadcasts.
Only the disposable demo path (``is_sample``) still hard-deletes, which is what
that data is for (ADR-0109).

The seeded tasks carry no CPM outputs (those are derived), so a schedule
recalculation is enqueued per project after commit; a board broadcast is
likewise deferred to ``transaction.on_commit``.

Writes are batched (ADR-0726 §8). The whole run sits inside
``coalesce_sync_seq()`` so the per-row delta-cursor allocation collapses to one
draw per project, and the O(n) collections go through ``_bulk_insert``, which
hand-maintains the three things ``VersionedModel.save()`` would otherwise do for
free — ``server_version``, ``sync_seq``, and the ``simple_history`` row.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from decimal import Decimal
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from simple_history.utils import bulk_create_with_history

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.access.services import create_program
from trueppm_api.apps.projects.models import (
    AcceptanceCriterion,
    BacklogItem,
    Baseline,
    BaselineTask,
    BoardColumnConfig,
    Calendar,
    CalendarException,
    CeremonyTemplate,
    Dependency,
    DorState,
    EstimateStatus,
    Label,
    Program,
    Project,
    Risk,
    RiskTask,
    Sprint,
    Task,
    TaskAttachment,
    TaskLabel,
    TaskRecurrenceRule,
    TaskRelation,
    TaskSource,
    TaskStatus,
    bulk_create_tasks,
)
from trueppm_api.apps.projects.seed.forecast_backfill import (
    backfill_forecast_history,
    backfill_monte_carlo_run_history,
)
from trueppm_api.apps.projects.seed.reldates import (
    WorkingCalendar,
    resolve_anchor,
    resolve_date,
    resolve_timestamp,
)
from trueppm_api.apps.projects.seed.replace import resolve_replace_candidates
from trueppm_api.apps.projects.seed.replay import ReplayContext, replay_timeline
from trueppm_api.apps.projects.seed.validation import validate_seed
from trueppm_api.apps.resources.models import (
    Resource,
    ResourceSkill,
    Skill,
    TaskResource,
    TaskSkillRequirement,
)
from trueppm_api.apps.resources.services import ensure_project_resource
from trueppm_api.apps.scheduling.services import enqueue_recalculate
from trueppm_api.apps.sync.broadcast import broadcast_board_event
from trueppm_api.apps.sync.sequence import allocate_for_projects, coalesce_sync_seq
from trueppm_api.apps.timetracking.models import TimeEntry, TimesheetSubmission

logger = logging.getLogger(__name__)

_UTC = ZoneInfo("UTC")

#: Most days of synthesized time one task contributes on the sample path (#3490).
#: The most recent days of a long waterfall task are what a timesheet shows; an
#: uncapped fill would write a row per person per working day for months.
_TIME_FILL_MAX_DAYS = 40

#: The seed's proficiency names -> ``Proficiency`` integers (#3498).
_PROFICIENCY_BY_NAME = {"beginner": 1, "intermediate": 2, "expert": 3}

#: Weekday names -> the ``TaskRecurrenceRule.weekdays`` bitmask (Mon=1 … Sun=64).
_WEEKDAY_BIT = {"mon": 1, "tue": 2, "wed": 4, "thu": 8, "fri": 16, "sat": 32, "sun": 64}

#: Rows per INSERT statement in the batched passes (ADR-0726 §8).
#:
#: Django's PostgreSQL backend does not override ``bulk_batch_size``, so an
#: unbounded ``bulk_create`` emits *one* statement for the whole project. With
#: psycopg's default client-side binding that is a single mogrified string
#: holding every literal — ``Task`` has ~57 columns, and the history table adds
#: five more — so an adversarially dense document would build a multi-hundred-MB
#: statement (twice, row + history) before Postgres ever sees it. Worker memory
#: is the binding resource once the import is async, so the batch is capped.
_BULK_BATCH_SIZE = 500

# Stand-in reason for a ``blocked`` cluster that carries no ``reason`` (#4082). The
# exporter withholds the ADR-0124 private text from anyone but the assignee or an
# @-mentioned user, but ``blocked_reason`` is the flag-of-record — emptiness means
# "not blocked". Importing the bare cluster as-is would silently unblock the task
# and drop the age/type/link triage signal the export deliberately kept, so a
# present cluster with no reason imports as blocked with this placeholder.
_PRIVATE_BLOCKER_REASON = "(private)"

# Ceiling for a TaskResource synthesized from a bare ``assignee`` (#2900). The
# actual units are ``min(this, resource.max_units)`` — a bare assignee means "this
# person is on this task at their normal availability", so a half-time engineer
# lands at 0.5 and a 10% advisor at 0.1 rather than all of them at 1.0.
#
# That distinction is load-bearing for the demo the packs exist to give: they
# deliberately staff part-timers and 10% advisors ("not everyone is at 100%", per
# the sample-projects docs), and billing an advisor a full unit would put her at
# 1000% on every task she owns — an all-red heatmap misrepresenting the very
# capacity story the fixture was authored to tell. A seed that wants some other
# split says so with an explicit ``assignments`` array, which always wins.
_ASSIGNEE_MAX_UNITS = Decimal("1.0")


class SeedReplaceRequired(Exception):
    """A live program the caller owns holds this seed's slug and ``replace`` was not given.

    Raised *before* anything is written. Carries the resolved ``Program`` so the
    view can render the ``409`` conflict body without re-running the ownership
    query — and so the only program that can ever be named is one the resolver
    already proved the caller owns (#994).
    """

    def __init__(self, program: Program) -> None:
        self.program = program
        super().__init__(f"A program you own already uses the code {program.code!r}.")


class SeedReplaceMismatch(Exception):
    """``expected_program_id`` did not match the program that would actually be replaced.

    The compare-and-swap failure. A client that resolved a conflict via the dry
    run and then acted on it is protected from the collision set having changed
    underneath it in the meantime — the alternative, a bare ``replace=True``,
    would silently follow the change and destroy a different program.
    """


class SeedReplaceAmbiguous(Exception):
    """Several live programs the caller owns hold this slug, and none was named.

    ``Program.code`` carries no uniqueness constraint, so owning two programs
    under one code is legitimate. A confirmation can only describe one of them,
    so replacing the whole set would destroy a program the caller was never
    shown a count for — ``expected_program_id`` is the way out.
    """


User = get_user_model()

# Program membership role names in the seed map to the Role integer ladder.
_ROLE_BY_NAME = {
    "VIEWER": Role.VIEWER,
    "MEMBER": Role.MEMBER,
    "SCHEDULER": Role.SCHEDULER,
    "ADMIN": Role.ADMIN,
    "OWNER": Role.OWNER,
}


def import_seed(
    payload: dict[str, Any],
    *,
    owner: Any,
    create_users: bool = False,
    is_sample: bool = False,
    persona_password: str | None = None,
    replace: bool = False,
    expected_program_id: str | None = None,
    target_program: Program | None = None,
) -> Program:
    """Validate and import a seed document, returning the created ``Program``.

    Args:
        payload: a parsed seed document (already JSON-decoded).
        owner: the ``User`` who owns the imported program (gets OWNER membership).
        create_users: when ``True``, ``accounts[]`` that name no existing user
            are created (used by ``make seed`` / the management command). When
            ``False`` (the REST default), missing accounts resolve to ``None`` —
            importing a seed must not silently mint logins on a live instance.
        is_sample: when ``True`` this is the disposable demo/sample path
            (``load_sample``). It marks every created project ``is_sample`` and
            reuses the shared persona resource catalog. When ``False`` (the
            generic ``import_seed`` path) imported resources are created fresh so
            a seed can never bind a pre-existing global resource — and the real
            user it may carry — into the importer's program (#1004).
        persona_password: when set (and ``is_sample``), persona accounts are given
            this as a usable login password so an evaluator can actually sign in as
            each persona (#1760). Applies both to accounts this run creates and to
            pre-existing persona rows that carry **no usable password of their own**
            (#3484 — a reload is the common case, and skipping those made the CLI
            report a login it had not enabled). A real account's password is never
            overwritten, and staff/superuser rows are never touched. ``None`` (the
            default) leaves personas with an unusable password, as before. Only the
            server-curated sample path passes this; the caller is responsible for
            never letting a fixed weak value reach a public instance (see the
            ``load_sample_project --with-personas`` DEBUG/env gate, mirroring #1350).
        replace: authorizes tearing down a live program of the caller's that
            already holds this seed's slug (ADR-0726, #2581). ``False`` — the
            default, and the only safe default — raises
            :class:`SeedReplaceRequired` instead, so a re-import can never
            destroy real work that the caller did not name.
        expected_program_id: optional compare-and-swap token. When given it must
            equal the id of the program that would actually be replaced, or
            :class:`SeedReplaceMismatch` is raised. Protects a client acting on a
            dry run from a collision set that moved in between.
        target_program: adopt this pre-created ``Program`` shell instead of
            minting one (ADR-0726 §4). The async path creates the shell inside
            the request — so the destructive replace happens in the request the
            operator authorized, and the caller has somewhere to land — and hands
            it here for the worker to fill. ``None`` keeps the create-it-myself
            behavior the management command and ``load_sample`` rely on.

    Raises:
        SeedValidationError: if the payload fails validation; nothing is written.
        SeedReplaceRequired: if a live program collides and ``replace`` is False.
        SeedReplaceMismatch: if ``expected_program_id`` names a different program.
    """
    # Agent actions and share links are evidence and credentials: only the
    # server-curated sample path (``load_sample``, the one caller that passes
    # is_sample) may carry them, the same trust line ``persona_password`` uses.
    validate_seed(payload, allow_sample_sections=is_sample)
    importer = _SeedImporter(
        payload,
        owner=owner,
        create_users=create_users,
        is_sample=is_sample,
        persona_password=persona_password,
        replace=replace,
        expected_program_id=expected_program_id,
        target_program=target_program,
    )
    # coalesce_sync_seq draws one delta cursor per project for the whole import
    # instead of one per row (ADR-0686). Rows written together may share a
    # sync_seq — the delta is `> since` and the checkpoint is the maximum, so a
    # batch lands wholly on one side of any client checkpoint.
    with transaction.atomic(), coalesce_sync_seq():
        program = importer.run()
    return program


@dataclass
class _TaskFields:
    """Fields derived from one seed task's document before the ``Task`` is built.

    Split out of :meth:`_SeedImporter._build_task` so the derivation (pure,
    read-only) and the ``Task(...)`` construction it feeds are separately
    readable; see that method's callers for the business rules behind each
    field.
    """

    sprint: Sprint | None
    assignee: Any
    is_milestone: bool
    estimate_fields: dict[str, Any]
    final_status: str
    planned_start: date | None
    story_points: Any
    base_status: str
    base_percent: float
    base_remaining: Any


class _SeedImporter:
    """Holds the per-import symbol tables while materializing a seed document."""

    def __init__(
        self,
        payload: dict[str, Any],
        *,
        owner: Any,
        create_users: bool,
        is_sample: bool = False,
        persona_password: str | None = None,
        replace: bool = False,
        expected_program_id: str | None = None,
        target_program: Program | None = None,
        provenance_kind: str = TaskSource.SEED_IMPORT,
        provenance_source_id: uuid.UUID | None = None,
    ) -> None:
        self.payload = payload
        self.owner = owner
        self.create_users = create_users
        self.is_sample = is_sample
        self.persona_password = persona_password
        self.replace = replace
        self.expected_program_id = expected_program_id
        self.target_program = target_program
        #: Seed provenance stamped on every task this run creates (ADR-0786).
        #: Parameterized rather than hard-coded because #2729's template seeding
        #: materializes through this same importer and must record itself as
        #: ``TaskSource.TEMPLATE`` with the template's id, not as a seed import.
        self.provenance_kind = provenance_kind
        self.provenance_source_id = provenance_source_id
        #: Program this run tore down, for the caller's audit record. None when
        #: nothing collided.
        self.replaced_program_id: str | None = None
        self.users: dict[str, Any] = {}
        self.calendars: dict[str, Calendar] = {}
        self.resources: dict[str, Resource] = {}
        # account slug -> Resource, so a task carrying only ``assignee`` (an
        # ACCOUNT slug) can still be given the TaskResource row that capacity,
        # utilization and the heatmap actually read (#2900).
        self.resources_by_account: dict[str, Resource] = {}
        self.projects: dict[str, Project] = {}
        # global task / sprint indices keyed by (project_slug, local_id)
        self.tasks: dict[tuple[str, str], Task] = {}
        self.sprints: dict[tuple[str, str], Sprint] = {}
        # Label index keyed by (project_slug, label_slug) — ADR-0400 labels folded
        # into the seed (#1958). Populated in Pass A, consumed by the Pass B
        # ``_link_task_labels`` attach step.
        self.labels: dict[tuple[str, str], Label] = {}
        # v2 (ADR-0114): relative dates resolve against an anchor (import day),
        # and an events timeline is replayed with backdated history. v1 docs set
        # the major to "1", so replay is off and dates are plain ISO literals.
        self.replay = str(payload.get("schema_version", "")).split(".")[0] == "2"
        self.anchor: date = resolve_anchor(payload, date.today())
        # (project_slug, wbs_path) -> earliest authored timeline beat naming that
        # task, so a synthesized creation-history date can never land after a
        # comment/status/estimate/etc. the seed itself dated against the task
        # (#3487). Indexed once up front — Pass A builds tasks project by
        # project, but the events timeline is not project-scoped.
        self.earliest_task_event: dict[tuple[str, str], date] = self._index_earliest_task_events()
        # (project_slug, wbs_path) of every task the timeline dates a status move
        # against, so ``_build_task`` can tell a task that is *moved* into the
        # backlog from one that simply lives there (#3488). Indexed here for the
        # same reason as the map above: Pass A is project-scoped, the timeline is
        # not.
        self.authored_status_targets: set[tuple[str, str]] = self._index_authored_status_targets()
        self.working_calendars: dict[str, WorkingCalendar] = {}
        self.risks_by_slug: dict[str, Risk] = {}
        # Desired END states for replay — tasks/sprints are created at a base
        # state and walked forward to these by the timeline + synthesizer.
        self.final_status: dict[tuple[str, str], str] = {}
        self.final_sprint: dict[tuple[str, str], dict[str, Any]] = {}
        # Authored progress for tasks that end IN_PROGRESS or REVIEW, restored
        # by replay's ``_finalize_tasks`` (#3486, widened #3518). Holds only
        # the keys the document wrote.
        self.final_progress: dict[tuple[str, str], dict[str, Any]] = {}
        # (project_slug, wbs_path) -> the task's acceptance criteria in position
        # order (#3492); built in Pass B, handed to replay for task.ac_met ticks.
        self.criteria: dict[tuple[str, str], list[AcceptanceCriterion]] = {}

    def run(self) -> Program:
        # Adopting a pre-created shell means the caller already resolved and
        # performed the replacement inside the request it was authorized in
        # (ADR-0726 §4). Running the teardown again here would be actively
        # wrong, not merely redundant: the shell itself now carries this seed's
        # slug and the caller owns it, so it would match its own candidate query
        # and soft-delete the program it was handed to fill.
        if self.target_program is None:
            self._replace_existing()
        self._resolve_accounts()
        self._resolve_calendars()
        self._resolve_resources()
        program = self._create_program()

        # Pass A: create each project's structure (sprints, tasks). This fills
        # the global task/sprint indices so Pass B can resolve cross-project
        # references and links that may point anywhere in the program.
        for project_data in self.payload["projects"]:
            self._create_project_structure(program, project_data)

        # Pass B: wire links that may reference tasks created in any project.
        for project_data in self.payload["projects"]:
            project = self.projects[project_data["slug"]]
            self._link_dependencies(project, project_data)
            self._link_parent_epics(project_data)
            self._link_sprint_milestones(project_data)
            self._link_task_labels(project_data)
            self._link_task_relations(project_data["slug"], project_data)
            self._resolve_blockers(project_data)
            self._create_attachments(project_data)
            self._create_acceptance_criteria(project_data)
            self._create_recurrence_rules(project_data)
            self._create_skill_requirements(project_data)
            self._assign_resources(project, project_data)
            self._capture_baselines(project, project_data)
            self._create_risks(project, project_data.get("risks", []), project_data["slug"])

        self._create_program_risks(program)
        # v2.1 program sections (#3603). After Pass B so a pulled backlog item can
        # link a task in any project.
        self._create_backlog_items(program)
        self._create_ceremonies(program)

        # Pass C (v2 only): replay the events timeline + synthesized fill so the
        # demo reads as a program that has run for months — backdated history,
        # real burndown/velocity, scope-injection audit. Runs inside this same
        # transaction under the seed_replay flag (side effects suppressed).
        if self.replay:
            replay_timeline(self.payload, self._replay_context())

        # Sample-only v2.1 passes (#3603), after replay: time fills the *actual*
        # windows replay stamped, submissions read the time just written, and the
        # agent trail and share links reference the finished program. Each method
        # returns immediately off the sample path.
        self._synthesize_time()
        self._synthesize_timesheet_submissions()
        self._create_share_links()

        # Pass D (#376): backfill ProjectForecastSnapshot history for any project
        # that authored a forecast_history block. Runs after replay so task_count /
        # completed_task_count reflect the final replayed state, and still inside the
        # import transaction so a failure rolls the whole import back (ADR-0211).
        self._backfill_forecast_history()

        # Last write of the import, deliberately. record_agent_action takes the
        # instance-wide chain-head row lock and holds it to commit, so every live MCP
        # read that must record an audit row waits behind it. Anything written after
        # it would widen that window for no reason.
        self._record_sample_agent_actions()

        project_ids = [str(p.pk) for p in self.projects.values()]
        # Seeded tasks have no CPM dates; recompute so the schedule renders.
        # Both effects are deferred to post-commit so they never fire on a
        # rolled-back import.
        for pid in project_ids:
            transaction.on_commit(partial(enqueue_recalculate, project_id=pid))

            # A direct call rather than partial(broadcast_board_event, ...): the WS
            # freeze guard AST-scans for the event-type literal in the argument slot
            # of a ``broadcast_board_event`` call, and under partial the callee name
            # is ``partial``, which makes the literal invisible to it. The default
            # argument pins the loop variable.
            def _emit_created(project_id: str = pid) -> None:
                broadcast_board_event(project_id, "project_created", {"id": project_id})

            transaction.on_commit(_emit_created)
        return program

    # --- v2 date resolution + replay --------------------------------------

    def _build_working_calendar(self, cal: Calendar | None) -> WorkingCalendar:
        """Calendar facts for weekend-snapping: bitmask + materialized exceptions."""
        if cal is None:
            return WorkingCalendar()
        exc: set[date] = set()
        for e in cal.exceptions.all()[:500]:
            d = e.exc_start
            while d <= e.exc_end and len(exc) < 5000:
                exc.add(d)
                d += timedelta(days=1)
        try:
            tz = ZoneInfo(cal.timezone) if cal.timezone else ZoneInfo("UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        return WorkingCalendar(working_days=cal.working_days, exception_dates=frozenset(exc), tz=tz)

    def _wc(self, project_slug: str | None) -> WorkingCalendar:
        if project_slug is None:
            return WorkingCalendar()
        return self.working_calendars.get(project_slug) or WorkingCalendar()

    def _date(self, value: str, project_slug: str | None, *, snap: bool = True) -> date:
        """Resolve a required seed date. v1 ISO literals pass straight through.

        ``snap`` forward to the next working day is right for *plan* dates, which
        cannot legitimately fall on a non-working day. Pass ``snap=False`` for a
        date recording something that already happened: history is not confined
        to working days, and snapping it forward misstates when it occurred.
        """
        return resolve_date(value, anchor=self.anchor, calendar=self._wc(project_slug), snap=snap)

    @staticmethod
    def _blocker_reason(blocked: dict[str, Any] | None) -> str:
        """Reason text for a task's ``blocked`` cluster; ``""`` when not blocked."""
        if not blocked:
            return ""
        return str(blocked.get("reason") or "").strip() or _PRIVATE_BLOCKER_REASON

    def _date_opt(
        self, value: str | None, project_slug: str | None, *, snap: bool = True
    ) -> date | None:
        return self._date(value, project_slug, snap=snap) if value else None

    def _creation_dt(self, when: date) -> datetime:
        """A backdated creation timestamp (UTC 09:00) for replay history rows."""
        return datetime(when.year, when.month, when.day, 9, 0, tzinfo=ZoneInfo("UTC"))

    def _index_earliest_task_events(self) -> dict[tuple[str, str], date]:
        """Earliest ``task:<project>:<wbs>`` beat in the authored events timeline.

        Only the target parsing matters here (mirrors ``replay._resolve_task``);
        the action doesn't — a comment, an assignment, a status move, all of them
        are things that happened *to* the task, so all of them bound how early
        its own creation row is allowed to be. A seed that references a task
        before it declares a plan for it (comment predates any baseline) still
        gets a consistent, in-order history: the creation row simply follows the
        earliest thing anyone said about it.
        """
        earliest: dict[tuple[str, str], date] = {}
        for event in self.payload.get("events", []):
            target = event.get("target", "")
            if not target.startswith("task:"):
                continue
            _, _, ref = target.partition(":")
            project_slug, _, wbs = ref.partition(":")
            when = resolve_timestamp(event["at"], anchor=self.anchor).date()
            key = (project_slug, wbs)
            if key not in earliest or when < earliest[key]:
                earliest[key] = when
        return earliest

    def _index_authored_status_targets(self) -> set[tuple[str, str]]:
        """Tasks the authored events timeline moves with a ``task.status`` beat.

        Unlike :meth:`_index_earliest_task_events`, the action *is* the point
        here: only a dated column move tells ``_build_task`` that a task's final
        status is somewhere the timeline walks it to, rather than where it was
        born. The literal action key is repeated rather than imported from
        ``replay._TASK_STATUS_ACTION`` — it is private to that module, and the
        codebase already restates it per-module (see ``validation``'s
        ``_EVENT_TARGET_KIND``).
        """
        targets: set[tuple[str, str]] = set()
        for event in self.payload.get("events", []):
            if event.get("action") != "task.status":
                continue
            target = event.get("target", "")
            if not target.startswith("task:"):
                continue
            _, _, ref = target.partition(":")
            project_slug, _, wbs = ref.partition(":")
            targets.add((project_slug, wbs))
        return targets

    # --- batched inserts (ADR-0726 §8) -------------------------------------

    @staticmethod
    def _short_id_block(project_id: Any, count: int) -> list[str]:
        """Reserve ``count`` consecutive ``short_id`` values for one project.

        ``Task.save()`` / ``Sprint.save()`` allocate one at a time from
        ``Project.object_sequence`` (an ``UPDATE … + 1`` plus a read-back, so two
        round-trips *per row*). Batched inserts bypass ``save()`` entirely, and a
        row that skipped the allocation would carry ``short_id = ""`` — which the
        ``unique_(task|sprint)_short_id_per_project`` constraints turn into an
        IntegrityError on the second row.

        Advancing the counter by ``count`` in one statement reserves the whole
        block atomically: the read-back is the last value, so the block is
        ``[new - count + 1, new]``. Two round-trips per batch instead of two per
        row, and the values stay in the same hex format and the same shared
        Task/Sprint/Risk sequence as the per-row path.
        """
        if count <= 0:
            return []
        Project.objects.filter(pk=project_id).update(object_sequence=F("object_sequence") + count)
        last: int = Project.objects.values_list("object_sequence", flat=True).get(pk=project_id)
        return [f"{seq:08X}" for seq in range(last - count + 1, last + 1)]

    def _bulk_insert(
        self,
        model: type[Any],
        rows: list[Any],
        *,
        project_ids: list[Any] | None = None,
        history_dates: list[date] | None = None,
    ) -> None:
        """Insert ``rows`` in one round-trip while preserving what ``save()`` does.

        ``bulk_create`` skips three things a ``VersionedModel.save()`` performs,
        and every one of them fails *silently* rather than loudly:

        1. ``server_version = 1`` on the INSERT branch. ``sync/conflict.py``
           slices ``current - base_version`` history rows for the ADR-0217
           field-level merge, so a row at version 0 is arithmetically broken.
        2. The ``sync_seq`` delta cursor (ADR-0686). A row that never allocates
           stays at 0, and ``sync_seq__gt=since`` never returns it — *not even on
           a cold start with ``since=0``*. The rows would be permanently
           invisible to every offline client. One value is drawn per project and
           shared across the batch, which ``coalesce_sync_seq``'s contract
           explicitly permits.
        3. The ``simple_history`` row, written here by
           ``bulk_create_with_history`` for models that record history.

        Args:
            model: the concrete model being inserted.
            rows: instances to insert. Empty is a no-op.
            project_ids: owning projects for the cursor draw. ``None`` means the
                model is outside the sync union (no cursor, no history) and a
                plain ``bulk_create`` is correct.
            history_dates: parallel to ``rows``; the backdated ``history_date``
                for each. Used only under v2 replay, where a task's creation row
                is dated to when the entity came into being rather than to import
                time. Rows are grouped by date so the number of INSERT batches is
                bounded by the distinct dates (the sprint count), not the rows.
        """
        if not rows:
            return
        if project_ids is None:
            model.objects.bulk_create(rows, batch_size=_BULK_BATCH_SIZE)
            return

        seq = allocate_for_projects(list(project_ids))
        for row in rows:
            row.server_version = 1
            row.sync_seq = seq

        # Keyed on the row's own pk, not on ``id(row)``: every model here has a UUID
        # primary key assigned at construction, so this survives a caller that hands
        # the insert a re-materialized instance rather than the identical object.
        date_by_row: dict[Any, date] = (
            {row.pk: when for row, when in zip(rows, history_dates, strict=True)}
            if history_dates is not None
            else {}
        )

        def _insert(batch: Any) -> None:
            """The INSERT itself, over whatever slice of ``rows`` it is handed.

            Taken as a closure so the Task path can wrap it (see below) without the
            declaration pass having to know which of the three insert shapes applies.
            """
            batch = list(batch)
            if not hasattr(model, "history"):
                model.objects.bulk_create(batch, batch_size=_BULK_BATCH_SIZE)
                return
            if not date_by_row:
                bulk_create_with_history(
                    batch, model, batch_size=_BULK_BATCH_SIZE, default_user=self.owner
                )
                return
            by_date: dict[date, list[Any]] = defaultdict(list)
            for row in batch:
                by_date[date_by_row[row.pk]].append(row)
            for when, group in by_date.items():
                bulk_create_with_history(
                    group,
                    model,
                    batch_size=_BULK_BATCH_SIZE,
                    default_user=self.owner,
                    default_date=self._creation_dt(when),
                )

        if model is Task:
            # A seed pack has phases, and `bulk_create` reaches none of the
            # declaration that `Task.save()` paths run — so without this a seeded
            # phase lands `structure_role='work'` with children and the Board
            # renders it as a card (#3030). Routed through the same funnel as the
            # importers rather than re-derived here.
            bulk_create_tasks(rows, insert=_insert)
            return
        _insert(rows)

    def _save_new(self, instance: Any, created_on: date) -> Any:
        """Insert ``instance``, backdating its creation history row under replay.

        Under v2 replay the creation row is dated to when the entity came into
        being (its window/sprint start), not import time, so the History tab and
        activity timeline read chronologically. v1 import saves normally.
        """
        if self.replay:
            instance._history_date = self._creation_dt(created_on)
            instance._history_user = self.owner
        instance.save()
        return instance

    def _replay_context(self) -> ReplayContext:
        lead_project = next(iter(self.projects.values()), None)
        try:
            tz = ZoneInfo(getattr(lead_project, "timezone", "") or "UTC")
        except Exception:
            tz = ZoneInfo("UTC")
        return ReplayContext(
            anchor=self.anchor,
            program_code=self.payload["program"]["slug"],
            default_actor=self.owner,
            users=self.users,
            tasks=self.tasks,
            sprints=self.sprints,
            projects=self.projects,
            project_calendars=self.working_calendars,
            risks=self.risks_by_slug,
            final_status=self.final_status,
            final_sprint=self.final_sprint,
            final_progress=self.final_progress,
            tz=tz,
            criteria=self.criteria,
        )

    # --- idempotency -------------------------------------------------------

    def _replace_existing(self) -> None:
        """Tear down a prior import the caller owns that holds this seed's slug.

        Re-import rebuilds the *caller's own* program with this slug (keyed on
        ``Program.code``, which carries it). Three guards, in order of how badly
        each one's absence would hurt:

        **Ownership (#994).** Candidates come from
        :func:`~trueppm_api.apps.projects.seed.replace.resolve_replace_candidates`,
        which restricts them to programs the importing ``owner`` holds a live
        OWNER ``ProgramMembership`` on. ``Program.code`` is user-assigned and
        non-unique, so collisions between strangers are realistic and enumerable;
        without this scope any authenticated user could destroy a victim's
        program and every child project/task/sprint/risk/baseline by crafting a
        seed whose ``slug`` matches the victim's code. ``select_for_update``
        locks each candidate so a concurrent member-add or project-assign cannot
        resurrect a ``PROTECT``-ed reference mid-teardown.

        **Consent (#2581, ADR-0726).** Even against the caller's own data the
        teardown is refused unless ``replace`` was explicitly given, and
        ``expected_program_id`` — when supplied — must name the program that
        would actually go. Both refusals raise *before* the first write.

        **Sample scoping (#2476).** On the demo path (``is_sample``) a program
        containing any real (non-sample) project is never replaced, so a sample
        reload cannot purge real work even within the caller's own programs.

        Non-sample programs are **soft**-deleted: the subtree lands in Trash,
        offline clients receive tombstones, and each removed project emits a
        ``project_deleted`` broadcast. Sample programs keep the hard delete —
        disposable demo data is what it is for — but route through
        ``hard_delete_program``, which resolves the ``PROTECT``-ing set from
        ``_meta`` rather than the hand-written list that rotted in #2364.
        """
        from trueppm_api.apps.access.services import hard_delete_program
        from trueppm_api.apps.projects.services import soft_delete_program_subtree

        slug = self.payload["program"]["slug"]
        candidates = resolve_replace_candidates(self.owner, slug, lock=True)
        if self.is_sample:
            # A mixed program (real projects under a sample slug) is never torn
            # down. Filtering here rather than inside the loop keeps the consent
            # check below from refusing on a candidate we would have skipped.
            candidates = [
                prog
                for prog in candidates
                if not Project.objects.filter(
                    program=prog, is_sample=False, is_deleted=False
                ).exists()
            ]
        if not candidates:
            return

        # Narrow to the named program before consenting, so the set the caller
        # authorized and the set actually torn down are the same one.
        # ``Program.code`` is non-unique by design, so a caller can legitimately
        # own two programs under this slug; ``SeedReplaceRequired`` can only
        # carry one, and destroying the rest would be exactly the unconsented
        # deletion this whole gate exists to stop.
        if self.expected_program_id is not None:
            named = [p for p in candidates if str(p.pk) == str(self.expected_program_id)]
            if not named:
                raise SeedReplaceMismatch(
                    "expected_program_id does not name the program that would be replaced."
                )
            candidates = named

        if not self.replace:
            raise SeedReplaceRequired(candidates[0])
        if len(candidates) > 1:
            raise SeedReplaceAmbiguous(
                f"You own {len(candidates)} live programs using the code "
                f"{slug!r}. Pass expected_program_id to name the one to replace."
            )

        target = candidates[0]
        self.replaced_program_id = str(target.pk)
        if self.is_sample:
            # Capture the doomed project ids before the rows go: a hard delete
            # leaves no tombstone, so the broadcast is the only signal a client
            # holding these rows will ever get (the #2581 defect, on the branch
            # ADR-0726 deliberately left hard). Mirrors ``remove_sample``.
            doomed = [
                str(pk)
                for pk in Project.objects.filter(program=target).values_list("pk", flat=True)
            ]
            program_id = str(target.pk)
            hard_delete_program(target.pk)
            for doomed_id in doomed:

                def _emit_hard_deleted(project_id: str = doomed_id) -> None:
                    broadcast_board_event(project_id, "project_hard_deleted", {"id": project_id})

                transaction.on_commit(_emit_hard_deleted)
            transaction.on_commit(
                lambda: broadcast_board_event(program_id, "program_deleted", {"id": program_id})
            )
        else:
            soft_delete_program_subtree(target, actor=self.owner, reason="seed_replace")

    # --- top-level entities ------------------------------------------------

    def _resolve_accounts(self) -> None:
        for account in self.payload.get("accounts", []):
            username = account["username"]
            user = User.objects.filter(username=username).first()
            if user is None and self.create_users:
                # ``password`` is only non-None on the server-curated sample path
                # when the operator opted into loginable personas via
                # ``--with-personas`` (#1760); ``None`` yields an unusable password
                # (create_user's default), so no dormant weak login is ever minted
                # implicitly.
                user = User.objects.create_user(
                    username=username,
                    email=account.get("email", ""),
                    first_name=account.get("display_name", "").split(" ")[0],
                    password=self.persona_password if self.is_sample else None,
                )
            elif user is not None:
                self._enable_existing_persona_login(user)
            # #1057: on the generic import path (create_users=False, the REST
            # default) a seed's accounts[].username is attacker-controlled and may
            # collide with a *pre-existing* real user. Binding that user here would
            # let a crafted seed pull a known victim into the importer's program —
            # as a ProgramMembership (_grant_program_memberships), the program lead,
            # a task assignee, or a resource's user FK. Resolve such accounts to
            # None so the generic path never associates a real account it did not
            # create. The owner is exempt (their own account), and the server-
            # curated sample/demo path (is_sample) binds personas freely.
            if (
                user is not None
                and not self.create_users
                and not self.is_sample
                and user != self.owner
            ):
                user = None
            self.users[account["slug"]] = user

    def _enable_existing_persona_login(self, user: Any) -> None:
        """Give a *pre-existing* persona account the requested demo password (#3484).

        Loading a sample is idempotent, so the second run is the common one: the
        persona rows already exist from an earlier plain ``load_sample_project``
        (or from the demo compose stack), and only the *creation* branch above ever
        applied ``persona_password``. ``--with-personas`` therefore printed
        "Persona logins enabled" over fifteen accounts whose ``has_usable_password()``
        was still False and whose ``POST /auth/token/`` still 401'd — the command
        asserted a state it had not produced.

        Two conditions bound this, and they are what keep it out of the #1057
        account-hijack case:

        * ``is_sample`` — the usernames come from a **server-curated** bundled
          fixture, not from a caller-supplied seed. ``persona_password`` is only
          ever non-None on that path (the REST ``load-sample`` action never passes
          it), so no caller can steer which username gets a password.
        * the account must have **no usable password of its own**. That is the
          discriminator for "the importer minted this row", since an interactively
          registered account always carries one. Nothing a real user set is ever
          overwritten, which is the invariant
          ``test_persona_password_never_repasswords_existing_user`` pins.

        Privileged accounts are refused outright even when unusable: handing a
        known password to a staff/superuser row would be a full takeover, and the
        sample's OWNER persona can legitimately be the program owner on a stack
        with no superuser (``_resolve_owner``'s third fallback).

        The residual the two conditions do not cover: an **SSO-provisioned** account
        also carries an unusable password (``sso.services`` calls
        ``set_unusable_password`` on JIT signup), so one holding a username that
        collides with a sample persona slug would be given a local password here.
        It is accepted rather than guarded, because the preconditions are narrow —
        an operator explicitly running ``--with-personas``, on an SSO instance,
        where a federated user holds a ``<sample-key>-<name>`` username — and
        because the command now names every account it enabled, so the operator
        sees it rather than being told fifteen logins work.
        """
        if not (self.is_sample and self.create_users and self.persona_password):
            return
        if user.is_staff or user.is_superuser or user.has_usable_password():
            return
        # Seeded demo persona, not an interactive signup, so password validators
        # do not apply — the value is already gated behind DEBUG/env by the caller.
        # nosemgrep: unvalidated-password
        user.set_password(self.persona_password)
        user.save(update_fields=["password"])

    def _resolve_calendars(self) -> None:
        for cal in self.payload.get("calendars", []):
            # Calendar.name carries no uniqueness constraint, so a plain
            # get_or_create raises MultipleObjectsReturned (unhandled 500) when the
            # shared catalog already holds two calendars of this name — the #2267
            # bug class. Reuse the first match and only create when none exists.
            defaults = {
                "working_days": cal.get("working_days", 31),
                "hours_per_day": cal.get("hours_per_day", 8.0),
                "timezone": cal.get("timezone", "UTC"),
            }
            obj = Calendar.objects.filter(name=cal["name"]).first() or Calendar.objects.create(
                name=cal["name"], **defaults
            )
            self.calendars[cal["slug"]] = obj
            self._resolve_calendar_exceptions(obj, cal.get("exceptions", []))

    def _resolve_calendar_exceptions(
        self, calendar: Calendar, exceptions: list[dict[str, Any]]
    ) -> None:
        """Materialize a calendar's non-working ranges (holidays, PTO) — #376.

        Exceptions resolve against the import anchor (relative dates land exactly —
        a holiday is a fact, never weekend-snapped) and are created idempotently on
        ``(calendar, exc_start, exc_end)``. Calendars are a shared global catalog
        that ``_replace_existing`` does not wipe on a sample reload, so get_or_create
        keeps a reload from accumulating duplicate PTO rows. Materializing them here
        (before the per-project structure pass) means ``_build_working_calendar``
        picks them up, so a PTO range also removes those days from date snapping —
        one source of non-working truth (ADR-0211).
        """
        for exc in exceptions:
            start = resolve_date(exc["exc_start"], anchor=self.anchor, snap=False)
            end = resolve_date(exc["exc_end"], anchor=self.anchor, snap=False)
            # (calendar, exc_start, exc_end) is the intended idempotency key but has
            # no DB uniqueness constraint, so a plain get_or_create raises
            # MultipleObjectsReturned once two identical ranges exist (#2267 class).
            # Reuse the first match; only create when the range is absent.
            exists = CalendarException.objects.filter(
                calendar=calendar, exc_start=start, exc_end=end
            ).exists()
            if not exists:
                CalendarException.objects.create(
                    calendar=calendar,
                    exc_start=start,
                    exc_end=end,
                    description=exc.get("description", ""),
                )

    def _resolve_resources(self) -> None:
        for res in self.payload.get("resources", []):
            calendar = self.calendars.get(res["calendar"]) if res.get("calendar") else None
            # account_user is already None on the generic path for any account that
            # resolved to a pre-existing real user — _resolve_accounts drops those
            # (#1057), so the resource's user FK cannot bind a victim here.
            account_user = self.users.get(res["account"]) if res.get("account") else None
            defaults = {
                "name": res["name"],
                "email": res.get("email", ""),
                "job_role": res.get("job_role", ""),
                "max_units": res.get("max_units", 1.0),
                "calendar": calendar,
                "user": account_user,
            }
            if self.is_sample:
                # Demo path: resources are a global catalog and have no slug
                # column; reuse the shared persona rows by email (else name) so a
                # sample reload does not accumulate duplicate demo people.
                #
                # Neither ``email`` nor ``name`` is unique, and the generic branch
                # below creates fresh rows unconditionally — so the catalog can
                # legitimately already hold two rows matching this lookup. A plain
                # ``get_or_create`` would then raise ``MultipleObjectsReturned`` (an
                # unhandled 500 the nightly fuzzer hit on a generic-import-then-
                # sample-load sequence, #2267). Reuse the first existing match and
                # only create when none exists, which keeps the dedup intent while
                # tolerating a pre-existing duplicate.
                lookup = {"email": res["email"]} if res.get("email") else {"name": res["name"]}
                obj = Resource.objects.filter(**lookup).first() or Resource.objects.create(
                    **defaults
                )
            else:
                # Generic import (#1004): never match a live global resource by
                # email. Doing so would bind a pre-existing resource — and the
                # real ``user`` FK it may carry — into the importer's project via
                # ``_assign_resources``. Create a fresh row so an attacker-crafted
                # seed cannot pull a real user's resource into their program.
                obj = Resource.objects.create(**defaults)
            self.resources[res["slug"]] = obj
            account = res.get("account")
            if account:
                self.resources_by_account[account] = obj
            self._assign_resource_skills(obj, res.get("skills", []))

    def _assign_resource_skills(self, resource: Resource, skills: list[dict[str, Any]]) -> None:
        """Attach a resource's skills from the workspace catalog (#3498).

        ``Skill`` is de-duplicated on the case-folded name — the normalization
        ``SkillSerializer.create`` applies — so "Python" authored by two samples lands
        on one catalog row. On the sample path a resource is reused across reloads,
        so an existing ``ResourceSkill`` is updated in place rather than duplicated.
        """
        for entry in skills:
            name = entry["name"].strip()
            skill, _ = Skill.objects.get_or_create(
                normalized_name=name.casefold(),
                defaults={"name": name, "category": entry.get("category", "")},
            )
            proficiency = _PROFICIENCY_BY_NAME[entry.get("proficiency", "intermediate")]
            row = ResourceSkill.objects.filter(
                resource=resource, skill=skill, is_deleted=False
            ).first()
            if row is None:
                ResourceSkill.objects.create(
                    resource=resource, skill=skill, proficiency=proficiency
                )
            elif row.proficiency != proficiency:
                row.proficiency = proficiency
                row.save(update_fields=["proficiency"])

    def _create_program(self) -> Program:
        """Mint the program, or adopt the shell the caller pre-created (ADR-0726 §4).

        The async path creates the shell inside the request — so the replace it
        may have performed stays in the request the operator authorized, and the
        202 can name a program to land on — then hands it here for the worker to
        fill. Either way the seed's display fields and memberships are applied
        identically, so the two paths cannot produce different programs.
        """
        data = self.payload["program"]
        if self.target_program is not None:
            program = self.target_program
            # Re-apply the document's own fields over the shell. The view builds
            # the shell from this same payload, so this is normally a no-op — but
            # asserting it here means the adopted program is defined by the seed,
            # not by whatever the view happened to pass.
            program.name = data["name"]
            program.description = data.get("description", "")
            program.methodology = data["methodology"]
        else:
            program = create_program(
                name=data["name"],
                description=data.get("description", ""),
                methodology=data["methodology"],
                created_by=self.owner,
            )
        # Persist the slug as the natural key + carry display fields.
        program.code = data["slug"]
        if data.get("color"):
            program.color = data["color"]
        lead = self.users.get(data["lead"]) if data.get("lead") else None
        if lead is not None:
            program.lead = lead
        # Per-scope Monte Carlo forecast-history overrides (#3494, ADR-0144).
        # Both are NULL-means-inherit on the model, so only set them when the
        # seed authors them explicitly — an absent key must not clobber the
        # workspace default with a false "explicitly disabled".
        if "mc_history_enabled" in data:
            program.mc_history_enabled = data["mc_history_enabled"]
        if "mc_history_attribution_audience" in data:
            program.mc_history_attribution_audience = data["mc_history_attribution_audience"]
        # Record the anchor every relative date in this document was resolved
        # against, so the drift is computable later (ADR-1175, #3481).
        #
        # Sample path only. A caller-authored import is somebody's real program;
        # stamping it would advertise a "Shift dates to today" action that would
        # bulk-rewrite real work, and `shift_sample_dates` refuses on `is_sample`
        # anyway — so a non-NULL anchor there would be a field promising something
        # the server will not do.
        if self.is_sample:
            program.sample_anchor_date = self.anchor
        program.save(
            update_fields=[
                "code",
                "color",
                "lead",
                "name",
                "description",
                "methodology",
                "mc_history_enabled",
                "mc_history_attribution_audience",
                "sample_anchor_date",
            ]
        )
        self._grant_program_memberships(program)
        return program

    def _grant_program_memberships(self, program: Program) -> None:
        for account in self.payload.get("accounts", []):
            user = self.users.get(account["slug"])
            role = _ROLE_BY_NAME.get(account.get("role", ""))
            if user is None or role is None or user == self.owner:
                continue  # owner already has OWNER from create_program
            # is_deleted/deleted_version are in the defaults, not just role: on a
            # re-import over a program where this account was previously removed,
            # the tombstoned row still owns the (program, user) slot, so an update
            # that touched only `role` would report success and confer nothing
            # (#3410). A seed grant must always leave the member with access.
            ProgramMembership.objects.update_or_create(
                program=program,
                user=user,
                defaults={"role": role, "is_deleted": False, "deleted_version": None},
            )

    def _grant_project_memberships(self, project: Project, data: dict[str, Any]) -> None:
        """Grant the seed's accounts a ``ProjectMembership`` on this project (#3092).

        Project access is scoped by ``ProjectMembership`` — ``ProgramMembership``
        alone reaches the program rail and *no* project. Before this the importer
        granted only the owner, so every seeded persona signed in to an empty
        project list and the documented evaluation walkthrough dead-ended on its
        "sign in as atlas-alex" step.

        Two modes, and the fallback is what keeps existing packs working:

        * ``members`` **declared** — use exactly those pairs. This is the only way
          to express one person holding different roles on different projects,
          which is what makes project-scoped RBAC demonstrable at all.
        * ``members`` **omitted** — grant every account its program-level role.
          Equivalent to the flat roster a v2 seed already describes, so a fixture
          written before this key existed gains working access without an edit.

        The owner is skipped: they were granted OWNER unconditionally by the
        caller, and a seed must never be able to *demote* the importing user on
        their own project. Accounts that resolved to ``None`` — a pre-existing
        real user on an untrusted import (see ``_resolve_accounts``) — are skipped
        by the same guard that protects every other account reference, so a
        crafted seed cannot pull a stranger into a project it does not own.
        """
        declared = data.get("members")
        if declared is None:
            pairs = [
                (account["slug"], account.get("role", ""))
                for account in self.payload.get("accounts", [])
            ]
        else:
            pairs = [(entry["account"], entry["role"]) for entry in declared]

        for account_slug, role_name in pairs:
            user = self.users.get(account_slug)
            role = _ROLE_BY_NAME.get(role_name)
            if user is None or role is None or user == self.owner:
                continue
            # Un-tombstone alongside the role — see _grant_program_memberships
            # (#3410). Defensive here rather than load-bearing: the project row
            # this runs against was created moments ago in
            # _create_project_structure, so no tombstone can exist yet. It is
            # stated anyway so the invariant survives the day a project is reused,
            # which is exactly how the program-side path acquired the defect.
            # source_group is cleared for the same reason the members endpoint
            # clears it: a seed grant is a direct grant, and leaving a revoked
            # row's group provenance set would let a later workspace-group
            # reconcile revoke access the seed just conferred.
            ProjectMembership.objects.update_or_create(
                project=project,
                user=user,
                defaults={
                    "role": role,
                    "is_deleted": False,
                    "deleted_version": None,
                    "source_group": None,
                },
            )

    # --- per-project structure (Pass A) ------------------------------------

    def _create_project_structure(self, program: Program, data: dict[str, Any]) -> None:
        slug = data["slug"]
        calendar = self.calendars.get(data["calendar"]) if data.get("calendar") else None
        # Build the working-calendar facts first so relative dates snap against
        # this project's calendar (weekends + exceptions).
        self.working_calendars[slug] = self._build_working_calendar(calendar)
        project = Project.objects.create(
            program=program,
            name=data["name"],
            description=data.get("description", ""),
            start_date=self._date(data["start_date"], slug),
            calendar=calendar,
            methodology=data["methodology"],
            code=data.get("code", ""),
            default_view=data.get("default_view", "SCHEDULE"),
            estimation_mode=data.get("estimation_mode", "open"),
            # PM health override (#520). Seeds may pin a project off AUTO so the
            # program overview shows a mix of computed and hand-set chips.
            health=data.get("health", "AUTO"),
            # is_sample is owned by the importer so the idempotency guard in
            # _replace_existing can distinguish disposable demo data from real
            # work on a later reload (#994).
            is_sample=self.is_sample,
        )
        # Workstream lead (#3098). Distinct from both the program lead and the
        # OWNER membership: on a program of parallel workstreams the lead is who
        # the program manager asks about this project, and it is what the project
        # header and the program roll-up display. Resolved after create() because
        # the account may be declared later in the same document.
        lead_slug = data.get("lead")
        if lead_slug:
            lead_user = self.users.get(lead_slug)
            if lead_user is not None:
                project.lead = lead_user
                project.save(update_fields=["lead"])
        self.projects[slug] = project
        ProjectMembership.objects.update_or_create(
            project=project,
            user=self.owner,
            defaults={
                "role": Role.OWNER,
                "is_deleted": False,
                "deleted_version": None,
                "source_group": None,
            },
        )
        self._grant_project_memberships(project, data)
        # After the grants: the default team's membership rows are mirrored from them.
        self._apply_team(project, data)
        self._create_board_config(project, data)

        self._create_project_labels(project, slug, data)
        sprint_rows = self._create_project_sprints(project, slug, data)
        self._create_project_tasks(project, slug, data)
        self._refresh_active_sprint_burndown(sprint_rows)

    def _create_project_labels(self, project: Project, slug: str, data: dict[str, Any]) -> None:
        """Create the project's label catalog (Pass A).

        Order within Pass A is load-bearing: labels, then sprints, then tasks.
        ``_build_task`` reads ``self.sprints`` for a task's sprint assignment,
        and Pass B's ``_link_task_labels`` reads ``self.labels`` — so both
        registries must be populated before the task loop runs.
        """
        # Labels (ADR-0400, #1958): the project's curated label catalog. Created
        # here in Pass A so the Pass B ``_link_task_labels`` step can attach each
        # task's slugged labels once all tasks exist. Slugs are file-local and
        # project-scoped; the seed carries no label UUID (0.5 adds that, #1959).
        label_rows = []
        for label_data in data.get("labels", []):
            label = Label(
                project=project,
                name=label_data["name"],
                color=label_data.get("color", "slate"),
                position=label_data.get("position", 0),
                created_by=self.owner,
            )
            label_rows.append(label)
            self.labels[(slug, label_data["slug"])] = label
        self._bulk_insert(Label, label_rows, project_ids=[project.pk])

    def _create_project_sprints(
        self, project: Project, slug: str, data: dict[str, Any]
    ) -> list[Sprint]:
        """Create the project's sprints and return the rows.

        The rows are returned rather than re-queried because
        ``_refresh_active_sprint_burndown`` needs the in-memory instances: they
        came from ``bulk_create`` and the caller has not re-read them.
        """
        sprint_rows: list[Sprint] = []
        sprint_dates: list[date] = []
        for sprint_data in data.get("sprints", []):
            start = self._date(sprint_data["start_date"], slug)
            finish = self._date(sprint_data["finish_date"], slug)
            # Under replay the sprint is born PLANNED and walked to its end state
            # by activate/close beats (authored or synthesized); points are
            # snapshotted at those beats. v1 import sets the end state directly.
            sprint = Sprint(
                project=project,
                name=sprint_data["name"],
                goal=sprint_data.get("goal", ""),
                notes=sprint_data.get("notes", ""),
                start_date=start,
                finish_date=finish,
                state="PLANNED" if self.replay else sprint_data["state"],
                committed_points=None if self.replay else sprint_data.get("committed_points"),
                completed_points=None if self.replay else sprint_data.get("completed_points"),
                capacity_points=sprint_data.get("capacity_points"),
            )
            sprint_rows.append(sprint)
            sprint_dates.append(start)
            self.sprints[(slug, sprint_data["slug"])] = sprint
            if self.replay:
                self.final_sprint[(slug, sprint_data["slug"])] = {
                    "state": sprint_data["state"],
                    "committed_points": sprint_data.get("committed_points"),
                    "completed_points": sprint_data.get("completed_points"),
                }
        for sprint, short_id in zip(
            sprint_rows, self._short_id_block(project.pk, len(sprint_rows)), strict=True
        ):
            sprint.short_id = short_id
        self._bulk_insert(
            Sprint,
            sprint_rows,
            project_ids=[project.pk],
            history_dates=sprint_dates if self.replay else None,
        )
        return sprint_rows

    def _create_project_tasks(self, project: Project, slug: str, data: dict[str, Any]) -> None:
        """Create the project's tasks (Pass A). Runs after sprints — see above."""
        task_rows: list[Task] = []
        task_dates: list[date] = []
        planning_beat = self._project_planning_beat(project, slug, data)
        for task_data in data.get("tasks", []):
            task, created_on = self._build_task(project, slug, task_data, planning_beat)
            task_rows.append(task)
            task_dates.append(created_on)
        self._stamp_new_tasks(task_rows, project)
        # One batch per project. The three Task post_save receivers are all
        # no-ops on INSERT — two early-return on ``created``, and the milestone
        # rollup short-circuits because ``Sprint.target_milestone`` is not linked
        # until Pass B — so nothing is lost by skipping the signal.
        self._bulk_insert(
            Task,
            task_rows,
            project_ids=[project.pk],
            history_dates=task_dates if self.replay else None,
        )

    def _stamp_new_tasks(self, rows: list[Task], project: Project) -> None:
        """Apply everything ``Task.save()`` does on INSERT that ``bulk_create`` skips.

        Three stamps, each of which would otherwise be a silent data defect:

        * ``short_id`` — reserved as one block (see :meth:`_short_id_block`);
          without it every row carries ``""`` and the per-project unique
          constraint rejects the second one.
        * ``status_changed_at`` — ``_stamp_status_change`` treats an INSERT as a
          transition from ``None``, so every created task is stamped. Column
          charts and the stale-task threshold read it.
        * the sign-off percent coercion — REVIEW and COMPLETE both imply 100%
          delivered work, and a v1 seed authors those states directly. Without
          it a seeded COMPLETE task reports its authored ``percent_complete``
          and the ring, strip, and SPI math disagree with the column the card
          sits in.

        ``_stamp_blocker_transition`` is deliberately not replicated: on INSERT it
        only acts when ``blocked_reason`` is non-empty, and the seed schema has no
        blocker fields, so it is a guaranteed no-op here.

        Seed provenance (ADR-0786, #2730) is stamped here too, and ``edited_at`` is
        deliberately left null: these rows were written by a machine and nobody has
        touched them yet, which is exactly what makes them eligible for the
        "Delete untouched rows (N)" sweep for the next seven days.
        """
        if not rows:
            return
        now = timezone.now()
        for task, short_id in zip(rows, self._short_id_block(project.pk, len(rows)), strict=True):
            task.short_id = short_id
            task.status_changed_at = now
            task.source_kind = self.provenance_kind
            task.source_id = self.provenance_source_id
            task.seeded_at = now
            if task.status in (TaskStatus.REVIEW, TaskStatus.COMPLETE):
                task.percent_complete = 100.0

    def _refresh_active_sprint_burndown(self, sprints: list[Sprint]) -> None:
        """Upsert today's burn row once per ACTIVE sprint, not once per task.

        ``Task.save()`` emits ``task_status_changed`` on INSERT, whose receiver
        upserts the sprint's burndown row. Batching skips the signal, so the
        effect is reproduced here — but per *sprint* rather than per task, which
        is what the receiver's own idempotent upsert was collapsing to anyway.

        Skipped under seed replay for the same reason the receiver skips it: the
        timeline drives backdated burndown per simulated day, and stamping
        today's row would collapse the curve to a single point (ADR-0114).
        """
        from trueppm_api.apps.projects.seed.replay_ctx import is_seed_replay_active

        if is_seed_replay_active():
            return
        from trueppm_api.apps.projects.models import SprintState
        from trueppm_api.apps.projects.services import upsert_burndown_for_sprint

        for sprint in sprints:
            if sprint.state != SprintState.ACTIVE:
                continue
            try:
                upsert_burndown_for_sprint(sprint)
            except Exception:
                logger.exception("seed import: burndown upsert failed for sprint=%s", sprint.pk)

    def _project_planning_beat(self, project: Project, slug: str, data: dict[str, Any]) -> date:
        """The creation-history anchor for the project's non-sprint tasks (#3487).

        Prefers the project's earliest *declared* baseline capture — the moment
        the plan was first committed to paper, which in every bundled sample
        predates any comment or status beat authored against a task in it —
        falling back to the project's own start date when the seed declares no
        baseline. Reads the raw seed dict rather than ``Baseline`` rows: Pass B
        (``_capture_baselines``) hasn't run yet when Pass A builds tasks.
        """
        captured = [
            self._date_opt(bl.get("captured_at"), slug, snap=False)
            for bl in data.get("baselines", [])
        ]
        earliest = min((c for c in captured if c is not None), default=None)
        return earliest if earliest is not None else project.start_date

    def _sprint_creation_beat(self, project_slug: str, wbs_path: str, sprint: Sprint) -> date:
        """A sprint-bound task's creation beat: a few days before the sprint starts.

        Never the sprint's own ``start_date`` (#3487) — a story exists before
        sprint planning seats it in a sprint, so backdating creation to exactly
        kickoff still reads as "born the moment planning began". The lead time is
        derived from a stable hash of the task's own key, never wall-clock time
        or unseeded randomness, so a reload reproduces the same history
        (ADR-0114).
        """
        digest = hashlib.sha256(f"{project_slug}:{wbs_path}".encode()).digest()
        lead_days = 2 + (digest[0] % 4)  # 2-5 days before kickoff
        return sprint.start_date - timedelta(days=lead_days)

    def _derive_task_fields(self, project_slug: str, data: dict[str, Any]) -> _TaskFields:
        sprint = self.sprints.get((project_slug, data["sprint"])) if data.get("sprint") else None
        assignee = self.users.get(data["assignee"]) if data.get("assignee") else None
        is_milestone = data.get("is_milestone", False)

        # Three-point estimate is all-or-none and never set on milestones
        # (ADR-0093). Seeded estimates are PM-authored, so they import ACCEPTED.
        # Folded into the create() so an estimated task is one INSERT, not two.
        estimate = data.get("estimate") if not is_milestone else None
        estimate_fields = (
            {
                "optimistic_duration": estimate["optimistic"],
                "most_likely_duration": estimate["most_likely"],
                "pessimistic_duration": estimate["pessimistic"],
                "estimate_status": EstimateStatus.ACCEPTED,
            }
            if estimate
            else {}
        )

        final_status = data.get("status", "NOT_STARTED")
        planned_start = self._date_opt(data.get("planned_start"), project_slug)
        story_points = data.get("story_points")

        # Under replay a task that ends in-flight/done is born NOT_STARTED and
        # walked forward by the timeline + synthesizer; its creation row is
        # backdated to when work could have begun (sprint/planned/project start).
        progresses = self.replay and final_status in ("IN_PROGRESS", "REVIEW", "COMPLETE")

        # BACKLOG is off the progression spine — an ordinary backlog item is born
        # there and the synthesizer deliberately refuses to walk anything to it
        # (``replay._PROGRESSION_INDEX`` has no entry), so it must NOT be folded
        # into ``progresses``: born NOT_STARTED with nothing to move it, it would
        # strand at NOT_STARTED forever. But a sprint close that carries an
        # unfinished task back to the backlog (#3488) *is* an event-driven move
        # into BACKLOG, and the exporter reconstructs it as a dated ``task.status``
        # beat. Born already at BACKLOG that beat is a no-op (``_apply_task_status``
        # returns when the column already matches), so no history row exists and
        # the re-export drops the event — breaking the #616 byte-identical round
        # trip. The document itself distinguishes the two cases: only the carried
        # task has a ``task.status`` beat dated against it.
        decommits = (
            self.replay
            and final_status == "BACKLOG"
            and (project_slug, data["wbs_path"]) in self.authored_status_targets
        )
        base_status = "NOT_STARTED" if (progresses or decommits) else final_status
        # Progress fields stay keyed on ``progresses`` alone: a carried task walks
        # only its column, so re-basing its percent/remaining would invent numbers
        # nothing later restores (``_finalize_tasks`` only rescues IN_PROGRESS and
        # REVIEW), and the re-export would then disagree about those fields.
        base_percent = 0.0 if progresses else data.get("percent_complete", 0.0)
        base_remaining = story_points if progresses else data.get("remaining_points")

        return _TaskFields(
            sprint=sprint,
            assignee=assignee,
            is_milestone=is_milestone,
            estimate_fields=estimate_fields,
            final_status=final_status,
            planned_start=planned_start,
            story_points=story_points,
            base_status=base_status,
            base_percent=base_percent,
            base_remaining=base_remaining,
        )

    def _task_creation_beat(
        self, project_slug: str, data: dict[str, Any], planning_beat: date, sprint: Sprint | None
    ) -> date:
        """The date this task's creation-history row backdates to (#3487).

        A sprint-bound task backdates to shortly before its sprint kicks off;
        everything else backdates to the project's own planning beat (earliest
        baseline capture, else project start) — never to ``planned_start``, which
        is a future schedule position, not a record of when the task came into
        being, and is exactly what put creation rows months into the future
        before this fix. Two further clamps, both required: an authored event
        against this task (comment, status move, …) is honored as an even
        earlier floor when the seed talks about the task before its plan
        existed, and the anchor is a hard ceiling so a reload never manufactures
        a future-dated creation row regardless of how far out the task or
        sprint is planned.
        """
        beat = (
            self._sprint_creation_beat(project_slug, data["wbs_path"], sprint)
            if sprint
            else planning_beat
        )
        earliest_event = self.earliest_task_event.get((project_slug, data["wbs_path"]))
        if earliest_event is not None and earliest_event < beat:
            beat = earliest_event
        return min(beat, self.anchor)

    def _capture_replay_progress(
        self, project_slug: str, data: dict[str, Any], final_status: str
    ) -> None:
        """Record the authored progress fields a replayed task should be restored to.

        A task born at 0%/full-points to give the timeline room to walk it
        forward never gets those numbers back on its own — COMPLETE is rescued
        by ``Task._coerce_signoff_percent``, IN_PROGRESS is not (#3486). REVIEW
        is a mixed case (#3518): the same coercion fixes ``percent_complete`` to
        100 by design ("work done, awaiting sign-off"), but ``remaining_points``
        has no such contract — a story in review with points still open is a
        real, authorable state — so REVIEW only hands back ``remaining_points``,
        never ``percent_complete``, to avoid fighting the coercion. Hand replay
        the authored values to restore, keyed per field so a dated
        ``task.points`` beat still wins where the document declared nothing.
        """
        self.final_status[(project_slug, data["wbs_path"])] = final_status
        progress_fields: tuple[str, ...]
        if final_status == "IN_PROGRESS":
            progress_fields = ("percent_complete", "remaining_points")
        elif final_status == "REVIEW":
            progress_fields = ("remaining_points",)
        else:
            progress_fields = ()
        if not progress_fields:
            return
        authored = {key: data[key] for key in progress_fields if data.get(key) is not None}
        if authored:
            self.final_progress[(project_slug, data["wbs_path"])] = authored

    def _build_task(
        self, project: Project, project_slug: str, data: dict[str, Any], planning_beat: date
    ) -> tuple[Task, date]:
        """Construct one unsaved ``Task`` plus the date its creation row backdates to.

        Returns rather than saves so the caller can batch a whole project's tasks
        into one INSERT (ADR-0726 §8). The returned date is only consulted under
        v2 replay.

        Args:
            planning_beat: the project's default creation-history anchor for a
                non-sprint task (see :meth:`_project_planning_beat`) — computed
                once per project rather than per task since it doesn't vary.
        """
        f = self._derive_task_fields(project_slug, data)

        task = Task(
            project=project,
            name=data["name"],
            wbs_path=data["wbs_path"],
            type=data.get("type", "task"),
            status=f.base_status,
            is_milestone=f.is_milestone,
            duration=0 if f.is_milestone else data.get("duration", 1),
            planned_start=f.planned_start,
            percent_complete=f.base_percent,
            notes=data.get("notes", ""),
            story_points=f.story_points,
            remaining_points=f.base_remaining,
            assignee=f.assignee,
            sprint=f.sprint,
            sprint_rank=data.get("sprint_rank"),
            # Declared in the schema with an enum since v1 and read by nothing
            # (#3093): aurora authored 23 `ready` + 2 `refine` and every one of
            # them landed on the model default. `task.ac_met` was the only writer,
            # so the pure-scrum pack's Definition of Ready — the whole point of its
            # sprint-picker story — was uniformly `idea` on screen.
            dor=data.get("dor", DorState.IDEA),
            board_lane=data.get("board_lane", ""),
            # ``blocked_reason`` is the flag-of-record: non-empty means blocked.
            # ``blocked_since`` is stamped by ``Task.save()`` with ``timezone.now()``,
            # which would read "blocked 0 days" on a backdated seed, so it is
            # corrected to the project's own timeline in ``_backdate_blockers``.
            blocked_reason=self._blocker_reason(data.get("blocked")),
            blocker_type=(data.get("blocked") or {}).get("type", ""),
            governance_class=data.get("governance_class", "flow"),
            # Couple delivery_mode to the milestone flag (#1773) so seeded
            # milestones satisfy the canonical invariant like every other path.
            delivery_mode="milestone" if f.is_milestone else data.get("delivery_mode", "waterfall"),
            color=data.get("color"),
            # Drawer subtask (ADR-0060, #3498). Validation already held it to a
            # depth-1 leaf under a decomposable parent, as the create view does.
            is_subtask=bool(data.get("is_subtask", False)),
            **f.estimate_fields,
        )
        created_on = self._task_creation_beat(project_slug, data, planning_beat, f.sprint)
        self.tasks[(project_slug, data["wbs_path"])] = task
        if self.replay:
            self._capture_replay_progress(project_slug, data, f.final_status)
        return task, created_on

    # --- cross-cutting links (Pass B) --------------------------------------

    def _resolve_task_ref(self, ref: str, enclosing_project: str) -> Task:
        if ":" in ref:
            project_slug, _, wbs = ref.partition(":")
        else:
            project_slug, wbs = enclosing_project, ref
        return self.tasks[(project_slug, wbs)]

    def _link_dependencies(self, project: Project, data: dict[str, Any]) -> None:
        """Materialize the project's CPM edges in one batch per owning project.

        A dependency carries no project FK, so its sync cursor is drawn through
        its ``predecessor`` (the endpoint the delta scopes and orders by). Edges
        are therefore grouped by the *predecessor's* project rather than by the
        enclosing block — a seed may reference a task in any project of the
        program (the ADR-0120 D1 envelope), so the two are not the same set.
        """
        slug = data["slug"]
        by_owner: dict[Any, list[Dependency]] = defaultdict(list)
        for dep in data.get("dependencies", []):
            predecessor = self._resolve_task_ref(dep["predecessor"], slug)
            by_owner[predecessor.project_id].append(
                Dependency(
                    predecessor=predecessor,
                    successor=self._resolve_task_ref(dep["successor"], slug),
                    dep_type=dep["dep_type"],
                    lag=dep.get("lag", 0),
                )
            )
        for project_id, rows in by_owner.items():
            self._bulk_insert(Dependency, rows, project_ids=[project_id])

    def _resolve_blockers(self, data: dict[str, Any]) -> None:
        """Fill in the blocker halves that need every task and account to exist (#3094).

        ``blocked_reason`` / ``blocker_type`` are set at construction; the soft
        ``blocking_task`` link and the ``blocked_by`` actor are resolved here in
        Pass B, once the whole project's tasks are inserted and a forward
        reference can land.

        ``blocked_since`` is set explicitly rather than left to the model.
        ``Task.save()`` stamps it with ``timezone.now()`` on the block transition,
        but the importer inserts through ``bulk_create_tasks`` — no ``save()``, so
        nothing stamps it at all, and an unstamped blocker renders no age. Age is
        the whole triage signal ("3 tasks blocked more than a week"), so a seeded
        blocker that reads "0d" is worse than none. Falls back to the task's own
        planned start, then the project's, so the value is never null while the
        flag is raised.
        """
        slug = data["slug"]
        project = self.projects[slug]
        touched = []
        for task_data in data.get("tasks", []):
            blocked = task_data.get("blocked")
            if not blocked:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            # A blocker started when it started — a Saturday stays a Saturday.
            # Snapping this forward would report the block as newer than it is.
            since = self._date_opt(blocked.get("since"), slug, snap=False)
            task.blocked_since = self._creation_dt(
                since or task.planned_start or project.start_date
            )
            if blocked.get("blocking_task"):
                task.blocking_task = self._resolve_task_ref(blocked["blocking_task"], slug)
            if blocked.get("by"):
                task.blocked_by = self.users.get(blocked["by"])
            touched.append(task)
        if touched:
            Task.objects.bulk_update(
                touched,
                ["blocked_since", "blocking_task", "blocked_by"],
                batch_size=_BULK_BATCH_SIZE,
            )

    def _create_attachments(self, data: dict[str, Any]) -> None:
        """Create each task's external-link attachments (#3094).

        URL-only by design: ``TaskAttachment`` enforces file XOR ``external_url``
        at the DB level, and a seed is a text document with no bytes to carry, so
        the file half is deliberately inexpressible rather than half-supported.
        """
        slug = data["slug"]
        rows = []
        for task_data in data.get("tasks", []):
            attachments = task_data.get("attachments")
            if not attachments:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            for entry in attachments:
                rows.append(
                    TaskAttachment(
                        task=task,
                        external_url=entry["external_url"],
                        external_title=entry.get("external_title", ""),
                        is_pinned=entry.get("is_pinned", False),
                        uploaded_by=(
                            self.users.get(entry["uploaded_by"])
                            if entry.get("uploaded_by")
                            else None
                        ),
                    )
                )
        if rows:
            TaskAttachment.objects.bulk_create(rows, batch_size=_BULK_BATCH_SIZE)

    def _link_parent_epics(self, data: dict[str, Any]) -> None:
        slug = data["slug"]
        touched = []
        for task_data in data.get("tasks", []):
            parent = task_data.get("parent_epic")
            if not parent:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            task.parent_epic = self.tasks[(slug, parent)]
            touched.append(task)
        # bulk_update: a back-link is a structural fixup of a row this import just
        # created, not an independent edit, so it neither needs its own history
        # row nor a second cursor draw (the same reasoning ADR-0091 applies to CPM
        # output writes).
        if touched:
            Task.objects.bulk_update(touched, ["parent_epic"])

    def _link_sprint_milestones(self, data: dict[str, Any]) -> None:
        slug = data["slug"]
        touched = []
        for sprint_data in data.get("sprints", []):
            target = sprint_data.get("target_milestone")
            if not target:
                continue
            sprint = self.sprints[(slug, sprint_data["slug"])]
            sprint.target_milestone = self.tasks[(slug, target)]
            touched.append(sprint)
        if touched:
            Sprint.objects.bulk_update(touched, ["target_milestone"])

    def _link_task_labels(self, data: dict[str, Any]) -> None:
        """Attach each task's slugged labels via the ``TaskLabel`` through table (#1958).

        Runs in Pass B (after all tasks exist). A task's ``labels`` is a list of
        project-local label slugs resolved against the ``self.labels`` index built
        in Pass A. Unknown slugs are skipped defensively — validation (#614) rejects
        a dangling label ref before we reach here, so this is belt-and-braces.
        """
        slug = data["slug"]
        rows = []
        seen: set[tuple[Any, Any]] = set()
        for task_data in data.get("tasks", []):
            label_slugs = task_data.get("labels", [])
            if not label_slugs:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            for label_slug in label_slugs:
                label = self.labels.get((slug, label_slug))
                # The de-dup that ``get_or_create`` used to provide. Validation
                # (#614) already rejects a task listing a label twice, so this
                # only guards a payload that slipped past it — but the batch has
                # no per-row conflict handling, so it has to guard it here.
                if label is not None and (task.pk, label.pk) not in seen:
                    seen.add((task.pk, label.pk))
                    rows.append(TaskLabel(task=task, label=label))
        # TaskLabel is outside the sync union (it has no cursor of its own —
        # attach/detach saves the Task, which allocates there instead) and
        # records no history, so a plain bulk_create is the whole story.
        self._bulk_insert(TaskLabel, rows)

    def _link_task_relations(self, project_slug: str, data: dict[str, Any]) -> None:
        """Materialize each task's informational ``links`` as ``TaskRelation`` rows (ADR-0455).

        Runs in Pass B (after all tasks exist) so a relation's ``target`` may resolve
        to a task in any project of the program — the ADR-0120 D1 envelope. A relation
        is inert: unlike :meth:`_link_dependencies` it drives no CPM edge, no consent
        gate, and no schedule recompute, so it is a plain ``create`` (the enclosing
        program subtree is wiped on re-import, so there is nothing to upsert against).
        Self-links are skipped defensively — validation (#614) rejects them first and
        the model's ``task_relation_no_self`` CheckConstraint is the DB backstop.
        """
        by_owner: dict[Any, list[TaskRelation]] = defaultdict(list)
        for task_data in data.get("tasks", []):
            links = task_data.get("links", [])
            if not links:
                continue
            source = self.tasks[(project_slug, task_data["wbs_path"])]
            for link in links:
                target = self._resolve_task_ref(link["target"], project_slug)
                if target.pk == source.pk:
                    continue  # inert self-link; rejected by the DB constraint anyway
                # Grouped by the source task's project — a relation's cursor is
                # drawn through ``source``, and a link may cross projects.
                by_owner[source.project_id].append(
                    TaskRelation(
                        source=source,
                        target=target,
                        relation_type=link["link_type"],
                        note=link.get("note", ""),
                        created_by=self.owner,
                    )
                )
        for project_id, rows in by_owner.items():
            self._bulk_insert(TaskRelation, rows, project_ids=[project_id])

    def _assign_resources(self, project: Project, data: dict[str, Any]) -> None:
        """Create the ``TaskResource`` rows, from ``assignments`` or from ``assignee``.

        The fallback is the load-bearing half (#2900). Capacity, utilization and
        the heatmap sum ``TaskResource.units`` and never read ``Task.assignee``, so
        a task carrying only an assignee contributes **zero** load. Every bundled
        seed pack authors assignees and no ``assignments`` array at all, which made
        this whole method dead code for every sample that ships — an evaluator
        clicking "Load demo data" saw an owner on every board card and a completely
        empty heatmap, and concluded the capacity features do not work.

        Synthesizing the row here rather than adding ``assignments`` to the four
        fixtures is deliberate: it also covers any future fixture that authors an
        assignee and forgets the allocation, which is the mistake all four made.

        An explicit ``assignments`` array always wins — it can express partial
        units and several people on one task, which a bare assignee cannot. The
        fallback fires only when a task has no assignments at all, and resolves
        the assignee (an **account** slug) through the resource that declares that
        account. A task whose assignee has no corresponding resource is skipped:
        there is no defensible units figure for a person the seed never staffed.

        Units are the resource's own availability, capped at one full unit — see
        :data:`_ASSIGNEE_MAX_UNITS` for why a flat 1.0 would misrepresent the
        part-time staffing the packs deliberately author.
        """
        slug = data["slug"]
        rows = []
        # ``ensure_project_resource`` is idempotent but costs a round-trip, so it
        # is hoisted out of the per-assignment loop and run once per distinct
        # resource rather than once per assignment.
        used: dict[Any, Any] = {}
        for task_data in data.get("tasks", []):
            task_key = (slug, task_data["wbs_path"])
            assignments = task_data.get("assignments", [])
            if assignments:
                task = self.tasks[task_key]
                for assignment in assignments:
                    resource = self.resources[assignment["resource"]]
                    used[resource.pk] = resource
                    rows.append(
                        TaskResource(
                            task=task, resource=resource, units=assignment.get("units", 1.0)
                        )
                    )
                continue

            assignee = task_data.get("assignee")
            if not assignee:
                continue
            owner = self.resources_by_account.get(assignee)
            if owner is None:
                continue
            # A milestone is a gate, not work somebody performs, so it carries no
            # load even when the seed names an owner on it. Giving one units would
            # inflate every heatmap cell it lands in with effort nobody spends.
            task = self.tasks[task_key]
            if task.is_milestone:
                continue
            used[owner.pk] = owner
            units = min(_ASSIGNEE_MAX_UNITS, owner.max_units)
            rows.append(TaskResource(task=task, resource=owner, units=units))
        self._bulk_insert(TaskResource, rows)
        for resource in used.values():
            ensure_project_resource(project, resource)

    def _apply_team(self, project: Project, data: dict[str, Any]) -> None:
        """Name the project's default team and set its SM/PO facets (ADR-0078, #3498).

        Membership itself comes from the ``ProjectMembership`` mirror
        (``teams.signals``), which the grants just before this call triggered. This
        only names the team and sets the facets, which the mirror never infers. A
        member whose account resolved to nobody is skipped, like every other account
        reference on the generic path (#1057).
        """
        spec = data.get("team")
        if not spec:
            return
        from trueppm_api.apps.teams.models import TeamMembership, TeamRole
        from trueppm_api.apps.teams.services import ensure_default_team

        team = ensure_default_team(project, created_by=self.owner)
        if spec.get("name") and team.name != spec["name"]:
            team.name = spec["name"]
            team.save(update_fields=["name"])
        for member in spec.get("members", []):
            user = self.users.get(member["account"])
            if user is None:
                continue
            membership, _ = TeamMembership.objects.get_or_create(
                team=team, user=user, is_deleted=False, defaults={"role": TeamRole.MEMBER}
            )
            membership.is_scrum_master = bool(member.get("scrum_master", False))
            membership.is_product_owner = bool(member.get("product_owner", False))
            membership.save(update_fields=["is_scrum_master", "is_product_owner"])

    def _create_recurrence_rules(self, data: dict[str, Any]) -> None:
        """Turn each template task's ``recurrence`` into a rule (ADR-0090, #3498).

        Only the rule is written; occurrences spawn on the generator's rolling horizon,
        exactly as after the API creates one. ``is_recurring`` is set on the template
        the way ``TaskRecurrenceRuleViewSet.perform_create`` sets it, which takes the
        template out of CPM and every committed-delivery aggregate.
        """
        slug = data["slug"]
        project = self.projects[slug]
        tz = project.calendar.timezone if project.calendar is not None else "UTC"
        for task_data in data.get("tasks", []):
            spec = task_data.get("recurrence")
            if not spec:
                continue
            task = self.tasks[(slug, task_data["wbs_path"])]
            end_date = self._date_opt(spec.get("end_date"), slug, snap=False)
            end_count = spec.get("end_count")
            if end_date is not None:
                end_type = "ON_DATE"
            elif end_count:
                end_type = "AFTER_N"
            else:
                end_type = "NEVER"
            rule = TaskRecurrenceRule(
                task=task,
                frequency=spec["frequency"],
                interval=spec.get("interval", 1),
                weekdays=sum(_WEEKDAY_BIT[day] for day in spec.get("weekdays", [])),
                day_of_month=spec.get("day_of_month"),
                time_of_day=dt_time.fromisoformat(spec.get("time_of_day", "09:00")),
                timezone=tz or "UTC",
                end_type=end_type,
                end_date=end_date,
                end_count=end_count,
            )
            # The same invariants the serializer enforces; validation already
            # checked them, so a failure here means the two drifted.
            rule.clean()
            rule.save()
            task.is_recurring = True
            Task.objects.filter(pk=task.pk).update(is_recurring=True)

    def _create_skill_requirements(self, data: dict[str, Any]) -> None:
        """Attach each task's skill requirements from the workspace catalog (#3498).

        Matched onto ``Skill`` by case-folded name, so a requirement naming a skill a
        resource already declared lands on that same catalog row and the assignment
        fit can compare them.
        """
        slug = data["slug"]
        for task_data in data.get("tasks", []):
            for entry in task_data.get("skill_requirements", []):
                name = entry["skill"].strip()
                skill, _ = Skill.objects.get_or_create(
                    normalized_name=name.casefold(), defaults={"name": name}
                )
                TaskSkillRequirement.objects.get_or_create(
                    task=self.tasks[(slug, task_data["wbs_path"])],
                    skill=skill,
                    is_deleted=False,
                    defaults={
                        "min_proficiency": _PROFICIENCY_BY_NAME[
                            entry.get("min_proficiency", "beginner")
                        ]
                    },
                )

    def _create_board_config(self, project: Project, data: dict[str, Any]) -> None:
        """Materialize the project's Kanban board configuration (#3093).

        ``board_columns`` was declared in the schema as a bare list of label
        strings and read by nothing, so a pack could author "Backlog / To Do /
        In Progress / In Review / Done" and get the API's hardcoded defaults —
        no renamed column, no WIP limit, no lane. The old shape could not have
        worked even if it had been read: ``BoardColumnConfig.columns`` is keyed
        on the canonical ``status``, and a label list carries none.

        Entries are stored as authored. The board serializer requires all five
        canonical statuses exactly once and the JSON Schema enforces the same
        five-value enum, so a seed cannot express a config the board API would
        reject — but the serializer is the authority at read time, not this.
        """
        columns = data.get("board_columns")
        if not columns:
            return
        BoardColumnConfig.objects.update_or_create(
            project=project,
            defaults={
                "columns": [
                    {
                        "status": column["status"],
                        "label": column["label"],
                        "visible": column.get("visible", True),
                        "color": column.get("color"),
                        "wip_limit": column.get("wip_limit"),
                        "age_threshold_days": column.get("age_threshold_days"),
                        "lanes": [
                            {
                                "key": lane["key"],
                                "label": lane["label"],
                                "wip_limit": lane.get("wip_limit"),
                            }
                            for lane in column.get("lanes", [])
                        ],
                    }
                    for column in columns
                ]
            },
        )

    def _capture_baselines(self, project: Project, data: dict[str, Any]) -> None:
        slug = data["slug"]
        for bl_data in data.get("baselines", []):
            baseline = Baseline.objects.create(
                project=project,
                name=bl_data["name"],
                is_active=bl_data.get("is_active", False),
            )
            # ``captured_at`` has been in the schema and authored by every bundled
            # pack since v1, and nothing read it (#3093). ``Baseline.created_at`` is
            # auto_now_add, so each declared baseline recorded the moment somebody
            # clicked "Load demo data" — collapsing Bayside's 75-day gap between its
            # contract baseline and its change-order rebaseline onto one afternoon,
            # which is exactly the interval every planned-vs-actual view reads.
            # The replay path (``_apply_baseline_capture``) already backdates this
            # way; the declarative path simply never did.
            # A capture happened when it happened, so this must not weekend-snap:
            # two baselines whose offsets snap differently render an interval that
            # is not the one the pack authored. The replay path backdates from a
            # `resolve_timestamp`, which never snaps -- this keeps the two agreeing.
            captured = self._date_opt(bl_data.get("captured_at"), slug, snap=False)
            if captured is not None:
                Baseline.objects.filter(pk=baseline.pk).update(
                    created_at=self._creation_dt(captured)
                )
            rows = []
            has_dates = True
            for bt in bl_data.get("tasks", []):
                task = self.tasks[(slug, bt["task"])]
                start = self._date_opt(bt.get("start"), slug)
                finish = self._date_opt(bt.get("finish"), slug)
                has_dates = has_dates and start is not None
                rows.append(
                    BaselineTask(
                        baseline=baseline,
                        task_id=task.pk,
                        task_name=task.name,
                        start=start,
                        finish=finish,
                        duration=bt.get("duration", task.duration),
                        story_points=bt.get("story_points", task.story_points),
                    )
                )
            BaselineTask.objects.bulk_create(rows, batch_size=_BULK_BATCH_SIZE)
            if rows and has_dates:
                Baseline.objects.filter(pk=baseline.pk).update(has_cpm_dates=True)

    def _backfill_forecast_history(self) -> None:
        """Synthesize ProjectForecastSnapshot + MonteCarloRun history for projects
        that author a ``forecast_history`` block.

        Delegates the drift math to ``forecast_backfill`` (ADR-0211). Keyed off the
        seed's ``forecast_history`` block so it is opt-in and generic — only the
        history-aware samples carry it, but any v2 seed may. The MonteCarloRun
        history (#3494) is derived from the same snapshot rows, not recomputed, so
        the MC history panel and the forecast-trend chart can never disagree.
        """
        for project_data in self.payload["projects"]:
            spec = project_data.get("forecast_history")
            if not spec:
                continue
            project = self.projects[project_data["slug"]]
            # Must match the population capture_forecast_snapshot aggregates over
            # (Task.committed, #3539), not every non-deleted task: the synthesized
            # history and the sample's first *real* capture sit next to each other on
            # the forecast-trend chart, and a task_count that steps at the join is a
            # discontinuity in demo data with no cause a viewer can find.
            task_count = Task.committed.filter(project=project).count()
            snapshots = backfill_forecast_history(
                project,
                spec,
                anchor=self.anchor,
                program_code=self.payload["program"]["slug"],
                project_slug=project_data["slug"],
                task_count=task_count,
            )
            backfill_monte_carlo_run_history(
                project,
                snapshots,
                triggered_by=self._scheduler_persona(project_data),
            )

    def _scheduler_persona(self, project_data: dict[str, Any]) -> Any:
        """Resolve the user MonteCarloRun history (#3494) attributes seeded runs to.

        A run's ``triggered_by`` is display/audit metadata (ADR-0175), never
        access control, so this need not be exact — but it should read as a real
        person, not the importing owner, when the seed casts one. Only a
        Scheduler+ role may actually persist an attributed run (``run_monte_carlo``
        docstring), so preference goes to whichever of that ladder the project
        casts, project scope first: the project's own ``members`` override (or
        the program-roster fallback ``_grant_project_memberships`` would apply)
        for SCHEDULER, then ADMIN, then OWNER; then the same three at program
        scope; then the importing owner as a last resort (every program has one).
        """
        declared = project_data.get("members")
        project_pairs = (
            [(entry["account"], entry["role"]) for entry in declared]
            if declared is not None
            else [
                (account["slug"], account.get("role", ""))
                for account in self.payload.get("accounts", [])
            ]
        )
        program_pairs = [
            (account["slug"], account.get("role", ""))
            for account in self.payload.get("accounts", [])
        ]
        for role_name in ("SCHEDULER", "ADMIN", "OWNER"):
            for pairs in (project_pairs, program_pairs):
                for slug, pair_role in pairs:
                    if pair_role == role_name and self.users.get(slug) is not None:
                        return self.users[slug]
        return self.owner

    # --- v2.1 collaboration sections (#3603) --------------------------------

    def _ts(self, value: str | None) -> datetime | None:
        """Resolve an optional seed timestamp. Timestamps are never weekend-snapped."""
        return resolve_timestamp(value, anchor=self.anchor) if value else None

    def _create_acceptance_criteria(self, data: dict[str, Any]) -> None:
        """Materialize each task's acceptance criteria in authored order (#3492).

        A criterion authored ``met`` carries its own trail. One ticked later, on a
        dated ``task.ac_met`` beat, is born unmet and replay flips it — so the rows
        are also indexed per task for the replay context to address by position.
        """
        slug = data["slug"]
        rows: list[AcceptanceCriterion] = []
        for task_data in data.get("tasks", []):
            authored = task_data.get("acceptance_criteria")
            if not authored:
                continue
            key = (slug, task_data["wbs_path"])
            per_task = self.criteria.setdefault(key, [])
            for position, entry in enumerate(authored):
                met = bool(entry.get("met", False))
                row = AcceptanceCriterion(
                    task=self.tasks[key],
                    text=entry["text"],
                    given=entry.get("given", ""),
                    when=entry.get("when", ""),
                    then=entry.get("then", ""),
                    met=met,
                    position=position,
                    met_by=(
                        self.users.get(entry["met_by"]) if met and entry.get("met_by") else None
                    ),
                    met_at=self._ts(entry.get("met_at")) if met else None,
                )
                rows.append(row)
                per_task.append(row)
        self._bulk_insert(AcceptanceCriterion, rows, project_ids=[self.projects[slug].pk])

    def _create_backlog_items(self, program: Program) -> None:
        """Seed the program backlog — the intake pool (ADR-0069, #3491).

        Per-row saves rather than the batched path: a program carries a handful of
        items, and ``BacklogItem`` is program-scoped, so there is no project cursor
        to draw. A pulled item links the task it became, which is what the
        backlog's "pulled into …" chip and the task's source link both read.
        """
        for data in self.payload["program"].get("backlog_items", []):
            target = data.get("pulled_to")
            item = BacklogItem(
                program=program,
                title=data["title"],
                description=data.get("description", ""),
                item_type=data.get("item_type", "task"),
                status=data.get("status", "proposed"),
                tags=list(data.get("tags", [])),
                priority_rank=data.get("priority_rank"),
                story_points=data.get("story_points"),
                pulled_task=self._resolve_task_ref(target, "") if target else None,
                pulled_at=self._ts(data.get("pulled_at")) if target else None,
                pulled_by=(
                    self.users.get(data["pulled_by"]) if target and data.get("pulled_by") else None
                ),
                created_by=(
                    self.users.get(data["created_by"]) if data.get("created_by") else self.owner
                ),
            )
            item.save()
            created = self._ts(data.get("created_at"))
            if created is not None:
                # auto_now_add stamped import time; an intake item was raised when
                # the seed says it was.
                BacklogItem.objects.filter(pk=item.pk).update(created_at=created)

    def _create_ceremonies(self, program: Program) -> None:
        """Seed the program's recurring ceremonies (ADR-0079, #3603).

        Validation already refused sprint-event names and a missing clock anchor,
        mirroring ``CeremonyTemplateSerializer``; an on-milestone ceremony drops
        any day/time exactly as the serializer strips them.
        """
        for data in self.payload["program"].get("ceremonies", []):
            on_milestone = data["cadence_type"] == "on_milestone"
            CeremonyTemplate(
                program=program,
                name=data["name"].strip(),
                cadence_type=data["cadence_type"],
                cadence_day="" if on_milestone else data.get("cadence_day", ""),
                cadence_time=None if on_milestone else dt_time.fromisoformat(data["cadence_time"]),
                duration_minutes=data.get("duration_minutes", 60),
                owner_role=data.get("owner_role", ""),
                enabled=data.get("enabled", True),
                created_by=self.owner,
            ).save()

    def _create_share_links(self) -> None:
        """Mint each sample project's share links (ADR-0245, #3603). Sample path only.

        The token comes from ``mint_share_link`` here, at load; nothing in any file
        can choose it, and the raw value is discarded — only its hash is stored, as
        for every link. The link is live and revocable from the project's share
        settings, so the share surface is populated; ``create_demo_share_link`` is
        still how an operator obtains an openable URL.
        """
        if not self.is_sample:
            return
        from trueppm_api.apps.projects.share_services import mint_share_link

        for project_data in self.payload["projects"]:
            project = self.projects[project_data["slug"]]
            for data in project_data.get("share_links", []):
                days = data.get("expires_in_days")
                creator = self.users.get(data["created_by"]) if data.get("created_by") else None
                mint_share_link(
                    project,
                    creator or self.owner,
                    label=data.get("label", ""),
                    show_assignees=data.get("show_assignees", False),
                    show_milestone_dates=data.get("show_milestone_dates", True),
                    content_kind=data.get("content_kind", "board"),
                    expires_at=timezone.now() + timedelta(days=days) if days else None,
                )

    def _agent_action_refs(self, data: dict[str, Any]) -> tuple[Task | None, Project | None]:
        """Resolve the task and project an authored agent action points at."""
        obj = data.get("object")
        task = self._resolve_task_ref(obj, "") if obj else None
        project = self.projects.get(data["project"]) if data.get("project") else None
        if project is None and task is not None:
            project = task.project
        return task, project

    def _record_sample_agent_actions(self) -> None:
        """Write the sample's agent trail through the real audit chain (#3603). Sample only.

        ``record_agent_action(sample=True)`` marks each row in hashed fields, because
        the row outlives its project: a reload hard-deletes the sample and SET_NULLs
        ``project``, after which only the marker says the row is demo data. Appended
        in ``at`` order so the chain's sequence and the narrated timeline agree.
        """
        if not self.is_sample:
            return
        from trueppm_api.apps.agents.services import record_agent_action

        authored = self.payload["program"].get("agent_actions", [])
        ordered = sorted(
            range(len(authored)),
            key=lambda i: (resolve_timestamp(authored[i]["at"], anchor=self.anchor), i),
        )
        for i in ordered:
            data = authored[i]
            task, project = self._agent_action_refs(data)
            record_agent_action(
                actor_token=None,
                principal=self.users.get(data["principal"]) if data.get("principal") else None,
                action=data["action"],
                method=data.get("method", "GET"),
                capability_used=data.get("capability", "mcp:read"),
                verdict=data["verdict"],
                payload_hash=hashlib.sha256(
                    json.dumps(data, sort_keys=True).encode("utf-8")
                ).hexdigest(),
                refusal_reason=data.get("refusal_reason", ""),
                refusal_constraint=data.get("refusal_constraint", ""),
                projected_impact=data.get("projected_impact"),
                object_type=data.get("object_type", "task" if task is not None else ""),
                object_id=str(task.pk) if task is not None else "",
                project_id=project.pk if project is not None else None,
                summary=data.get("summary", ""),
                occurred_at=resolve_timestamp(data["at"], anchor=self.anchor),
                sample=True,
            )

    def _synthesize_time(self) -> None:
        """Fill logged time on sample work the timeline left unlogged (#3490). Sample only.

        On a real import this would invent actuals in somebody's program, so it is
        confined to the bundled samples. For each COMPLETE or IN_PROGRESS work task
        with no authored ``time.log`` beat, every allocated person who has a login
        gets entries on most working days of the task's *actual* window (the dates
        replay stamped), sized ``hours_per_day × units`` with jitter — so the
        Timesheet page, the log-time popover and actual-vs-estimate read as a team
        that has been working.

        Three bounds keep it honest: no entry on or after the anchor ("today"); a
        person's synthesized day never exceeds their calendar day, however many
        tasks overlap; and a task contributes at most ``_TIME_FILL_MAX_DAYS``. The
        RNG is seeded on program, task and username — never a UUID or the clock —
        so a reload reproduces the same hours.
        """
        if not (self.is_sample and self.replay):
            return
        authored = self._authored_time_log_keys()
        allocations = self._task_resource_allocations()

        program_code = self.payload["program"]["slug"]
        last_day = self.anchor - timedelta(days=1)
        used: dict[tuple[Any, date], int] = defaultdict(int)
        by_project: dict[Any, list[TimeEntry]] = defaultdict(list)
        for key, task in self.tasks.items():
            if key in authored or self.final_status.get(key) not in ("COMPLETE", "IN_PROGRESS"):
                continue
            entries = self._synthesize_task_time_entries(
                key, task, allocations, program_code, last_day, used
            )
            if entries:
                by_project[self.projects[key[0]].pk].extend(entries)
        for project_id, rows in by_project.items():
            self._bulk_insert(TimeEntry, rows, project_ids=[project_id])

    def _authored_time_log_keys(self) -> set[tuple[str, str]]:
        """(project_slug, wbs) pairs already carrying an authored ``time.log`` beat."""
        authored: set[tuple[str, str]] = set()
        for event in self.payload.get("events", []):
            if event.get("action") == "time.log":
                _, _, ref = event.get("target", "").partition(":")
                project_slug, _, wbs = ref.partition(":")
                authored.add((project_slug, wbs))
        return authored

    def _task_resource_allocations(self) -> dict[Any, list[TaskResource]]:
        allocations: dict[Any, list[TaskResource]] = defaultdict(list)
        for row in TaskResource.objects.filter(
            task_id__in=[task.pk for task in self.tasks.values()],
            resource__user__isnull=False,
        ).select_related("resource__user"):
            allocations[row.task_id].append(row)
        return allocations

    def _synthesize_task_time_entries(
        self,
        key: tuple[str, str],
        task: Task,
        allocations: dict[Any, list[TaskResource]],
        program_code: str,
        last_day: date,
        used: dict[tuple[Any, date], int],
    ) -> list[TimeEntry]:
        """The ``TimeEntry`` rows synthesized for one task, or ``[]`` if it's out of scope.

        Mutates `used` with every minute it allocates, so later tasks/allocations
        sharing a (user, day) see the day already partly spent.
        """
        if task.actual_start is None or getattr(task, "structure_role", "work") != "work":
            return []
        end = min(task.actual_finish or last_day, last_day)
        if end < task.actual_start:
            return []
        project = self.projects[key[0]]
        calendar = self._wc(key[0])
        hours = float(project.calendar.hours_per_day) if project.calendar is not None else 8.0
        day_cap = int(hours * 60 * 1.1)
        entries: list[TimeEntry] = []
        for allocation in allocations.get(task.pk, []):
            user = allocation.resource.user
            if user is None:  # filtered out by the query; narrows the type
                continue
            rng = random.Random(f"{program_code}:{key[0]}:{key[1]}:{user.get_username()}")
            day = max(task.actual_start, end - timedelta(days=_TIME_FILL_MAX_DAYS))
            while day <= end:
                if calendar.is_working_day(day) and rng.random() < 0.85:
                    wanted = hours * 60 * float(allocation.units) * rng.uniform(0.6, 1.1)
                    minutes = min(round(wanted / 15) * 15, day_cap - used[(user.pk, day)])
                    if minutes >= 15:
                        used[(user.pk, day)] += minutes
                        entries.append(
                            TimeEntry(task=task, user=user, minutes=minutes, entry_date=day)
                        )
                day += timedelta(days=1)
        return entries

    def _synthesize_timesheet_submissions(self) -> None:
        """Submit every fully elapsed week a sample persona logged time in (#3490). Sample only.

        ``TimesheetSubmission`` is per user and week, not per program, and personas
        persist across reloads — so an existing row is kept, never duplicated. The
        week containing the anchor is never submitted: it has not ended.
        """
        if not self.is_sample:
            return
        this_monday = self.anchor - timedelta(days=self.anchor.weekday())
        logged = TimeEntry.objects.filter(
            task__project__in=list(self.projects.values()),
            entry_date__lt=this_monday,
            is_deleted=False,
        ).values_list("user_id", "entry_date")
        weeks = {(user_id, day - timedelta(days=day.weekday())) for user_id, day in logged}
        existing = set(
            TimesheetSubmission.objects.filter(
                user_id__in={user_id for user_id, _ in weeks}
            ).values_list("user_id", "week_start")
        )
        rows = [
            TimesheetSubmission(
                user_id=user_id,
                week_start=monday,
                # Friday 17:00 UTC of that week — submitted when the week closed.
                submitted_at=datetime(monday.year, monday.month, monday.day, 17, 0, tzinfo=_UTC)
                + timedelta(days=4),
            )
            for user_id, monday in sorted(weeks, key=lambda pair: (str(pair[0]), pair[1]))
            if (user_id, monday) not in existing
        ]
        TimesheetSubmission.objects.bulk_create(rows, batch_size=_BULK_BATCH_SIZE)

    def _create_program_risks(self, program: Program) -> None:
        """Program-scoped risks attach to the first project (Risk is project-FK).

        TruePPM has no program-level Risk model; a program-scoped seed risk is
        materialized on the lead project but may link tasks across projects.
        """
        risks = self.payload.get("risks", [])
        if not risks:
            return
        lead_project = next(iter(self.projects.values()))
        self._create_risks(lead_project, risks, enclosing_project=None)

    def _create_risks(
        self, project: Project, risks: list[dict[str, Any]], enclosing_project: str | None
    ) -> None:
        for data in risks:
            risk = Risk(
                project=project,
                title=data["title"],
                description=data.get("description", ""),
                status=data["status"],
                probability=data["probability"],
                impact=data["impact"],
                category=data.get("category"),
                response=data.get("response"),
                mitigation_due_date=self._date_opt(
                    data.get("mitigation_due_date"), enclosing_project
                ),
                trigger=data.get("trigger", ""),
                contingency=data.get("contingency", ""),
                notes=data.get("notes", ""),
                owner=self.users.get(data["owner"]) if data.get("owner") else None,
            )
            # Backdate the creation history row to the project start under replay
            # (risks are identified at kickoff), so a risk that the events timeline
            # walks through a status lifecycle reads chronologically — the "opened"
            # row precedes its dated transitions rather than landing at import time.
            self._save_new(risk, project.start_date)
            # Slug map lets risk.status replay beats resolve their target.
            if data.get("slug"):
                self.risks_by_slug[data["slug"]] = risk
            # Risk itself stays a per-row save so the ``risk_changed`` signal
            # fires; risk counts are in the tens, so there is nothing to win.
            risk_task_rows = [
                RiskTask(risk=risk, task=self._resolve_task_ref(ref, enclosing_project or ""))
                # Program-scoped risks (enclosing_project is None) always carry
                # qualified refs, so the enclosing fallback is never consulted.
                for ref in data.get("tasks", [])
            ]
            self._bulk_insert(RiskTask, risk_task_rows)
