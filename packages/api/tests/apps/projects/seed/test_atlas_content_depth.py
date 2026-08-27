"""Atlas demonstrates mitigation, blocked work, and partial staffing (#3095).

Atlas is ``DEFAULT_SAMPLE`` and the target of the "Load demo data" button, so it
is the first — often only — data an evaluator sees. These assert the substance
the audit found missing, not merely that fields are populated: a risk register
that shows *how* work was mitigated, a blocker with a real age, allocations that
are not all one full unit, and mentions that actually notify somebody.
"""

from __future__ import annotations

import collections
import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone

from trueppm_api.apps.notifications.models import Mention, Notification
from trueppm_api.apps.projects.models import (
    Project,
    Risk,
    RiskComment,
    Task,
    TaskAttachment,
)
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.resources.models import TaskResource

pytestmark = pytest.mark.django_db

User = get_user_model()

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)


@pytest.fixture
def atlas(request: Any) -> Any:
    owner = User.objects.create_user(username="atlas-depth-owner", email="o@example.com")
    payload = json.loads((_SEEDS_DIR / "atlas-platform-launch.json").read_text(encoding="utf-8"))
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)
    return program


def _projects(program: Any) -> list[Project]:
    return list(Project.objects.filter(program=program))


# --- the risk register shows HOW, not just THAT -----------------------------


def test_risks_carry_trigger_contingency_and_a_due_date(atlas: Any) -> None:
    risks = Risk.objects.filter(project__in=_projects(atlas))
    assert risks.exclude(trigger="").count() >= 3
    assert risks.exclude(contingency="").count() >= 3
    assert risks.filter(mitigation_due_date__isnull=False).count() >= 3


def test_a_risk_links_a_mitigation_action_not_only_the_exposed_work(atlas: Any) -> None:
    """The audit's sharpest finding: every risk linked the task it threatened
    and none linked what anybody did about it."""
    risk = Risk.objects.get(
        project__in=_projects(atlas), title="SSO/identity vendor integration risk"
    )
    linked = set(risk.tasks.values_list("name", flat=True))
    assert "SSO login" in linked, "the exposed work"
    assert "Fallback IdP spike" in linked, "the mitigation action"


def test_the_mitigation_completes_before_the_risk_is_walked_down(atlas: Any) -> None:
    spike = Task.objects.get(project__in=_projects(atlas), name="Fallback IdP spike")
    assert spike.status == "COMPLETE"


def test_every_response_strategy_appears_including_avoid(atlas: Any) -> None:
    responses = set(
        Risk.objects.filter(project__in=_projects(atlas)).values_list("response", flat=True)
    )
    assert "AVOID" in responses, "no pack used AVOID before; scope was cut, not managed"
    assert {"MITIGATE", "ACCEPT"} <= responses


def test_a_status_flip_carries_its_reason(atlas: Any) -> None:
    notes = RiskComment.objects.filter(risk__project__in=_projects(atlas))
    assert notes.count() >= 4
    # Backdated, not stamped at import: created_at is auto_now_add.
    assert notes.order_by("created_at").first().created_at < timezone.now() - timedelta(days=5)


# --- blocked work -----------------------------------------------------------


def test_a_task_is_still_blocked_on_import_day_with_a_real_age(atlas: Any) -> None:
    """A block/unblock arc that resolves is the right narrative but leaves the
    board's Blocked lane empty at t=0, which is what an evaluator opens."""
    blocked = list(Task.objects.filter(project__in=_projects(atlas)).exclude(blocked_reason=""))
    assert blocked, "nothing is blocked on import day"
    task = blocked[0]
    assert task.blocker_type, "a typed blocker is the routable triage signal"
    assert task.blocked_since is not None
    age = timezone.now() - task.blocked_since
    assert age > timedelta(days=2), f"blocked age is {age}, so the badge reads ~0d"


def test_a_blocked_span_was_opened_and_closed(atlas: Any) -> None:
    """5.3 is blocked for four days and unblocked; Task.save()'s cascade must
    have cleared the whole cluster, not just the reason."""
    task = Task.objects.get(project__in=_projects(atlas), name="Digest scheduler")
    assert task.blocked_reason == ""
    assert task.blocked_since is None
    assert task.blocker_type == ""


# --- partial staffing -------------------------------------------------------


def test_allocations_are_not_all_one_full_unit(atlas: Any) -> None:
    """Without an explicit assignments[] block the importer synthesizes a single
    full unit per task, which cannot express a split or a shared specialist."""
    units = collections.Counter(
        float(u)
        for u in TaskResource.objects.filter(task__project__in=_projects(atlas)).values_list(
            "units", flat=True
        )
    )
    partial = {u: n for u, n in units.items() if 0 < u < 1.0}
    assert len(partial) >= 3, f"only these fractional allocations exist: {partial}"


def test_a_task_is_staffed_by_more_than_one_person(atlas: Any) -> None:
    counts = collections.Counter(
        TaskResource.objects.filter(task__project__in=_projects(atlas)).values_list(
            "task_id", flat=True
        )
    )
    assert max(counts.values()) >= 2


# --- external references and mentions ---------------------------------------


def test_tasks_carry_external_references(atlas: Any) -> None:
    attachments = TaskAttachment.objects.filter(task__project__in=_projects(atlas))
    assert attachments.count() >= 5
    assert all(a.external_url and not a.file for a in attachments), "URL-only by design"
    assert attachments.filter(is_pinned=True).exists()


def test_mentions_actually_notify_a_persona(atlas: Any) -> None:
    """An @mention that resolves to nobody renders as plain text and notifies no
    one — which is what happens if the body names a slug instead of a username."""
    assert Mention.objects.count() >= 3
    assert Notification.objects.count() >= 3
    mentioned = {
        m.mentioned_user.get_username()
        for m in Mention.objects.select_related("mentioned_user")
        if m.mentioned_user_id
    }
    assert mentioned, "mentions resolved to no user at all"
    assert all(u.startswith("atlas-") for u in mentioned)
