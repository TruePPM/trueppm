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

import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
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
    Baseline,
    BaselineTask,
    BoardColumnConfig,
    Calendar,
    CalendarException,
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
    TaskRelation,
    TaskSource,
    TaskStatus,
    bulk_create_tasks,
)
from trueppm_api.apps.projects.seed.forecast_backfill import backfill_forecast_history
from trueppm_api.apps.projects.seed.reldates import (
    WorkingCalendar,
    resolve_anchor,
    resolve_date,
)
from trueppm_api.apps.projects.seed.replace import resolve_replace_candidates
from trueppm_api.apps.projects.seed.replay import ReplayContext, replay_timeline
from trueppm_api.apps.projects.seed.validation import validate_seed
from trueppm_api.apps.resources.models import Resource, TaskResource
from trueppm_api.apps.resources.services import ensure_project_resource
from trueppm_api.apps.scheduling.services import enqueue_recalculate
from trueppm_api.apps.sync.broadcast import broadcast_board_event
from trueppm_api.apps.sync.sequence import allocate_for_projects, coalesce_sync_seq

logger = logging.getLogger(__name__)

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
        persona_password: when set (and ``is_sample``), newly-created persona
            accounts are given this as a usable login password so an evaluator can
            actually sign in as each persona (#1760). ``None`` (the default) leaves
            created personas with an unusable password, as before. Only the
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
    validate_seed(payload)
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
        self.working_calendars: dict[str, WorkingCalendar] = {}
        self.risks_by_slug: dict[str, Risk] = {}
        # Desired END states for replay — tasks/sprints are created at a base
        # state and walked forward to these by the timeline + synthesizer.
        self.final_status: dict[tuple[str, str], str] = {}
        self.final_sprint: dict[tuple[str, str], dict[str, Any]] = {}

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
            self._assign_resources(project, project_data)
            self._capture_baselines(project, project_data)
            self._create_risks(project, project_data.get("risks", []), project_data["slug"])

        self._create_program_risks(program)

        # Pass C (v2 only): replay the events timeline + synthesized fill so the
        # demo reads as a program that has run for months — backdated history,
        # real burndown/velocity, scope-injection audit. Runs inside this same
        # transaction under the seed_replay flag (side effects suppressed).
        if self.replay:
            replay_timeline(self.payload, self._replay_context())

        # Pass D (#376): backfill ProjectForecastSnapshot history for any project
        # that authored a forecast_history block. Runs after replay so task_count /
        # completed_task_count reflect the final replayed state, and still inside the
        # import transaction so a failure rolls the whole import back (ADR-0211).
        self._backfill_forecast_history()

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

    def _date_opt(
        self, value: str | None, project_slug: str | None, *, snap: bool = True
    ) -> date | None:
        return self._date(value, project_slug, snap=snap) if value else None

    def _creation_dt(self, when: date) -> datetime:
        """A backdated creation timestamp (UTC 09:00) for replay history rows."""
        return datetime(when.year, when.month, when.day, 9, 0, tzinfo=ZoneInfo("UTC"))

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
            tz=tz,
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
                # implicitly. Applied only to accounts this import *creates* — a
                # pre-existing ``user`` is never re-passworded.
                user = User.objects.create_user(
                    username=username,
                    email=account.get("email", ""),
                    first_name=account.get("display_name", "").split(" ")[0],
                    password=self.persona_password if self.is_sample else None,
                )
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
        program.save(update_fields=["code", "color", "lead", "name", "description", "methodology"])
        self._grant_program_memberships(program)
        return program

    def _grant_program_memberships(self, program: Program) -> None:
        for account in self.payload.get("accounts", []):
            user = self.users.get(account["slug"])
            role = _ROLE_BY_NAME.get(account.get("role", ""))
            if user is None or role is None or user == self.owner:
                continue  # owner already has OWNER from create_program
            ProgramMembership.objects.update_or_create(
                program=program, user=user, defaults={"role": role}
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
            ProjectMembership.objects.update_or_create(
                project=project, user=user, defaults={"role": role}
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
            project=project, user=self.owner, defaults={"role": Role.OWNER}
        )
        self._grant_project_memberships(project, data)
        self._create_board_config(project, data)

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

        task_rows: list[Task] = []
        task_dates: list[date] = []
        for task_data in data.get("tasks", []):
            task, created_on = self._build_task(project, slug, task_data)
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
        self._refresh_active_sprint_burndown(sprint_rows)

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

    def _build_task(
        self, project: Project, project_slug: str, data: dict[str, Any]
    ) -> tuple[Task, date]:
        """Construct one unsaved ``Task`` plus the date its creation row backdates to.

        Returns rather than saves so the caller can batch a whole project's tasks
        into one INSERT (ADR-0726 §8). The returned date is only consulted under
        v2 replay.
        """
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
        base_status = "NOT_STARTED" if progresses else final_status
        base_percent = 0.0 if progresses else data.get("percent_complete", 0.0)
        base_remaining = story_points if progresses else data.get("remaining_points")

        task = Task(
            project=project,
            name=data["name"],
            wbs_path=data["wbs_path"],
            type=data.get("type", "task"),
            status=base_status,
            is_milestone=is_milestone,
            duration=0 if is_milestone else data.get("duration", 1),
            planned_start=planned_start,
            percent_complete=base_percent,
            notes=data.get("notes", ""),
            story_points=story_points,
            remaining_points=base_remaining,
            assignee=assignee,
            sprint=sprint,
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
            blocked_reason=(data.get("blocked") or {}).get("reason", ""),
            blocker_type=(data.get("blocked") or {}).get("type", ""),
            governance_class=data.get("governance_class", "flow"),
            # Couple delivery_mode to the milestone flag (#1773) so seeded
            # milestones satisfy the canonical invariant like every other path.
            delivery_mode="milestone" if is_milestone else data.get("delivery_mode", "waterfall"),
            color=data.get("color"),
            **estimate_fields,
        )
        created_on = (
            sprint.start_date if sprint is not None else (planned_start or project.start_date)
        )
        self.tasks[(project_slug, data["wbs_path"])] = task
        if self.replay:
            self.final_status[(project_slug, data["wbs_path"])] = final_status
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
        """Synthesize ProjectForecastSnapshot history for projects that author it.

        Delegates the drift math to ``forecast_backfill`` (ADR-0211). Keyed off the
        seed's ``forecast_history`` block so it is opt-in and generic — only the
        history-aware samples carry it, but any v2 seed may.
        """
        for project_data in self.payload["projects"]:
            spec = project_data.get("forecast_history")
            if not spec:
                continue
            project = self.projects[project_data["slug"]]
            task_count = Task.objects.filter(project=project, is_deleted=False).count()
            backfill_forecast_history(
                project,
                spec,
                anchor=self.anchor,
                program_code=self.payload["program"]["slug"],
                project_slug=project_data["slug"],
                task_count=task_count,
            )

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
