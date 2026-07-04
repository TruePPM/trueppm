"""Tests for the forward-migration registry (ADR-0086 / ADR-0201, #645).

Covers the generic registry directly (never importing the Django migration
module) and the read-time upgrade wired into ``BoardSavedViewSerializer``.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import schema_migrations as sm
from trueppm_api.apps.projects.models import BoardSavedView, Calendar, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Generic registry (pure, no DB)
# ---------------------------------------------------------------------------


def test_current_version_defaults_to_one_for_unregistered_surface():
    assert sm.current_version("nope_not_registered") == 1


def test_stored_version_treats_absent_key_as_zero():
    assert sm.stored_version({"sort": "priority"}) == 0
    assert sm.stored_version({"schema_version": 2}) == 2
    assert sm.stored_version({"schema_version": "bad"}) == 0


def test_registry_applies_migrations_in_order():
    """A v0 -> v1 -> v2 -> v3 chain runs its steps sequentially."""
    surface = "test_chain_surface"
    sm.register_surface(surface, current_version=3)
    sm.register_migration(surface, 0, lambda p: {**p, "a": 1})
    sm.register_migration(surface, 1, lambda p: {**p, "b": 2})
    sm.register_migration(surface, 2, lambda p: {**p, "c": 3})

    result, version = sm.migrate_payload(surface, {})

    assert version == 3
    assert result == {"schema_version": 3, "a": 1, "b": 2, "c": 3}


def test_registry_respects_explicit_from_version():
    surface = "test_from_version_surface"
    sm.register_surface(surface, current_version=2)
    sm.register_migration(surface, 0, lambda p: {**p, "a": 1})
    sm.register_migration(surface, 1, lambda p: {**p, "b": 2})

    result, _ = sm.migrate_payload(surface, {"existing": 99}, from_version=1)

    # Only the 1 -> 2 step (adds "b") runs; the 0 -> 1 step (adds "a") is skipped.
    assert result == {"schema_version": 2, "existing": 99, "b": 2}
    assert "a" not in result


def test_already_current_payload_is_untouched_apart_from_stamp():
    surface = "test_noop_surface"
    sm.register_surface(surface, current_version=1)
    sm.register_migration(surface, 0, lambda p: {**p, "should_not_appear": True})

    payload = {"schema_version": 1, "x": 5}
    result, version = sm.migrate_payload(surface, payload)

    assert version == 1
    assert result == {"schema_version": 1, "x": 5}
    assert "should_not_appear" not in result


def test_future_version_payload_raises():
    surface = "test_future_surface"
    sm.register_surface(surface, current_version=1)

    with pytest.raises(sm.UnknownSchemaVersionError):
        sm.migrate_payload(surface, {"schema_version": 5})


def test_missing_step_in_chain_raises():
    surface = "test_gap_surface"
    sm.register_surface(surface, current_version=2)
    # Only register 0 -> 1; the 1 -> 2 step is missing.
    sm.register_migration(surface, 0, lambda p: {**p, "a": 1})

    with pytest.raises(sm.UnknownSchemaVersionError):
        sm.migrate_payload(surface, {})


# ---------------------------------------------------------------------------
# board_saved_view surface
# ---------------------------------------------------------------------------


def test_board_view_v0_backfills_canonical_keys():
    """A pre-convention (v0) board view payload gains the six canonical keys."""
    stale = {"sort": "start_date"}  # missing five keys, no schema_version

    result, version = sm.migrate_payload(sm.SURFACE_BOARD_SAVED_VIEW, stale)

    assert version == 1
    assert result == {
        "schema_version": 1,
        "sort": "start_date",  # existing value preserved
        "show_wip": True,
        "show_col_tints": True,
        "evm_mode": "off",
        "show_cost": False,
        "risk_linked_only": False,
    }


def test_board_view_current_payload_unchanged():
    current = {
        "schema_version": 1,
        "sort": "priority",
        "show_wip": False,
        "show_col_tints": False,
        "evm_mode": "both",
        "show_cost": True,
        "risk_linked_only": True,
    }
    result, version = sm.migrate_payload(sm.SURFACE_BOARD_SAVED_VIEW, current)
    assert version == 1
    assert result == current


# ---------------------------------------------------------------------------
# Serializer read path (DB) — read-time upgrade + schema_version field
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(name="SV Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def pm(project):
    user = User.objects.create_user(username="pm-sv", password="x")
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    return user


@pytest.fixture
def pm_client(pm):
    c = APIClient()
    c.force_authenticate(pm)
    return c


def _url(project_id):
    return f"/api/v1/projects/{project_id}/board-views/"


def test_create_defaults_schema_version_to_one(pm_client, project):
    resp = pm_client.post(
        _url(project.pk),
        {
            "name": "Fresh",
            "config": {
                "sort": "priority",
                "show_wip": True,
                "show_col_tints": True,
                "evm_mode": "off",
                "show_cost": False,
                "risk_linked_only": False,
            },
        },
        format="json",
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["schema_version"] == 1
    row = BoardSavedView.objects.get(pk=body["id"])
    assert row.schema_version == 1


def test_read_upgrades_stale_row_to_current_shape(pm_client, pm, project):
    """A row stored at version 0 with a partial config is upgraded on read."""
    row = BoardSavedView.objects.create(
        project=project,
        name="Legacy",
        config={"sort": "start_date"},  # partial, pre-convention shape
        created_by=pm,
        schema_version=0,
    )

    resp = pm_client.get(_url(project.pk))
    assert resp.status_code == 200
    view = next(v for v in resp.json() if v["id"] == str(row.id))

    assert view["schema_version"] == 1
    # The five missing keys are backfilled with their documented defaults.
    assert view["config"] == {
        "sort": "start_date",
        "show_wip": True,
        "show_col_tints": True,
        "evm_mode": "off",
        "show_cost": False,
        "risk_linked_only": False,
    }
    # schema_version is a sibling field, not mixed into the config blob.
    assert "schema_version" not in view["config"]


def test_read_leaves_current_row_config_intact(pm_client, pm, project):
    row = BoardSavedView.objects.create(
        project=project,
        name="Current",
        config={
            "sort": "percent_complete",
            "show_wip": False,
            "show_col_tints": True,
            "evm_mode": "spi",
            "show_cost": True,
            "risk_linked_only": False,
        },
        created_by=pm,
        schema_version=1,
    )

    resp = pm_client.get(_url(project.pk))
    view = next(v for v in resp.json() if v["id"] == str(row.id))

    assert view["schema_version"] == 1
    assert view["config"]["sort"] == "percent_complete"
    assert view["config"]["evm_mode"] == "spi"
