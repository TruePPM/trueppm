"""The commit moment (#2963) and the frozen calendar (ADR-0845).

Nothing marked "this is the plan we agreed to", so variance had nothing to
subtract from. These pin what commit does, what it refuses, and the one
property the whole feature rests on: that the anchor does not move.
"""

from __future__ import annotations

from datetime import date
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.commit_moment import AlreadyCommitted, commit_project
from trueppm_api.apps.projects.models import (
    Baseline,
    BaselineTask,
    Calendar,
    Project,
    ProjectLifecycle,
    Task,
)


@pytest.fixture
def user(db: object) -> object:
    return get_user_model().objects.create_user(username="commituser", password="pw")


@pytest.fixture
def client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard", working_days=31, hours_per_day=8.0)


@pytest.fixture
def draft(calendar: Calendar) -> Project:
    p = Project.objects.create(
        name="Pad 39C",
        start_date=date(2026, 3, 2),
        calendar=calendar,
        lifecycle=ProjectLifecycle.DRAFT,
    )
    Task.objects.create(
        project=p,
        name="Permits",
        duration=5,
        wbs_path="1",
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 6),
    )
    Task.objects.create(
        project=p,
        name="Survey",
        duration=3,
        wbs_path="2",
        early_start=date(2026, 3, 9),
        early_finish=date(2026, 3, 11),
    )
    return p


@pytest.mark.django_db
class TestCommit:
    def test_flips_lifecycle_and_captures_baseline_v1(self, draft: Project, user: object) -> None:
        result = commit_project(draft, user=user)
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.ACTIVE
        assert result.baseline.name == "Baseline v1"
        assert result.baseline.is_active is True
        assert result.task_count == 2
        assert BaselineTask.objects.filter(baseline=result.baseline).count() == 2

    def test_a_second_commit_is_refused(self, draft: Project, user: object) -> None:
        """A second 'v1' would move the anchor every variance number is measured from."""
        commit_project(draft, user=user)
        draft.refresh_from_db()
        with pytest.raises(AlreadyCommitted):
            commit_project(draft, user=user)
        assert Baseline.objects.filter(project=draft).count() == 1

    def test_the_commit_is_atomic(self, draft: Project, user: object) -> None:
        """A lifecycle flip without a baseline is worse than not committing.

        The claim would be visible and the missing anchor would not.
        """
        before = Baseline.objects.count()
        commit_project(draft, user=user)
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.ACTIVE
        assert Baseline.objects.count() == before + 1


@pytest.mark.django_db
class TestFrozenCalendar:
    """ADR-0845 — the property the whole feature rests on."""

    def test_the_baseline_records_the_calendar_by_VALUE(
        self, draft: Project, calendar: Calendar, user: object
    ) -> None:
        result = commit_project(draft, user=user)
        assert result.baseline.calendar_working_days == 31
        assert result.baseline.calendar_hours_per_day == 8.0
        assert result.baseline.calendar_id_at_capture == calendar.id

    def test_editing_the_calendar_afterwards_does_not_move_the_baseline(
        self, draft: Project, calendar: Calendar, user: object
    ) -> None:
        """The whole point.

        A reference would let a later calendar edit reshape the anchor, so
        variance would quietly agree with whatever the calendar last became —
        the number improving at the exact moment the plan got harder.
        """
        result = commit_project(draft, user=user)

        calendar.working_days = 63  # someone adds Saturday
        calendar.hours_per_day = 10.0
        calendar.save()

        result.baseline.refresh_from_db()
        assert result.baseline.calendar_working_days == 31, "frozen, not a live reference"
        assert result.baseline.calendar_hours_per_day == 8.0

    def test_a_project_with_no_calendar_captures_no_snapshot_rather_than_a_fake_one(
        self, user: object
    ) -> None:
        p = Project.objects.create(
            name="No calendar",
            start_date=date(2026, 3, 2),
            lifecycle=ProjectLifecycle.DRAFT,
        )
        result = commit_project(p, user=user)
        assert result.baseline.calendar_working_days is None


