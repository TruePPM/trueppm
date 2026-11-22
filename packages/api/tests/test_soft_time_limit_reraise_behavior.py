"""Behavioral pins for the ``SoftTimeLimitExceeded`` re-raise at each guarded handler (#4421).

``test_task_soft_time_limit_isolation.py`` proves by AST that the guard is
*present*; these tests prove the exception actually *propagates* instead of being
logged as an ordinary per-item failure, and that an ordinary ``Exception`` is still
swallowed (the guard must not widen into re-raising everything).
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from celery.exceptions import SoftTimeLimitExceeded

from trueppm_api.apps.projects.models import (
    Calendar,
    Project,
    Sprint,
    SprintState,
    Task,
)

_SERVICES = "trueppm_api.apps.projects.services.upsert_burndown_for_sprint"
_SEND = "django.core.mail.EmailMessage.send"
_LIMIT = SoftTimeLimitExceeded


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="P", start_date=date(2026, 4, 1), calendar=cal)


def _active_sprint(project: Project) -> Sprint:
    return Sprint.objects.create(
        project=project,
        name="S",
        start_date=date(2026, 4, 1),
        finish_date=date(2026, 4, 14),
        state=SprintState.ACTIVE,
        committed_points=1,
        committed_task_count=1,
    )


class TestSeedBurndownHandlers:
    def test_importer_reraises_soft_limit_but_swallows_other_errors(self) -> None:
        from trueppm_api.apps.projects.seed.importer import _SeedImporter

        sprint = SimpleNamespace(state=SprintState.ACTIVE, pk="s1")
        with patch(_SERVICES, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            _SeedImporter._refresh_active_sprint_burndown(MagicMock(), [sprint])  # type: ignore[arg-type]
        with patch(_SERVICES, side_effect=RuntimeError("boom")):
            _SeedImporter._refresh_active_sprint_burndown(MagicMock(), [sprint])  # type: ignore[arg-type]

    def test_replay_reraises_soft_limit_but_swallows_other_errors(self) -> None:
        from trueppm_api.apps.projects.seed import replay

        sprint = SimpleNamespace(
            state=SprintState.ACTIVE,
            start_date=date(2026, 4, 1),
            finish_date=date(2026, 4, 14),
            pk="s1",
        )
        ctx = SimpleNamespace(sprints={"s1": sprint})
        day = date(2026, 4, 5)
        with (
            patch.object(replay, "upsert_burndown_for_sprint", side_effect=_LIMIT()),
            pytest.raises(_LIMIT),
        ):
            replay._snapshot_active_sprints(ctx, day)  # type: ignore[arg-type]
        with patch.object(replay, "upsert_burndown_for_sprint", side_effect=RuntimeError("x")):
            replay._snapshot_active_sprints(ctx, day)  # type: ignore[arg-type]


class TestProjectReceivers:
    def test_status_changed_reraises_soft_limit(self) -> None:
        from trueppm_api.apps.projects.receivers import _on_task_status_changed

        task = SimpleNamespace(pk="t1", sprint=SimpleNamespace(state=SprintState.ACTIVE, pk="s1"))
        with patch(_SERVICES, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            _on_task_status_changed(None, task, "todo", "doing")
        with patch(_SERVICES, side_effect=RuntimeError("boom")):
            _on_task_status_changed(None, task, "todo", "doing")

    def test_soft_delete_receivers_reraise_soft_limit(self, project: Project) -> None:
        task = Task.objects.create(project=project, name="t", duration=1)
        task.is_deleted = True
        retro = "trueppm_api.apps.projects.retro_services.reset_promoted_task_on_delete"
        backlog = "trueppm_api.apps.projects.backlog_services.reset_pulled_item_on_task_delete"
        with patch(retro, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            task.save()
        with patch(backlog, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            task.save()
        # An ordinary failure is still isolated: the primary write succeeds.
        with patch(retro, side_effect=RuntimeError("boom")):
            task.save()

    def test_milestone_rollup_receiver_reraises_soft_limit(self, project: Project) -> None:
        sprint = _active_sprint(project)
        task = Task.objects.create(project=project, name="t", duration=1, sprint=sprint)
        milestone = Task.objects.create(project=project, name="m", duration=0, is_milestone=True)
        Sprint.objects.filter(pk=sprint.pk).update(target_milestone=milestone)
        # The receiver defers the recompute to commit (#4654), so the soft limit can
        # surface from either the scheduling call or the deferred flush.
        schedule = "trueppm_api.apps.projects.services.schedule_milestone_rollup"
        with patch(schedule, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            task.save()
        with patch(schedule, side_effect=RuntimeError("boom")):
            task.save()

        from trueppm_api.apps.projects.services import _PendingRollups

        recompute = "trueppm_api.apps.projects.services.recompute_milestone_rollup"
        pending = _PendingRollups()
        pending.ids[str(milestone.pk)] = None
        with patch(recompute, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            pending.flush()
        pending.ids[str(milestone.pk)] = None
        with patch(recompute, side_effect=RuntimeError("boom")):
            pending.flush()


class TestEmailSendHelpers:
    def test_notification_email_reraises_soft_limit_but_swallows_smtp_error(self) -> None:
        from trueppm_api.apps.notifications.tasks import _send_email_for_notification

        notif = SimpleNamespace(pk="n1", recipient=SimpleNamespace(pk=1, email="a@example.com"))
        kwargs = {"connection": MagicMock(), "from_email": "x@example.com", "reply_to": []}
        render = patch(
            "trueppm_api.apps.notifications.tasks._render_email", return_value=("subject", "body")
        )
        with render, patch(_SEND, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            _send_email_for_notification(notif, **kwargs)  # type: ignore[arg-type]
        with render, patch(_SEND, side_effect=OSError("smtp down")):
            assert _send_email_for_notification(notif, **kwargs) is False  # type: ignore[arg-type]

    def test_invite_email_reraises_soft_limit_but_swallows_smtp_error(self) -> None:
        from trueppm_api.apps.workspace.tasks import _send_invite_email

        invite = SimpleNamespace(pk="i1", email="a@example.com", email_token="tok")
        kwargs = {"connection": MagicMock(), "from_email": "x@example.com"}
        render = patch(
            "trueppm_api.apps.workspace.tasks._render_invite_email",
            return_value=("subject", "body"),
        )
        with render, patch(_SEND, side_effect=_LIMIT()), pytest.raises(_LIMIT):
            _send_invite_email(invite, **kwargs)  # type: ignore[arg-type]
        with render, patch(_SEND, side_effect=OSError("smtp down")):
            assert _send_invite_email(invite, **kwargs) is False  # type: ignore[arg-type]
