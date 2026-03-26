"""Tests for the risk_changed signal emitted by Risk.save() and Risk.soft_delete()."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Calendar, Project, Risk, RiskStatus
from trueppm_api.apps.projects.signals import risk_changed

User = get_user_model()


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="P", start_date=date(2026, 1, 1), calendar=calendar)


def _make_risk(project: Project, **kwargs: object) -> Risk:
    return Risk.objects.create(
        project=project,
        title="Test risk",
        probability=2,
        impact=3,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Emitted on create
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signal_emitted_on_create(project: Project) -> None:
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk = _make_risk(project)
        handler.assert_called_once()
        _, kwargs = handler.call_args
        assert kwargs["risk"] == risk
        assert kwargs["action"] == "saved"
    finally:
        risk_changed.disconnect(handler)


# ---------------------------------------------------------------------------
# Emitted when scoring fields change
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signal_emitted_on_probability_change(project: Project) -> None:
    risk = _make_risk(project)
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk.probability = 4
        risk.save(update_fields=["probability"])
        handler.assert_called_once()
        _, kwargs = handler.call_args
        assert kwargs["action"] == "saved"
    finally:
        risk_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_emitted_on_impact_change(project: Project) -> None:
    risk = _make_risk(project)
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk.impact = 5
        risk.save(update_fields=["impact"])
        handler.assert_called_once()
    finally:
        risk_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_emitted_on_status_change(project: Project) -> None:
    risk = _make_risk(project)
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk.status = RiskStatus.MITIGATING
        risk.save(update_fields=["status"])
        handler.assert_called_once()
    finally:
        risk_changed.disconnect(handler)


# ---------------------------------------------------------------------------
# NOT emitted for unrelated field changes
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signal_not_emitted_on_description_only_change(project: Project) -> None:
    risk = _make_risk(project)
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk.description = "Updated description"
        risk.save(update_fields=["description"])
        handler.assert_not_called()
    finally:
        risk_changed.disconnect(handler)


@pytest.mark.django_db
def test_signal_not_emitted_on_title_only_change(project: Project) -> None:
    risk = _make_risk(project)
    handler = MagicMock()
    risk_changed.connect(handler)
    try:
        risk.title = "New title"
        risk.save(update_fields=["title"])
        handler.assert_not_called()
    finally:
        risk_changed.disconnect(handler)


# ---------------------------------------------------------------------------
# Soft-delete emits "deleted"; no extra "saved" signal
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_signal_emitted_with_deleted_action_on_soft_delete(project: Project) -> None:
    risk = _make_risk(project)
    calls: list[tuple[object, object]] = []

    def capture(sender: object, **kwargs: object) -> None:
        calls.append((kwargs.get("action"), kwargs.get("risk")))

    risk_changed.connect(capture)
    try:
        risk.soft_delete()
        # Exactly one signal: action="deleted"
        assert calls == [("deleted", risk)]
    finally:
        risk_changed.disconnect(capture)