@pytest.mark.django_db
class TestADraftThatAlreadyHasABaseline:
    """#3129 finding 5 — a reachable 500, not a policy question.

    `BaselineViewSet` is not lifecycle-gated, so an Admin can capture a baseline
    on a project that is still a draft. `commit_project()` then created its own
    with ``is_active=True`` and never deactivated the incumbent, so the partial
    unique constraint `unique_active_baseline_per_project` raised
    ``IntegrityError`` — a 500 on the one transition a project cannot otherwise
    make.
    """

    @pytest.fixture
    def draft_with_baseline(self, draft: Project, user: object) -> Project:
        Baseline.objects.create(project=draft, name="Baseline 1", is_active=True)
        return draft

    def test_commit_succeeds_and_v1_becomes_the_only_active_baseline(
        self, draft_with_baseline: Project, user: object
    ) -> None:
        result = commit_project(draft_with_baseline, user=user)

        assert result.baseline.name == "Baseline v1"
        assert result.baseline.is_active is True
        actives = Baseline.objects.filter(project=draft_with_baseline, is_active=True)
        assert [b.pk for b in actives] == [result.baseline.pk], (
            "exactly one active baseline, and it is the anchor commit just laid down"
        )

    def test_the_superseded_baseline_is_kept_not_deleted(
        self, draft_with_baseline: Project, user: object
    ) -> None:
        """Deactivated, never removed — baseline history is kept forever (#3129)."""
        commit_project(draft_with_baseline, user=user)

        prior = Baseline.objects.get(project=draft_with_baseline, name="Baseline 1")
        assert prior.is_active is False

    def test_the_endpoint_answers_200_rather_than_500(
        self, client: APIClient, user: object, draft_with_baseline: Project
    ) -> None:
        ProjectMembership.objects.create(project=draft_with_baseline, user=user, role=Role.ADMIN)
        r = client.post(f"/api/v1/projects/{draft_with_baseline.id}/commit/")
        assert r.status_code == 200, "a pre-existing active baseline is not a server error"


