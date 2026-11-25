"""The baseline changeset and the two exits (ADR-1477, #3150).

Pins §7's invariants: an unreasoned entry blocks ``taken`` in the API, ``kept``
is never refused for one, decisions are append-only, a reason is set once, the
old activate route cannot re-baseline a committed plan, and the structural
routes record exactly one entry per act while the non-structural ones record
none.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import amend, baselines
from trueppm_api.apps.projects.commit_moment import commit_project
from trueppm_api.apps.projects.models import (
    ApiToken,
    Baseline,
    BaselineDecision,
    Calendar,
    ChangesetEntry,
    ImmutableModelError,
    Project,
    ProjectLifecycle,
    Task,
)

API = "/api/v1"


@pytest.fixture
def owner(db: object) -> object:
    return get_user_model().objects.create_user(username="cs-owner", password="pw")


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def client(owner: object) -> APIClient:
    return _client(owner)


def _task(project: Project, name: str, path: str, finish: date) -> Task:
    return Task.objects.create(
        project=project,
        name=name,
        duration=5,
        wbs_path=path,
        early_start=finish - timedelta(days=4),
        early_finish=finish,
    )


@pytest.fixture
def committed(owner: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    p = Project.objects.create(
        name="Pad 39C", start_date=date(2026, 3, 2), calendar=cal, lifecycle=ProjectLifecycle.DRAFT
    )
    ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
    _task(p, "Permits", "1", date(2026, 3, 6))
    _task(p, "Survey", "2", date(2026, 3, 11))
    _task(p, "Pour", "3", date(2026, 3, 20))
    commit_project(p, user=owner)
    p.refresh_from_db()
    return p


def _member(project: Project, role: int, name: str) -> APIClient:
    u = get_user_model().objects.create_user(username=name, password="pw")
    ProjectMembership.objects.create(project=project, user=u, role=role)
    return _client(u)


def _entries(project: Project) -> list[ChangesetEntry]:
    return list(ChangesetEntry.objects.filter(project=project).order_by("opened_at"))


@pytest.mark.django_db
class TestStructuralWritesJoinTheChangeset:
    def test_create_on_a_committed_plan_opens_an_unreasoned_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        r = client.post(
            f"{API}/tasks/", {"project": str(committed.pk), "name": "Rebar", "duration": 2}
        )
        assert r.status_code == 201, r.content
        [entry] = _entries(committed)
        assert entry.kind == "add"
        assert entry.reason is None and entry.reason_state == "unreasoned"
        assert entry.task_ids == [r.json()["id"]]
        assert entry.baseline is not None and entry.baseline.name == "Baseline v1"
        assert entry.finish_before == date(2026, 3, 20)

    def test_draft_writes_record_nothing(self, client: APIClient, owner: object) -> None:
        p = Project.objects.create(
            name="Draft", start_date=date(2026, 3, 2), lifecycle=ProjectLifecycle.DRAFT
        )
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
        r = client.post(f"{API}/tasks/", {"project": str(p.pk), "name": "x", "duration": 1})
        assert r.status_code == 201
        assert not ChangesetEntry.objects.filter(project=p).exists()

    def test_moves_of_the_same_kind_group_into_one_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        t3 = Task.objects.get(project=committed, name="Pour")
        assert (
            client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/").status_code == 200
        )
        assert (
            client.post(f"{API}/projects/{committed.pk}/tasks/{t3.pk}/indent/").status_code == 200
        )
        [entry] = _entries(committed)
        assert entry.kind == "move"
        assert set(entry.task_ids) == {str(t2.pk), str(t3.pk)}

    def test_a_different_kind_opens_its_own_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/")
        client.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "New", "duration": 1})
        assert [e.kind for e in _entries(committed)] == ["move", "add"]

    def test_amend_group_new_and_the_window_close_a_group(
        self, client: APIClient, committed: Project
    ) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        t3 = Task.objects.get(project=committed, name="Pour")
        client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/")
        client.post(
            f"{API}/projects/{committed.pk}/tasks/{t3.pk}/indent/",
            {"amend_group": "new"},
            format="json",
        )
        assert len(_entries(committed)) == 2
        # Past the two-minute window, a third act opens a third entry.
        ChangesetEntry.objects.filter(project=committed).update(
            last_act_at=timezone.now() - timedelta(seconds=amend.GROUP_WINDOW_SECONDS + 1)
        )
        client.post(f"{API}/projects/{committed.pk}/tasks/{t3.pk}/outdent/")
        assert len(_entries(committed)) == 3

    def test_surface_is_part_of_the_key(self, client: APIClient, committed: Project) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        t3 = Task.objects.get(project=committed, name="Pour")
        url = f"{API}/projects/{committed.pk}/tasks/%s/indent/"
        client.post(url % t2.pk, {"surface": "board"}, format="json")
        client.post(url % t3.pk, {"surface": "grid"}, format="json")
        assert sorted(e.surface for e in _entries(committed)) == ["board", "grid"]

    def test_another_author_never_joins_my_group(
        self, client: APIClient, committed: Project
    ) -> None:
        other = _member(committed, Role.ADMIN, "cs-admin")
        t2 = Task.objects.get(project=committed, name="Survey")
        t3 = Task.objects.get(project=committed, name="Pour")
        client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/")
        other.post(f"{API}/projects/{committed.pk}/tasks/{t3.pk}/indent/")
        assert len(_entries(committed)) == 2

    def test_an_amend_reason_on_the_write_answers_the_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        r = client.post(
            f"{API}/tasks/",
            {
                "project": str(committed.pk),
                "name": "Rebar",
                "duration": 2,
                "amend_reason": "RFI 12",
            },
            format="json",
        )
        assert r.status_code == 201, r.content
        [entry] = _entries(committed)
        assert entry.reason == "RFI 12" and entry.closed_at is not None

    def test_delete_and_restore_retracts_the_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        t3 = Task.objects.get(project=committed, name="Pour")
        assert client.delete(f"{API}/tasks/{t3.pk}/").status_code == 204
        [entry] = _entries(committed)
        assert entry.kind == "delete" and entry.task_names == ["Pour"]
        r = client.post(f"{API}/tasks/{t3.pk}/restore/")
        assert r.status_code == 200, r.content
        # Undoing the last act of a group deletes the entry, reason and all (D10).
        assert _entries(committed) == []

    def test_a_multi_select_bulk_delete_is_one_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        ids = [
            str(t.pk) for t in Task.objects.filter(project=committed, name__in=["Survey", "Pour"])
        ]
        r = client.post(
            f"{API}/projects/{committed.pk}/tasks/bulk/",
            {"operations": [{"op": "delete", "id": i} for i in ids]},
            format="json",
        )
        assert r.status_code in (200, 207), r.content
        [entry] = _entries(committed)
        assert entry.kind == "delete" and set(entry.task_ids) == set(ids)

    def test_a_member_structural_write_still_records_an_unreasoned_entry(
        self, committed: Project
    ) -> None:
        member = _member(committed, Role.MEMBER, "cs-member")
        r = member.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "m", "duration": 1})
        if r.status_code == 201:
            [entry] = _entries(committed)
            assert entry.reason is None
        else:
            # Members may not be able to create on this plan at all; then nothing joins.
            assert _entries(committed) == []


@pytest.mark.django_db
class TestNotStructural:
    def test_date_and_sprint_patches_create_no_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        from trueppm_api.apps.projects.models import Sprint

        t = Task.objects.get(project=committed, name="Permits")
        sprint = Sprint.objects.create(
            project=committed,
            name="S1",
            start_date=date(2026, 3, 2),
            finish_date=date(2026, 3, 13),
        )
        assert (
            client.patch(f"{API}/tasks/{t.pk}/", {"duration": 9}, format="json").status_code == 200
        )
        r = client.patch(f"{API}/tasks/{t.pk}/", {"sprint": str(sprint.pk)}, format="json")
        assert r.status_code == 200, r.content
        assert _entries(committed) == []


@pytest.mark.django_db
class TestChangesetRead:
    def test_unreasoned_first_with_counts_and_provenance(
        self, client: APIClient, committed: Project
    ) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        client.post(
            f"{API}/tasks/",
            {"project": str(committed.pk), "name": "a", "duration": 1, "amend_reason": "scope"},
            format="json",
        )
        client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/")
        body = client.get(f"{API}/projects/{committed.pk}/changeset/").json()
        assert body["open_count"] == 2 and body["unreasoned_count"] == 1
        assert [e["reason_state"] for e in body["entries"]] == ["unreasoned", "reasoned"]
        assert body["finish_baseline"] == "2026-03-20"
        assert "_provenance" in body and body["_provenance"]["input_hash"]
        assert body["entries_since_kept"] == 2 and body["last_kept_at"] is None

    def test_viewer_can_read_but_not_answer(self, committed: Project, client: APIClient) -> None:
        client.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "a", "duration": 1})
        viewer = _member(committed, Role.VIEWER, "cs-viewer")
        assert viewer.get(f"{API}/projects/{committed.pk}/changeset/").status_code == 200
        [entry] = _entries(committed)
        r = viewer.patch(
            f"{API}/projects/{committed.pk}/changeset/entries/{entry.pk}/",
            {"reason": "x"},
            format="json",
        )
        assert r.status_code == 403

    def test_outsider_cannot_read(self, committed: Project) -> None:
        stranger = _client(get_user_model().objects.create_user(username="cs-out", password="pw"))
        assert stranger.get(f"{API}/projects/{committed.pk}/changeset/").status_code in (403, 404)


@pytest.mark.django_db
class TestReasonIsSetOnce:
    def test_scheduler_answers_once_then_409(self, committed: Project, client: APIClient) -> None:
        client.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "a", "duration": 1})
        [entry] = _entries(committed)
        sched = _member(committed, Role.SCHEDULER, "cs-sched")
        url = f"{API}/projects/{committed.pk}/changeset/entries/{entry.pk}/"
        r = sched.patch(url, {"reason": "Vendor slipped"}, format="json")
        assert r.status_code == 200, r.content
        assert r.json()["reason_state"] == "reasoned"
        r2 = sched.patch(url, {"reason": "rewrite"}, format="json")
        assert r2.status_code == 409 and r2.json()["code"] == "reason_already_set"
        entry.refresh_from_db()
        assert entry.reason == "Vendor slipped" and entry.closed_at is not None

    def test_member_cannot_answer(self, committed: Project, client: APIClient) -> None:
        client.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "a", "duration": 1})
        [entry] = _entries(committed)
        member = _member(committed, Role.MEMBER, "cs-mem2")
        r = member.patch(
            f"{API}/projects/{committed.pk}/changeset/entries/{entry.pk}/",
            {"reason": "x"},
            format="json",
        )
        assert r.status_code == 403


@pytest.mark.django_db
class TestTheTwoExits:
    def _open_one(self, client: APIClient, project: Project) -> ChangesetEntry:
        client.post(f"{API}/tasks/", {"project": str(project.pk), "name": "a", "duration": 1})
        return _entries(project)[-1]

    def _post(self, client: APIClient, project: Project, **body: object) -> object:
        return client.post(f"{API}/projects/{project.pk}/baseline-decisions/", body, format="json")

    def test_taken_is_refused_while_any_entry_is_unreasoned(
        self, client: APIClient, committed: Project
    ) -> None:
        entry = self._open_one(client, committed)
        r = self._post(
            client,
            committed,
            kind="taken",
            expected_open_count=1,
            reason_code="approved_scope_change",
            reason="CO-7",
        )
        assert r.status_code == 409
        assert r.json() == {"code": "changeset_unreasoned", "entries": [str(entry.pk)]}
        assert Baseline.objects.filter(project=committed).count() == 1

    def test_kept_is_never_refused_for_unreasoned_entries(
        self, client: APIClient, committed: Project
    ) -> None:
        entry = self._open_one(client, committed)
        r = self._post(client, committed, kind="kept", expected_open_count=1, note="variance ok")
        assert r.status_code == 201, r.content
        assert r.json()["kind"] == "kept" and r.json()["entry_ids"] == [str(entry.pk)]
        entry.refresh_from_db()
        assert entry.resolved_by is None and entry.closed_at is not None
        body = client.get(f"{API}/projects/{committed.pk}/changeset/").json()
        assert body["open_count"] == 1 and body["entries_since_kept"] == 0
        assert body["last_kept_at"] is not None
        # One new structural edit re-promotes Review (Q3.1).
        self._open_one(client, committed)
        body = client.get(f"{API}/projects/{committed.pk}/changeset/").json()
        assert body["entries_since_kept"] == 1 and body["open_count"] == 2

    def test_taken_captures_v2_and_resolves_the_entries(
        self, client: APIClient, committed: Project
    ) -> None:
        entry = self._open_one(client, committed)
        ChangesetEntry.objects.filter(pk=entry.pk).update(reason="Approved CO-7")
        r = self._post(
            client,
            committed,
            kind="taken",
            expected_open_count=1,
            reason_code="approved_scope_change",
            reason="Sponsor re-agreed scope",
        )
        assert r.status_code == 201, r.content
        v2 = Baseline.objects.get(project=committed, is_active=True)
        assert v2.name == "Baseline v2" and r.json()["to_baseline"] == str(v2.pk)
        assert v2.tasks.count() == 4  # the three committed tasks plus the add
        entry.refresh_from_db()
        assert str(entry.resolved_by_id) == r.json()["id"]
        assert client.get(f"{API}/projects/{committed.pk}/changeset/").json()["open_count"] == 0

    def test_taken_requires_a_code_and_a_reason(
        self, client: APIClient, committed: Project
    ) -> None:
        r = self._post(client, committed, kind="taken", expected_open_count=0)
        assert r.status_code == 400
        assert {"reason_code", "reason"} <= set(r.json())

    def test_stale_open_count_is_409_changeset_changed(
        self, client: APIClient, committed: Project
    ) -> None:
        self._open_one(client, committed)
        r = self._post(client, committed, kind="kept", expected_open_count=0)
        assert r.status_code == 409 and r.json() == {"code": "changeset_changed", "open_count": 1}

    def test_commitment_move_is_refused_until_the_field_exists(
        self, client: APIClient, committed: Project
    ) -> None:
        r = self._post(
            client,
            committed,
            kind="taken",
            expected_open_count=0,
            reason_code="sponsor_moved_commitment",
            reason="x",
            commitment_moved=True,
        )
        assert r.status_code == 400 and r.json()["code"] == "commitment_not_available"

    @pytest.mark.parametrize("role", [Role.SCHEDULER, Role.MEMBER, Role.VIEWER])
    def test_only_admin_and_owner_decide(self, committed: Project, role: int) -> None:
        c = _member(committed, role, f"cs-r{role}")
        r = c.post(
            f"{API}/projects/{committed.pk}/baseline-decisions/",
            {"kind": "kept", "expected_open_count": 0},
            format="json",
        )
        assert r.status_code == 403
        assert (
            c.get(f"{API}/projects/{committed.pk}/baseline-decisions/preview/").status_code == 403
        )
        assert c.get(f"{API}/projects/{committed.pk}/baseline-decisions/").status_code == 200

    def test_admin_decides(self, committed: Project) -> None:
        c = _member(committed, Role.ADMIN, "cs-adm")
        r = c.post(
            f"{API}/projects/{committed.pk}/baseline-decisions/",
            {"kind": "kept", "expected_open_count": 0},
            format="json",
        )
        assert r.status_code == 201, r.content

    def test_a_token_caller_is_refused(self, committed: Project, owner: object) -> None:
        c = APIClient()
        c.force_authenticate(user=owner, token=ApiToken(name="t"))
        r = c.post(
            f"{API}/projects/{committed.pk}/baseline-decisions/",
            {"kind": "kept", "expected_open_count": 0},
            format="json",
        )
        assert r.status_code == 403
        assert not BaselineDecision.objects.filter(project=committed).exists()

    def test_draft_has_no_decision(self, client: APIClient, owner: object) -> None:
        p = Project.objects.create(
            name="Draft", start_date=date(2026, 3, 2), lifecycle=ProjectLifecycle.DRAFT
        )
        ProjectMembership.objects.create(project=p, user=owner, role=Role.OWNER)
        r = self._post(client, p, kind="kept", expected_open_count=0)
        assert r.status_code == 409 and r.json()["code"] == "project_not_committed"

    def test_preview_reads_the_net_effect_even_while_blocked(
        self, client: APIClient, committed: Project
    ) -> None:
        self._open_one(client, committed)
        Task.objects.filter(project=committed, name="Pour").update(early_finish=date(2026, 3, 27))
        body = client.get(f"{API}/projects/{committed.pk}/baseline-decisions/preview/").json()
        assert body["finish_from"] == "2026-03-20" and body["finish_to"] == "2026-03-27"
        assert body["delta_days"] == 7
        assert body["tasks_with_new_dates"]["of"] == 4
        assert body["commitment_moves"] is False and "_provenance" in body

    def test_trail_lists_newest_first(self, client: APIClient, committed: Project) -> None:
        self._post(client, committed, kind="kept", expected_open_count=0, note="one")
        self._post(client, committed, kind="kept", expected_open_count=0, note="two")
        rows = client.get(f"{API}/projects/{committed.pk}/baseline-decisions/").json()
        assert [r["note"] for r in rows] == ["two", "one"]


@pytest.mark.django_db
class TestInvariants:
    def test_decisions_are_append_only(self, committed: Project, owner: object) -> None:
        row = baselines.decide(
            committed,
            user=owner,
            data=baselines.DecisionInput(kind="kept", expected_open_count=0),
        )
        assert isinstance(row, BaselineDecision)
        row.note = "edited"
        with pytest.raises(ImmutableModelError):
            row.save()
        with pytest.raises(ImmutableModelError):
            row.delete()

    def test_activate_is_refused_on_a_committed_plan(
        self, client: APIClient, committed: Project
    ) -> None:
        other = Baseline.objects.create(project=committed, name="Comparison")
        r = client.post(f"{API}/projects/{committed.pk}/baselines/{other.pk}/activate/")
        assert r.status_code == 409 and r.json()["code"] == "use_baseline_decision"
        assert Baseline.objects.get(project=committed, is_active=True).name == "Baseline v1"

    def test_a_named_comparison_baseline_is_still_allowed(
        self, client: APIClient, committed: Project
    ) -> None:
        r = client.post(f"{API}/projects/{committed.pk}/baselines/", {"name": "Q2 compare"})
        assert r.status_code == 201, r.content

    def test_recalc_stamp_sets_finish_after_once(
        self, client: APIClient, committed: Project
    ) -> None:
        client.post(f"{API}/tasks/", {"project": str(committed.pk), "name": "a", "duration": 1})
        Task.objects.filter(project=committed, name="Pour").update(early_finish=date(2026, 3, 25))
        amend.stamp_finish_after({committed.pk})
        [entry] = _entries(committed)
        assert entry.finish_after == date(2026, 3, 25)
        Task.objects.filter(project=committed, name="Pour").update(early_finish=date(2026, 4, 1))
        amend.stamp_finish_after({committed.pk})
        entry.refresh_from_db()
        assert entry.finish_after == date(2026, 3, 25)


class TestTheOneCapture:
    """Taking v2 announces itself like any capture; the REST create shares it (B5, G4, G6)."""

    def _taken(self, client: APIClient, project: Project) -> object:
        return client.post(
            f"{API}/projects/{project.pk}/baseline-decisions/",
            {
                "kind": "taken",
                "expected_open_count": 0,
                "reason_code": "approved_scope_change",
                "reason": "Sponsor re-agreed scope",
            },
            format="json",
        )

    def test_taken_fires_the_webhook_and_the_board_event(
        self, client: APIClient, committed: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        from unittest.mock import patch

        with (
            patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hook,
            patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as board,
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = self._taken(client, committed)
        assert r.status_code == 201, r.content
        v2 = Baseline.objects.get(project=committed, is_active=True)
        captured = [c.args for c in hook.call_args_list if c.args[1] == "baseline.captured"]
        assert len(captured) == 1 and captured[0][2]["id"] == str(v2.pk)
        assert (str(committed.pk), "baseline_created", {"id": str(v2.pk)}) in [
            c.args for c in board.call_args_list
        ]

    def test_rest_create_goes_through_capture_and_is_never_active(
        self, client: APIClient, committed: Project, django_capture_on_commit_callbacks: object
    ) -> None:
        from unittest.mock import patch

        with (
            patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hook,
            django_capture_on_commit_callbacks(execute=True),  # type: ignore[operator]
        ):
            r = client.post(
                f"{API}/projects/{committed.pk}/baselines/", {"name": "Compare"}, format="json"
            )
        assert r.status_code == 201, r.content
        b = Baseline.objects.get(pk=r.json()["id"])
        assert not b.is_active and b.tasks.count() == 3 and r.json()["task_count"] == 3
        assert [c.args[1] for c in hook.call_args_list] == ["baseline.captured"]

    def test_the_active_baseline_of_a_committed_plan_is_not_deletable(
        self, client: APIClient, committed: Project
    ) -> None:
        active = Baseline.objects.get(project=committed, is_active=True)
        r = client.delete(f"{API}/projects/{committed.pk}/baselines/{active.pk}/")
        assert r.status_code == 409 and r.json()["code"] == "use_baseline_decision"
        other = client.post(
            f"{API}/projects/{committed.pk}/baselines/", {"name": "Compare"}, format="json"
        ).json()
        assert (
            client.delete(f"{API}/projects/{committed.pk}/baselines/{other['id']}/").status_code
            == 204
        )

    def test_taking_v2_leaves_project_health_unchanged(
        self, client: APIClient, committed: Project
    ) -> None:
        before = Project.objects.get(pk=committed.pk).health
        overview_before = client.get(f"{API}/projects/{committed.pk}/").json().get("health")
        assert self._taken(client, committed).status_code == 201
        assert Project.objects.get(pk=committed.pk).health == before
        assert client.get(f"{API}/projects/{committed.pk}/").json().get("health") == overview_before


def _decide_both(client: APIClient, project: Project) -> None:
    """One ``kept`` and one ``taken`` decision on ``project``: both FKs to a baseline set."""
    url = f"{API}/projects/{project.pk}/baseline-decisions/"
    r = client.post(url, {"kind": "kept", "expected_open_count": 0}, format="json")
    assert r.status_code == 201, r.content
    client.post(f"{API}/tasks/", {"project": str(project.pk), "name": "a", "duration": 1})
    ChangesetEntry.objects.filter(project=project).update(reason="CO-7")
    r = client.post(
        url,
        {
            "kind": "taken",
            "expected_open_count": 1,
            "reason_code": "approved_scope_change",
            "reason": "Sponsor re-agreed scope",
        },
        format="json",
    )
    assert r.status_code == 201, r.content
    assert BaselineDecision.objects.filter(project=project).count() == 2


@pytest.mark.django_db
class TestHardDeleteWithDecisions:
    """A decision names baselines with RESTRICT, so a project hard-delete still cascades."""

    def test_hard_delete_projects_removes_a_project_with_decisions(
        self, client: APIClient, committed: Project
    ) -> None:
        from trueppm_api.apps.access.services import hard_delete_projects

        _decide_both(client, committed)
        assert hard_delete_projects([committed.pk]) == 1
        assert not Project.objects.filter(pk=committed.pk).exists()
        assert not BaselineDecision.objects.filter(project_id=committed.pk).exists()
        assert not Baseline.objects.filter(project_id=committed.pk).exists()

    def test_hard_delete_program_removes_its_projects_with_decisions(
        self, client: APIClient, committed: Project
    ) -> None:
        from trueppm_api.apps.access.services import hard_delete_program
        from trueppm_api.apps.projects.models import Program

        program = Program.objects.create(name="Pad program")
        Project.objects.filter(pk=committed.pk).update(program=program)
        _decide_both(client, committed)
        assert hard_delete_program(program.pk) == 1
        assert not Project.objects.filter(pk=committed.pk).exists()
        assert not Program.objects.filter(pk=program.pk).exists()

    def test_the_trail_still_refuses_a_direct_or_bulk_delete(
        self, client: APIClient, committed: Project
    ) -> None:
        from django.db.models import RestrictedError

        _decide_both(client, committed)
        with pytest.raises(ImmutableModelError):
            BaselineDecision.objects.filter(project=committed).delete()
        with pytest.raises(ImmutableModelError):
            BaselineDecision.objects.filter(project=committed).update(note="x")
        # A baseline the trail names cannot be removed on its own.
        named = BaselineDecision.objects.filter(project=committed, kind="taken").get()
        with pytest.raises(RestrictedError):
            Baseline.objects.filter(pk=named.to_baseline_id).delete()


@pytest.mark.django_db
class TestUndoRetractsOnlyTheUndoneAct:
    """``amend.retract`` takes back the act being undone, never an earlier or later one."""

    def test_restoring_a_deleted_add_keeps_the_add_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        body = {"project": str(committed.pk), "name": "X", "duration": 1}
        r = client.post(f"{API}/tasks/", body, format="json")
        assert r.status_code == 201, r.content
        tid = r.json()["id"]
        assert client.delete(f"{API}/tasks/{tid}/").status_code == 204
        assert sorted(e.kind for e in _entries(committed)) == ["add", "delete"]
        assert client.post(f"{API}/tasks/{tid}/restore/").status_code == 200
        assert Task.objects.filter(pk=tid, is_deleted=False).exists()
        [entry] = _entries(committed)
        assert entry.kind == "add" and entry.task_ids == [tid]

    def test_restoring_after_a_move_keeps_the_move_entry(
        self, client: APIClient, committed: Project
    ) -> None:
        t2 = Task.objects.get(project=committed, name="Survey")
        assert (
            client.post(f"{API}/projects/{committed.pk}/tasks/{t2.pk}/indent/").status_code == 200
        )
        assert client.delete(f"{API}/tasks/{t2.pk}/").status_code == 204
        assert client.post(f"{API}/tasks/{t2.pk}/restore/").status_code == 200
        [entry] = _entries(committed)
        assert entry.kind == "move" and entry.task_ids == [str(t2.pk)]

    def test_undoing_a_reparent_keeps_the_earlier_add(
        self, client: APIClient, committed: Project
    ) -> None:
        body = {"project": str(committed.pk), "name": "X", "duration": 1}
        r = client.post(f"{API}/tasks/", body, format="json")
        assert r.status_code == 201, r.content
        tid = r.json()["id"]
        parent = Task.objects.get(project=committed, name="Permits")
        moved = client.post(
            f"{API}/projects/{committed.pk}/tasks/{tid}/reparent/",
            {"new_parent_id": str(parent.pk)},
            format="json",
        )
        assert moved.status_code == 200, moved.content
        assert sorted(e.kind for e in _entries(committed)) == ["add", "move"]
        undo = client.post(
            f"{API}/structural-operations/{moved.json()['operation_id']}/undo/", {}, format="json"
        )
        assert undo.status_code == 200, undo.content
        [entry] = _entries(committed)
        assert entry.kind == "add" and entry.task_ids == [tid]

    def test_undoing_a_csv_import_retracts_its_add_entry(
        self, committed: Project, owner: object
    ) -> None:
        import base64

        from trueppm_api.apps.csvimport.models import CsvImportRequest, CsvImportStatus
        from trueppm_api.apps.csvimport.parser import parse_spreadsheet
        from trueppm_api.apps.msproject.importer import import_project
        from trueppm_api.apps.projects.task_batch_services import (
            finalize_import_fix_operation,
            undo_import_fix_operation,
        )

        from ..csvimport.fixtures import REFERENCE_CSV

        parsed = parse_spreadsheet(REFERENCE_CSV, "plan.csv")
        summary = import_project(str(committed.pk), parsed.project_data)
        created = summary["created_task_ids"]
        # What `csvimport.tasks` does inside the import's transaction.
        amend.record_import(committed.pk, created, owner.pk)  # type: ignore[attr-defined]
        [entry] = _entries(committed)
        assert entry.kind == "add" and entry.surface == "import"
        req = CsvImportRequest.objects.create(
            project=committed,
            filename="plan.csv",
            file_content_b64=base64.b64encode(REFERENCE_CSV).decode("ascii"),
            status=CsvImportStatus.DONE,
        )
        finalize_import_fix_operation(str(req.pk), committed.pk, created)
        req.refresh_from_db()
        assert undo_import_fix_operation(req)["deleted"] == len(created)
        assert _entries(committed) == []


@pytest.mark.django_db
class TestInlineReasonFloor:
    """An inline ``amend_reason`` answers the entry only at the reason PATCH's floor."""

    def test_a_member_reason_on_the_write_is_dropped(self, committed: Project) -> None:
        member = _member(committed, Role.MEMBER, "cs-mem")
        r = member.post(
            f"{API}/tasks/",
            {"project": str(committed.pk), "name": "Y", "duration": 1, "amend_reason": "because"},
            format="json",
        )
        assert r.status_code == 201, r.content
        [entry] = _entries(committed)
        assert entry.reason is None and entry.closed_at is None

    def test_an_admin_reason_on_the_write_is_stored(self, committed: Project) -> None:
        admin = _member(committed, Role.ADMIN, "cs-adm")
        r = admin.post(
            f"{API}/tasks/",
            {"project": str(committed.pk), "name": "Z", "duration": 1, "amend_reason": "RFI 9"},
            format="json",
        )
        assert r.status_code == 201, r.content
        [entry] = _entries(committed)
        assert entry.reason == "RFI 9" and entry.closed_at is not None

    def test_a_scheduler_reason_is_stored_at_the_floor(self, committed: Project) -> None:
        # A Scheduler cannot author the plan over REST (ADR-0773), so no HTTP write
        # reaches here as one; the floor itself is pinned on the recorder.
        from types import SimpleNamespace

        user = get_user_model().objects.create_user(username="cs-sch", password="pw")
        ProjectMembership.objects.create(project=committed, user=user, role=Role.SCHEDULER)
        task = Task.objects.get(project=committed, name="Pour")
        request = SimpleNamespace(user=user, data={"amend_reason": "RFI 10"})
        entry = amend.record_from_request(request, committed, "move", [task.pk])
        assert entry is not None and entry.reason == "RFI 10"
