"""Tests for sync.reap_domain_tombstones — nightly hard-delete of stale tombstones.

The reaper calls ``_do_reap()`` (extracted for testability). Tests drive that
helper directly so they never touch the Redis lock.

Key behaviours verified:
- Soft-deleted rows in live projects are hard-deleted.
- Live (non-deleted) rows in the same project survive.
- The retention window is respected for every model carrying an ``age_field``:
  ``updated_at`` (Risk, Sprint) or ``deleted_at`` (Task, Dependency) — recently
  soft-deleted rows outlast the cutoff.
- Rows in archived or soft-deleted projects are left alone.
- The function returns a dict of ``{label: count}`` for every registered model.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.utils import timezone

from trueppm_api.apps.projects.models import (
    Calendar,
    Dependency,
    Project,
    Risk,
    Task,
    TaskRelation,
)
from trueppm_api.apps.sync.tasks import _do_reap

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def live_project(calendar: Calendar) -> Project:
    return Project.objects.create(
        name="Live Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )


@pytest.fixture
def archived_project(calendar: Calendar) -> Project:
    project = Project.objects.create(
        name="Archived Project",
        start_date=date(2026, 1, 1),
        calendar=calendar,
    )
    # Bypass auto_now restrictions to set is_archived without going through
    # the archive endpoint (which requires auth setup not needed here).
    Project.objects.filter(pk=project.pk).update(is_archived=True)
    project.refresh_from_db()
    return project


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_task(project: Project, *, soft_delete: bool = False) -> Task:
    task = Task.objects.create(project=project, name="T", duration=1)
    if soft_delete:
        # Raw update() bypasses Task.soft_delete() (and its dependency/subtask
        # cascade) for test speed, so deleted_at must be stamped explicitly here
        # too — it is the tombstone-reap age_field and a null value would never
        # satisfy the reaper's `deleted_at__lt=cutoff` filter.
        Task.objects.filter(pk=task.pk).update(is_deleted=True, deleted_at=timezone.now())
        task.refresh_from_db()
    return task


def _make_dependency(
    predecessor: Task, successor: Task, *, soft_delete: bool = False
) -> Dependency:
    dep = Dependency.objects.create(predecessor=predecessor, successor=successor)
    if soft_delete:
        # Raw update() bypasses Dependency.soft_delete() for test speed — see
        # _make_task's note on why deleted_at must be stamped explicitly here.
        Dependency.objects.filter(pk=dep.pk).update(is_deleted=True, deleted_at=timezone.now())
        dep.refresh_from_db()
    return dep


def _make_task_relation(source: Task, target: Task, *, soft_delete: bool = False) -> TaskRelation:
    rel = TaskRelation.objects.create(source=source, target=target, relation_type="relates_to")
    if soft_delete:
        # Raw update() bypasses TaskRelation.soft_delete() for test speed — deleted_at
        # is the reap age_field and must be stamped explicitly (see _make_task's note).
        TaskRelation.objects.filter(pk=rel.pk).update(is_deleted=True, deleted_at=timezone.now())
        rel.refresh_from_db()
    return rel


def _make_risk(project: Project, *, soft_delete: bool = False) -> Risk:
    risk = Risk.objects.create(project=project, title="R", probability=1, impact=1)
    if soft_delete:
        Risk.objects.filter(pk=risk.pk).update(is_deleted=True)
        risk.refresh_from_db()
    return risk


def _backdate_risk_updated_at(risk: Risk, days_ago: int) -> None:
    """Move a Risk's updated_at into the past to simulate age.

    Uses update() to bypass the auto_now enforcement on save().
    """
    Risk.objects.filter(pk=risk.pk).update(updated_at=timezone.now() - timedelta(days=days_ago))


def _backdate_task_deleted_at(task: Task, days_ago: int) -> None:
    """Move a Task's deleted_at into the past to simulate an aged tombstone."""
    Task.objects.filter(pk=task.pk).update(deleted_at=timezone.now() - timedelta(days=days_ago))