@pytest.mark.django_db
class TestEndpoint:
    def test_commit_returns_the_baseline_and_counts(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        ProjectMembership.objects.create(project=draft, user=user, role=Role.OWNER)
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 200
        assert r.data["baseline_name"] == "Baseline v1"
        assert r.data["task_count"] == 2

    def test_the_resource_count_is_named_for_the_audience_not_a_delivery(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        """#3129 — nothing here notifies, so nothing here may be called ``notified_``.

        The count is a real fact worth returning (who has work in this plan), and
        the confirm sheet says so. What it must not do is assert a delivery: no
        notification row is written and no ``on_commit`` hook fires.
        """
        ProjectMembership.objects.create(project=draft, user=user, role=Role.OWNER)
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 200
        assert "assigned_resource_count" in r.data
        assert "notified_resource_count" not in r.data

    def test_committing_twice_is_a_409(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        ProjectMembership.objects.create(project=draft, user=user, role=Role.OWNER)
        client.post(f"/api/v1/projects/{draft.id}/commit/")
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == 409
        assert r.data["code"] == "already_committed"


@pytest.mark.django_db(transaction=True)
class TestCommitAnnouncesTheBaselineItCaptured:
    """#3129 — the automatic v1 was the one baseline nobody was told about.

    ``BaselineViewSet.perform_create`` broadcasts ``baseline_created`` and dispatches
    the ADR-0206 ``baseline.captured`` webhook. The commit path captures a baseline
    through the same model and did neither, so the anchor every variance number is
    measured from was invisible to live clients and to any integration subscribed to
    a published event whose documented meaning — "A baseline snapshot is captured" —
    plainly covers it.

    ``transaction=True`` because both dispatches are deferred with
    ``transaction.on_commit``: under the default wrapping-transaction fixture the
    callbacks never run and every assertion below would pass vacuously by never
    executing (see the valkey/on_commit note in project memory).
    """

    @pytest.fixture
    def committed(self, client: APIClient, user: object, draft: Project) -> tuple[object, Project]:
        ProjectMembership.objects.create(project=draft, user=user, role=Role.ADMIN)
        with (
            mock.patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as bcast,
            mock.patch("trueppm_api.apps.projects.views._dispatch_webhooks") as hook,
        ):
            r = client.post(f"/api/v1/projects/{draft.id}/commit/")
            assert r.status_code == 200
            yield (bcast, hook), draft

    def test_it_broadcasts_baseline_created(self, committed: tuple) -> None:
        (bcast, _hook), _draft = committed
        events = [c.args[1] for c in bcast.call_args_list]
        assert "baseline_created" in events, f"commit captured a baseline but broadcast {events!r}"

    def test_it_dispatches_the_baseline_captured_webhook(self, committed: tuple) -> None:
        (_bcast, hook), draft = committed
        dispatched = {c.args[1]: c.args[2] for c in hook.call_args_list}
        assert "baseline.captured" in dispatched
        payload = dispatched["baseline.captured"]
        assert payload["name"] == "Baseline v1"
        assert payload["task_count"] == 2
        assert payload["project"] == str(draft.pk)

    def test_the_payload_says_it_came_from_a_commit(self, committed: tuple) -> None:
        """A subscriber must be able to tell the automatic v1 from a manual capture."""
        (_bcast, hook), _draft = committed
        dispatched = {c.args[1]: c.args[2] for c in hook.call_args_list}
        assert dispatched["baseline.captured"]["source"] == "commit"


@pytest.mark.django_db
class TestTheRoleFloor:
    """#3129 findings 1 and 4 — pin the floor, because nothing did.

    Committing creates a baseline and activates it. Both acts are gated at
    ``IsProjectAdmin`` on ``BaselineViewSet.create`` and ``BaselineActivateView``,
    and the OSS role matrix (ADR-0072, issue #11) records "create baseline" against
    Project Manager. The floor here now matches; these tests exist so that moving
    it again has to be deliberate. Before them the suite covered only OWNER and
    MEMBER, so the Scheduler boundary itself — the one in dispute — was green
    either way.
    """

    @pytest.mark.parametrize(
        ("role", "expected"),
        [
            (Role.VIEWER, 403),
            (Role.MEMBER, 403),
            (Role.SCHEDULER, 403),
            (Role.ADMIN, 200),
            (Role.OWNER, 200),
        ],
    )
    def test_the_floor_is_admin(
        self, client: APIClient, user: object, draft: Project, role: int, expected: int
    ) -> None:
        ProjectMembership.objects.create(project=draft, user=user, role=role)
        r = client.post(f"/api/v1/projects/{draft.id}/commit/")
        assert r.status_code == expected

    def test_a_scheduler_leaves_the_project_in_draft(
        self, client: APIClient, user: object, draft: Project
    ) -> None:
        """The refusal has to be a refusal — not a 403 over a completed write."""
        ProjectMembership.objects.create(project=draft, user=user, role=Role.SCHEDULER)
        client.post(f"/api/v1/projects/{draft.id}/commit/")
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.DRAFT
        assert not Baseline.objects.filter(project=draft).exists()


@pytest.mark.django_db
class TestExistenceIsNotLeakedToNonMembers:
    """#3129 finding 3 — the endpoint was a membership-scoped existence oracle.

    An unscoped ``get_object_or_404`` answered 403 for a project that exists and
    404 for one that does not, so any authenticated stranger could enumerate real
    project ids. ``/archive/`` resolves through a membership-scoped queryset and
    has never had this shape; two sibling lifecycle endpoints must not disagree
    about whether a project's existence is a secret.
    """

    def test_a_non_member_gets_the_same_answer_for_a_real_and_a_fake_id(
        self, client: APIClient, draft: Project
    ) -> None:
        import uuid

        real = client.post(f"/api/v1/projects/{draft.id}/commit/")
        fake = client.post(f"/api/v1/projects/{uuid.uuid4()}/commit/")
        assert real.status_code == fake.status_code == 404, (
            "a real id and a fake one must be indistinguishable to a non-member"
        )

    def test_the_project_is_untouched(self, client: APIClient, draft: Project) -> None:
        client.post(f"/api/v1/projects/{draft.id}/commit/")
        draft.refresh_from_db()
        assert draft.lifecycle == ProjectLifecycle.DRAFT


class TestSchemaBinding:
    """The commit endpoint declares its own responses (#2963).

    The #2455 orphaned-decorator trap bit this MR too: the view was first
    inserted between the preceding view's `@extend_schema` and its class, which
    silently reassigned that decorator — the commit endpoint took a schema it
    never declared and its neighbor lost the one it did.

    A structural "is the decorator anchored to a class?" check does NOT catch
    this: decorator stacking is legal Python and looks identical. I wrote that
    check, it passed against the reintroduced bug, and I deleted it. What caught
    it — twice now — is asserting the GENERATED schema against what each
    endpoint declared, which is what this does.

    The neighbor was `BoardLanesView` until #3370 removed that route; the
    assertion below is re-pointed at the decorated view that now precedes
    `ProjectCommitView` in `projects/views.py`, which is what the guard needs.
    """

    @staticmethod
    def _schema() -> dict:
        import json
        from pathlib import Path

        root = Path(__file__).resolve().parents[5]
        return json.loads((root / "docs" / "api" / "openapi.json").read_text())

    def test_commit_declares_its_409(self) -> None:
        post = self._schema()["paths"]["/api/v1/projects/{id}/commit/"]["post"]
        assert "409" in post["responses"], "committing twice must be a documented refusal"

    def test_commit_declares_its_result_shape(self) -> None:
        post = self._schema()["paths"]["/api/v1/projects/{id}/commit/"]["post"]
        ref = post["responses"]["200"]["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/CommitProjectResult")

    def test_every_board_view_above_it_still_owns_its_own(self) -> None:
        """The half a misplacement silently strips.

        `BoardLanesView` was the immediate neighbor until #3370 removed it. What now
        precedes `ProjectCommitView` is ~140 lines of undecorated helper functions,
        then the three board views — so rather than pin the nearest one and lose the
        adjacency the guard depended on, pin all three. A decorator that slides onto
        the wrong class strips one of these, whichever way it slides.
        """
        schema = self._schema()
        expected = {
            ("/api/v1/projects/{id}/board-views/{view_pk}/", "patch"): "/BoardSavedView",
            ("/api/v1/projects/{id}/board-views/", "post"): "/BoardSavedView",
            ("/api/v1/projects/{id}/board-config/", "get"): "/BoardColumnConfigResponse",
        }
        for (path, method), suffix in expected.items():
            op = schema["paths"][path][method]
            code = "201" if method == "post" else "200"
            ref = op["responses"][code]["content"]["application/json"]["schema"]["$ref"]
            assert ref.endswith(suffix), f"{method.upper()} {path} lost its declared response"
