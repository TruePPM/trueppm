"""Per-process bound on CPM passes run inside a request (#4657)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Calendar, Program, Project, Task
from trueppm_api.apps.scheduling import cpm_admission

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def one_slot(settings: object, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    cache.clear()  # throttle buckets
    settings.CPM_ON_READ_MAX_CONCURRENT = 1  # type: ignore[attr-defined]
    monkeypatch.setattr(cpm_admission, "CPM_SLOT_WAIT_SECONDS", 0.01)
    yield
    cache.clear()


def _urls() -> tuple[APIClient, list[str]]:
    user = get_user_model().objects.create_user(username="pm", password="x")
    calendar = Calendar.objects.create(name="Standard")
    program = Program.objects.create(name="Prog")
    project = Project.objects.create(
        name="P", start_date=date(2026, 1, 5), calendar=calendar, program=program
    )
    ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)
    ProgramMembership.objects.create(program=program, user=user, role=Role.OWNER)
    task = Task.objects.create(project=project, name="T", duration=2, wbs_path="1")
    client = APIClient()
    client.force_authenticate(user=user)
    base = f"/api/v1/projects/{project.pk}/schedule"
    return client, [
        f"{base}/derivation/?task_id={task.pk}&quantity=early_finish",
        f"{base}/driving-chain/?task_id={task.pk}",
        f"/api/v1/programs/{program.pk}/schedule/",
    ]


def test_a_held_slot_refuses_with_503_and_releasing_it_admits() -> None:
    client, urls = _urls()
    for url in urls:
        # Warm: the driving chain only runs CPM once the task has a schedule.
        Task.objects.update(early_start=date(2026, 1, 5), early_finish=date(2026, 1, 6))
        with cpm_admission.cpm_slot() as held:
            assert held
            refused = client.get(url)
        assert refused.status_code == 503, url
        assert refused.json()["code"] == "schedule_busy"
        assert refused["Retry-After"] == str(cpm_admission.CPM_BUSY_RETRY_AFTER_SECONDS)

        assert client.get(url).status_code == 200, url


def test_none_disables_the_bound(settings: object) -> None:
    settings.CPM_ON_READ_MAX_CONCURRENT = None  # type: ignore[attr-defined]
    with cpm_admission.cpm_slot() as first, cpm_admission.cpm_slot() as second:
        assert first and second