def _backdate_dependency_deleted_at(dep: Dependency, days_ago: int) -> None:
    """Move a Dependency's deleted_at into the past to simulate an aged tombstone."""
    Dependency.objects.filter(pk=dep.pk).update(
        deleted_at=timezone.now() - timedelta(days=days_ago)
    )


def _backdate_task_relation_deleted_at(rel: TaskRelation, days_ago: int) -> None:
    """Move a TaskRelation's deleted_at into the past to simulate an aged tombstone."""
    TaskRelation.objects.filter(pk=rel.pk).update(
        deleted_at=timezone.now() - timedelta(days=days_ago)
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_deletes_old_tombstones
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_deletes_old_tombstones(live_project: Project) -> None:
    """Soft-deleted Task rows past the retention window are hard-deleted.

    Task's age_field is ``deleted_at`` (stamped by soft_delete(), same mechanism
    as Risk/Sprint's ``updated_at``). override_days=0 makes the cutoff == now,
    so the tombstones stamped moments ago in _make_task() are already past the
    (zero-width) window and eligible — same override_days=0 pattern used by
    test_reap_domain_tombstones_skips_archived_projects below. Three deleted
    tasks should disappear; the one live task must survive untouched.
    """
    t1 = _make_task(live_project, soft_delete=True)
    t2 = _make_task(live_project, soft_delete=True)
    t3 = _make_task(live_project, soft_delete=True)
    live = _make_task(live_project, soft_delete=False)

    counts = _do_reap(override_days=0)

    remaining_ids = set(Task.objects.values_list("pk", flat=True))
    assert t1.pk not in remaining_ids, "tombstoned task t1 should be hard-deleted"
    assert t2.pk not in remaining_ids, "tombstoned task t2 should be hard-deleted"
    assert t3.pk not in remaining_ids, "tombstoned task t3 should be hard-deleted"
    assert live.pk in remaining_ids, "live task must not be deleted"
    assert counts["projects.task"] >= 3


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_respects_retention_window
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_respects_retention_window(live_project: Project) -> None:
    """Soft-deleted Risks younger than the retention window are NOT hard-deleted.

    Risk carries ``updated_at`` (auto_now=True), which soft_delete() refreshes
    via save(). A Risk soft-deleted 2 days ago must survive a 90-day window.
    An old Risk (updated 95 days ago) must be reaped.
    """
    recent_risk = _make_risk(live_project, soft_delete=True)
    # updated_at is already recent — leave it as-is.

    old_risk = _make_risk(live_project, soft_delete=True)
    _backdate_risk_updated_at(old_risk, days_ago=95)

    _do_reap(override_days=90)

    # The recently-soft-deleted Risk still exists.
    assert Risk.objects.filter(pk=recent_risk.pk).exists(), (
        "risk soft-deleted within the retention window should not be reaped"
    )
    # The old tombstone is gone.
    assert not Risk.objects.filter(pk=old_risk.pk).exists(), (
        "risk tombstone older than the retention window should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_respects_retention_window_for_task
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_respects_retention_window_for_task(live_project: Project) -> None:
    """Soft-deleted Tasks younger than the retention window are NOT hard-deleted.

    Task carries ``deleted_at`` (stamped only by soft_delete(), mirrors
    Attachment/Dependency), the age_field that closes the gap where every
    Task tombstone was previously eligible for hard deletion on the very next
    nightly reap regardless of how recently it was deleted — leaving an
    offline mobile client no grace window to receive the tombstone. A Task
    soft-deleted moments ago must survive a 90-day window; an old one
    (deleted 95 days ago) must be reaped.
    """
    recent_task = _make_task(live_project, soft_delete=True)
    # deleted_at is already recent — leave it as-is.

    old_task = _make_task(live_project, soft_delete=True)
    _backdate_task_deleted_at(old_task, days_ago=95)

    _do_reap(override_days=90)

    assert Task.objects.filter(pk=recent_task.pk).exists(), (
        "task soft-deleted within the retention window should not be reaped"
    )
    assert not Task.objects.filter(pk=old_task.pk).exists(), (
        "task tombstone older than the retention window should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_respects_retention_window_for_dependency
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_respects_retention_window_for_dependency(
    live_project: Project,
) -> None:
    """Soft-deleted Dependency edges younger than the retention window are NOT hard-deleted.

    Dependency carries ``deleted_at`` (stamped only by soft_delete(), mirrors
    Task), the same age_field mechanism, applied to the dependency edges that
    feed the scheduler's CPM/float math — an offline client that misses a
    dependency deletion needs the same reconnect grace window a task deletion
    gets.
    """
    pred = _make_task(live_project)
    succ = _make_task(live_project)
    recent_dep = _make_dependency(pred, succ, soft_delete=True)
    # deleted_at is already recent — leave it as-is.

    pred2 = _make_task(live_project)
    succ2 = _make_task(live_project)
    old_dep = _make_dependency(pred2, succ2, soft_delete=True)
    _backdate_dependency_deleted_at(old_dep, days_ago=95)

    _do_reap(override_days=90)

    assert Dependency.objects.filter(pk=recent_dep.pk).exists(), (
        "dependency soft-deleted within the retention window should not be reaped"
    )
    assert not Dependency.objects.filter(pk=old_dep.pk).exists(), (
        "dependency tombstone older than the retention window should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_respects_retention_window_for_task_relation
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_respects_retention_window_for_task_relation(
    live_project: Project,
) -> None:
    """Soft-deleted TaskRelation links younger than the retention window survive.

    TaskRelation carries ``deleted_at`` (stamped only by soft_delete(), mirrors
    Dependency), the same age_field mechanism, so an offline client that misses a
    relation deletion gets the same reconnect grace window a dependency deletion
    gets. It reaps via the source task's project (no direct project FK).
    """
    src = _make_task(live_project)
    tgt = _make_task(live_project)
    recent_rel = _make_task_relation(src, tgt, soft_delete=True)
    # deleted_at is already recent — leave it as-is.

    src2 = _make_task(live_project)
    tgt2 = _make_task(live_project)
    old_rel = _make_task_relation(src2, tgt2, soft_delete=True)
    _backdate_task_relation_deleted_at(old_rel, days_ago=95)

    _do_reap(override_days=90)

    assert TaskRelation.objects.filter(pk=recent_rel.pk).exists(), (
        "relation soft-deleted within the retention window should not be reaped"
    )
    assert not TaskRelation.objects.filter(pk=old_rel.pk).exists(), (
        "relation tombstone older than the retention window should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_skips_archived_projects
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_skips_archived_projects(
    archived_project: Project, live_project: Project
) -> None:
    """Tombstones whose project is archived are left in place.

    Archived projects may be restored; their tombstone history must be
    preserved so sync clients can reconstruct state after a restore.
    """
    archived_task = _make_task(archived_project, soft_delete=True)
    live_task = _make_task(live_project, soft_delete=True)

    # Use override_days=0 so every time-filtered model (Task included, now that
    # it carries deleted_at) also clears its window — archived vs live remains
    # the only distinguisher.
    _do_reap(override_days=0)

    assert Task.objects.filter(pk=archived_task.pk).exists(), (
        "tombstone in archived project must not be hard-deleted"
    )
    assert not Task.objects.filter(pk=live_task.pk).exists(), (
        "tombstone in live project should be hard-deleted"
    )


# ---------------------------------------------------------------------------
# test_reap_domain_tombstones_returns_counts
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_domain_tombstones_returns_counts(live_project: Project) -> None:
    """_do_reap returns a dict with model labels as keys and deletion counts as values.

    Use override_days=0 so all tombstones are within the eligible window
    regardless of their actual age.
    """
    # Two deleted Tasks + one deleted Risk.
    _make_task(live_project, soft_delete=True)
    _make_task(live_project, soft_delete=True)
    deleted_risk = _make_risk(live_project, soft_delete=True)
    _backdate_risk_updated_at(deleted_risk, days_ago=1)  # within window — stays if days=90

    counts = _do_reap(override_days=0)

    # Must be a dict with at least the Task and Risk labels.
    assert isinstance(counts, dict), "return value must be a dict"
    assert "projects.task" in counts, "Task label must be present in counts"
    assert "projects.risk" in counts, "Risk label must be present in counts"
    assert counts["projects.task"] == 2, "should have deleted exactly 2 Task tombstones"
    # Risk is deleted because override_days=0 makes the cutoff == now,
    # so updated_at (which is near-now) falls before the cutoff only when
    # we force override_days=0 (cutoff = now - 0 days = now).
    # Use >= 1 instead of == 1 to be robust against race conditions.
    assert counts["projects.risk"] >= 1, "should have deleted at least 1 Risk tombstone"
    # Sprint, Dependency, and TaskRelation labels must also appear (zero counts is fine).
    assert "projects.sprint" in counts
    assert "projects.dependency" in counts
    assert "projects.taskrelation" in counts


# ---------------------------------------------------------------------------
# Label / SprintRetro / TimeEntry (#2342)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_reap_covers_label_sprintretro_and_timeentry_with_retention(live_project: Project) -> None:
    """Label, SprintRetro and TimeEntry tombstones are reaped only past the window."""
    from django.contrib.auth import get_user_model

    from trueppm_api.apps.projects.models import Label, Sprint, SprintRetro
    from trueppm_api.apps.timetracking.models import TimeEntry

    user = get_user_model().objects.create_user(username="reaper", password="pw")
    task = _make_task(live_project)
    old_ago = timezone.now() - timedelta(days=95)

    old_label = Label.objects.create(project=live_project, name="old")
    new_label = Label.objects.create(project=live_project, name="new")
    live_label = Label.objects.create(project=live_project, name="live")
    Label.objects.filter(pk__in=[old_label.pk, new_label.pk]).update(is_deleted=True)
    Label.objects.filter(pk=old_label.pk).update(updated_at=old_ago)

    def _retro() -> SprintRetro:
        sprint = Sprint.objects.create(
            project=live_project,
            name="S",
            start_date=date(2026, 1, 1),
            finish_date=date(2026, 1, 14),
        )
        return SprintRetro.objects.create(sprint=sprint)

    old_retro, new_retro = _retro(), _retro()
    SprintRetro.objects.filter(pk__in=[old_retro.pk, new_retro.pk]).update(is_deleted=True)
    SprintRetro.objects.filter(pk=old_retro.pk).update(updated_at=old_ago)

    def _entry() -> TimeEntry:
        return TimeEntry.objects.create(task=task, user=user, minutes=30)

    old_entry, new_entry = _entry(), _entry()
    TimeEntry.objects.filter(pk__in=[old_entry.pk, new_entry.pk]).update(
        is_deleted=True, deleted_at=timezone.now()
    )
    TimeEntry.objects.filter(pk=old_entry.pk).update(deleted_at=old_ago)

    counts = _do_reap(override_days=90)

    assert not Label.objects.filter(pk=old_label.pk).exists()
    assert Label.objects.filter(pk__in=[new_label.pk, live_label.pk]).count() == 2
    assert not SprintRetro.objects.filter(pk=old_retro.pk).exists()
    assert SprintRetro.objects.filter(pk=new_retro.pk).exists()
    assert not TimeEntry.objects.filter(pk=old_entry.pk).exists()
    assert TimeEntry.objects.filter(pk=new_entry.pk).exists()
    assert counts["projects.label"] == 1
    assert counts["projects.sprintretro"] == 1
    assert counts["timetracking.timeentry"] == 1
    # The floor rose, so a client whose cursor predates the reap is told to resync.
    live_project.refresh_from_db()
    assert live_project.tombstone_floor > 0


# ---------------------------------------------------------------------------
# ProjectMembership / RetroActionItem / task children (#2342)
# ---------------------------------------------------------------------------


def _deleted_at_rows(live_project: Project) -> dict[str, tuple[Any, Any]]:
    """Two tombstones per newly reaped model, each deleted through its real path.

    ``soft_delete()`` (not a raw ``update()``) so the test also proves the base
    class stamps the ``deleted_at`` clock these registry entries rely on.
    """
    from django.contrib.auth import get_user_model

    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.integrations.models import TaskLink
    from trueppm_api.apps.projects.models import (
        RetroActionItem,
        Sprint,
        SprintRetro,
        SuggestionState,
        TaskRecurrenceRule,
        TaskSuggestedAssignee,
    )

    User = get_user_model()
    users = [User.objects.create_user(username=f"reap{i}", password="pw") for i in range(2)]
    sprint = Sprint.objects.create(
        project=live_project, name="S", start_date=date(2026, 1, 1), finish_date=date(2026, 1, 14)
    )
    retro = SprintRetro.objects.create(sprint=sprint)
    tasks = [_make_task(live_project) for _ in range(2)]
    rows: dict[str, tuple[Any, Any]] = {
        "access.projectmembership": tuple(
            ProjectMembership.objects.create(project=live_project, user=u, role=Role.MEMBER)
            for u in users
        ),
        "projects.retroactionitem": tuple(
            RetroActionItem.objects.create(retro=retro, text=f"a{i}") for i in range(2)
        ),
        "projects.tasksuggestedassignee": tuple(
            TaskSuggestedAssignee.objects.create(
                task=t,
                suggested_user=users[0],
                suggested_by=users[0],
                state=SuggestionState.PENDING,
            )
            for t in tasks
        ),
        "integrations.tasklink": tuple(
            TaskLink.objects.create(task=t, url=f"https://x.test/{t.pk}", provider="gitlab")
            for t in tasks
        ),
        "projects.taskrecurrencerule": tuple(
            TaskRecurrenceRule.objects.create(task=t) for t in tasks
        ),
    }
    for pair in rows.values():
        for row in pair:
            row.soft_delete()
    return rows


@pytest.mark.django_db
def test_reap_covers_memberships_action_items_and_task_children_with_retention(
    live_project: Project,
) -> None:
    """Each newly registered model is reaped past the window and kept inside it,
    and the reap raises the project floor so a stale cursor is told to resync."""
    rows = _deleted_at_rows(live_project)
    old_ago = timezone.now() - timedelta(days=95)
    reaped_seqs = []
    for old, new in rows.values():
        assert new.deleted_at is not None
        type(old).objects.filter(pk=old.pk).update(deleted_at=old_ago)
        reaped_seqs.append(type(old).objects.get(pk=old.pk).sync_seq)

    counts = _do_reap(override_days=90)

    for label, (old, new) in rows.items():
        model = type(old)
        assert not model.objects.filter(pk=old.pk).exists(), label
        assert model.objects.filter(pk=new.pk).exists(), label
        assert counts[label] == 1, (label, counts)
    # Every reaped row's cursor sits at or below the floor, so a client whose
    # ``since`` predates any of them is answered ``resync_required`` (#2474).
    live_project.refresh_from_db()
    assert min(reaped_seqs) > 0
    assert live_project.tombstone_floor >= max(reaped_seqs)


@pytest.mark.django_db
def test_reap_skips_null_clock_for_new_models(live_project: Project) -> None:
    """A tombstone with no ``deleted_at`` (an old pod's write) is kept, never reaped early."""
    rows = _deleted_at_rows(live_project)
    for old, _new in rows.values():
        type(old).objects.filter(pk=old.pk).update(deleted_at=None)

    counts = _do_reap(override_days=0)

    for label, (old, _new) in rows.items():
        assert type(old).objects.filter(pk=old.pk).exists(), label
        assert counts[label] == 1, (label, counts)


@pytest.mark.django_db
def test_restore_and_membership_revive_clear_the_reap_clock(live_project: Project) -> None:
    """``restore()`` and the membership revive path clear ``deleted_at`` with the tombstone,
    so a later delete restamps a fresh clock instead of reusing a stale one."""
    from trueppm_api.apps.access.models import Role
    from trueppm_api.apps.access.views import _revive_revoked_membership

    rows = _deleted_at_rows(live_project)
    link = rows["integrations.tasklink"][0]
    link.restore()
    link.refresh_from_db()
    assert link.is_deleted is False and link.deleted_at is None

    membership = rows["access.projectmembership"][0]
    _revive_revoked_membership(membership, new_role=Role.MEMBER)
    membership.refresh_from_db()
    assert membership.is_deleted is False and membership.deleted_at is None


@pytest.mark.django_db
def test_retro_item_diff_tombstones_stamp_the_reap_clock(live_project: Project) -> None:
    """The retro save's set-based tombstones bypass ``soft_delete()`` and stamp the clock."""
    from trueppm_api.apps.projects.models import RetroActionItem, Sprint, SprintRetro
    from trueppm_api.apps.projects.views import _apply_retro_item_diff

    sprint = Sprint.objects.create(
        project=live_project, name="S", start_date=date(2026, 1, 1), finish_date=date(2026, 1, 14)
    )
    retro = SprintRetro.objects.create(sprint=sprint)
    item = RetroActionItem.objects.create(retro=retro, text="drop me")

    _apply_retro_item_diff(retro, live_project.pk, [], [], [item])

    item.refresh_from_db()
    assert item.is_deleted is True
    assert item.deleted_at is not None


def _rule_with_occurrences(live_project: Project) -> tuple[Any, Task, Task, Task]:
    """A template, its rule, a live occurrence, and an occurrence tombstoned recently."""
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    template = _make_task(live_project)
    rule = TaskRecurrenceRule.objects.create(task=template)
    live_occ = Task.objects.create(
        project=live_project,
        name="occurrence",
        duration=1,
        is_recurring=True,
        recurrence_rule=rule,
        recurrence_occurrence_date=date(2026, 2, 2),
    )
    deleted_occ = Task.objects.create(
        project=live_project,
        name="deleted occurrence",
        duration=1,
        is_recurring=True,
        recurrence_rule=rule,
        recurrence_occurrence_date=date(2026, 2, 9),
    )
    deleted_occ.soft_delete()
    return rule, template, live_occ, deleted_occ


def _assert_detached_and_republished(
    live_project: Project, occurrences: list[Task], before: dict[Any, tuple[int, int]]
) -> None:
    live_project.refresh_from_db()
    for occ in occurrences:
        row = Task._base_manager.get(pk=occ.pk)
        assert row.recurrence_rule_id is None
        # Unchanged: the occurrence stays out of CPM exactly as before the reap.
        assert row.is_recurring is True
        assert row.recurrence_occurrence_date == occ.recurrence_occurrence_date
        old_version, old_seq = before[occ.pk]
        assert row.server_version == old_version + 1
        # A fresh cursor above everything the client already pulled, so the
        # changed link reaches a client that holds the row.
        assert row.sync_seq > old_seq
        assert row.sync_seq <= live_project.last_sync_version


@pytest.mark.django_db
def test_reaping_a_stopped_recurrence_keeps_its_occurrences(live_project: Project) -> None:
    """Removing a recurrence keeps its occurrences; the reap of the rule must too.

    ``Task.recurrence_rule`` is CASCADE, so without the detach the reap of a rule
    tombstone hard-deleted every occurrence it had generated, live or not.
    """
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    rule, _template, live_occ, deleted_occ = _rule_with_occurrences(live_project)
    rule.soft_delete()  # what TaskRecurrenceRuleViewSet.perform_destroy does
    TaskRecurrenceRule.objects.filter(pk=rule.pk).update(
        deleted_at=timezone.now() - timedelta(days=95)
    )
    before = {
        o.pk: (o.server_version, o.sync_seq)
        for o in Task._base_manager.filter(pk__in=[live_occ.pk, deleted_occ.pk])
    }

    counts = _do_reap(override_days=90)

    assert counts["projects.taskrecurrencerule"] == 1
    assert not TaskRecurrenceRule.objects.filter(pk=rule.pk).exists()
    assert Task._base_manager.filter(pk=live_occ.pk, is_deleted=False).exists()
    # The recently tombstoned occurrence keeps its tombstone for its own window.
    assert Task._base_manager.filter(pk=deleted_occ.pk, is_deleted=True).exists()
    assert counts["projects.task"] == 0
    _assert_detached_and_republished(live_project, [live_occ, deleted_occ], before)


@pytest.mark.django_db
def test_reaping_a_deleted_template_keeps_its_live_occurrences(live_project: Project) -> None:
    """The template's reap cascades task -> rule -> occurrences; the occurrences survive."""
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    rule, template, live_occ, deleted_occ = _rule_with_occurrences(live_project)
    template.soft_delete()  # tombstones the rule with it (#4948)
    rule.refresh_from_db()
    assert rule.is_deleted is True
    _backdate_task_deleted_at(template, 95)
    before = {
        o.pk: (o.server_version, o.sync_seq)
        for o in Task._base_manager.filter(pk__in=[live_occ.pk, deleted_occ.pk])
    }

    _do_reap(override_days=90)

    assert not Task._base_manager.filter(pk=template.pk).exists()
    assert not TaskRecurrenceRule.objects.filter(pk=rule.pk).exists()
    assert Task._base_manager.filter(pk=live_occ.pk, is_deleted=False).exists()
    assert Task._base_manager.filter(pk=deleted_occ.pk, is_deleted=True).exists()
    _assert_detached_and_republished(live_project, [live_occ, deleted_occ], before)
    # No live row was hard-deleted, so the reap must not take the live_cascade path
    # (which forces every client to re-sync): the floor stays below the detached
    # occurrences' fresh cursors instead of jumping to the project head.
    live_project.refresh_from_db()
    assert live_project.tombstone_floor < min(
        Task._base_manager.get(pk=o.pk).sync_seq for o in (live_occ, deleted_occ)
    )
    assert live_project.tombstone_floor < live_project.last_sync_version


@pytest.mark.django_db
def test_reaped_occurrence_is_not_detached(live_project: Project) -> None:
    """An occurrence reaped in the same run is deleted, not rewritten first."""
    from trueppm_api.apps.projects.models import TaskRecurrenceRule

    rule, _template, live_occ, deleted_occ = _rule_with_occurrences(live_project)
    # Drop the live occurrence so the only row the rule owns is the one being reaped:
    # any detach would then be the sole thing that could advance the project cursor.
    Task._base_manager.filter(pk=live_occ.pk).delete()
    rule.soft_delete()
    TaskRecurrenceRule.objects.filter(pk=rule.pk).update(
        deleted_at=timezone.now() - timedelta(days=95)
    )
    _backdate_task_deleted_at(deleted_occ, 95)
    live_project.refresh_from_db()
    head_before = live_project.last_sync_version

    counts = _do_reap(override_days=90)

    assert not Task._base_manager.filter(pk=deleted_occ.pk).exists()
    assert counts["projects.task"] == 1
    # Rewriting a row that is about to be deleted would draw a sync_seq for nothing.
    live_project.refresh_from_db()
    assert live_project.last_sync_version == head_before


@pytest.mark.django_db
def test_seed_membership_grant_revives_a_tombstone_and_clears_the_reap_clock(
    live_project: Project,
) -> None:
    """Both seed importer grant paths share one helper that clears ``deleted_at``."""
    from django.contrib.auth import get_user_model

    from trueppm_api.apps.access.models import ProjectMembership, Role
    from trueppm_api.apps.projects.seed.importer import (
        _grant_seed_project_membership,
        _SeedImporter,
    )

    User = get_user_model()
    owner = User.objects.create_user(username="seed-owner", password="pw")
    member = User.objects.create_user(username="seed-member", password="pw")
    rows = [
        ProjectMembership.objects.create(project=live_project, user=u, role=Role.VIEWER)
        for u in (owner, member)
    ]
    for row in rows:
        row.soft_delete()
        row.refresh_from_db()
        assert row.deleted_at is not None

    importer = _SeedImporter({"accounts": []}, owner=owner, create_users=False)
    importer.users = {"m": member}
    importer._grant_project_memberships(
        live_project, {"members": [{"account": "m", "role": "MEMBER"}]}
    )

    # The owner grant in _create_project_structure calls the helper directly.
    _grant_seed_project_membership(live_project, owner, Role.OWNER)

    for user, role in ((member, Role.MEMBER), (owner, Role.OWNER)):
        revived = ProjectMembership.objects.get(project=live_project, user=user)
        assert revived.is_deleted is False
        assert revived.deleted_version is None
        assert revived.deleted_at is None
        assert revived.role == role
