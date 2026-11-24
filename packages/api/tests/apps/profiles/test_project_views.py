"""The server-resolved project view set (ADR-1478, #3715).

Covers precedence and ``source``/``binding``, first-resolve seeding and its fail-open
path, the never-empty rule, apply-seed/reset/Show all touching only seed entries, the
``hidden_views`` compatibility window, the ``hidden_views`` backfill, and ownership.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from django.db import DatabaseError
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.profiles.backfill import backfill_project_view_states
from trueppm_api.apps.profiles.constants import (
    HIDEABLE_VIEW_KEYS,
    LENS_VIEW_SEEDS,
    METHODOLOGY_HIDDEN_VIEWS,
    METHODOLOGY_NEVER_HIDES,
)
from trueppm_api.apps.profiles.models import ProjectViewState, UserProfile
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()
pytestmark = pytest.mark.django_db


def _url(project: Project, suffix: str = "") -> str:
    return f"/api/v1/projects/{project.pk}/views/{suffix}"


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def cal() -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(cal: Calendar, methodology: str = "HYBRID", name: str = "P") -> Project:
    return Project.objects.create(
        name=name, start_date=date(2026, 9, 1), calendar=cal, methodology=methodology
    )


def _member(
    project: Project, lens: str = "unified", role: str = Role.MEMBER, name: str = ""
) -> Any:
    user = User.objects.create_user(username=name or f"u-{lens}-{project.pk}", password="pw")
    UserProfile.objects.create(user=user, role_context=lens)
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _views(data: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {v["key"]: v for v in data["views"]}


# --- registry contracts --------------------------------------------------------------


def test_methodology_matrix_matches_the_contract_file() -> None:
    root = Path(__file__).resolve().parents[5]
    contract = json.loads((root / "contracts" / "methodology-views.json").read_text())
    assert {k: sorted(v) for k, v in METHODOLOGY_HIDDEN_VIEWS.items()} == contract[
        "hiddenByMethodology"
    ]
    assert sorted(METHODOLOGY_NEVER_HIDES) == contract["methodologyNeverHides"]


def test_seeds_only_name_hideable_keys_and_have_no_po_lens_yet() -> None:
    for lens, seed in LENS_VIEW_SEEDS.items():
        assert seed.hide <= HIDEABLE_VIEW_KEYS, lens
        assert set(seed.landing.values()) <= HIDEABLE_VIEW_KEYS, lens
    assert set(LENS_VIEW_SEEDS) == {"pm", "scrum_master", "unified"}  # PO waits on #1467


# --- resolution and seeding ----------------------------------------------------------


def test_unified_lens_seeds_nothing_and_shows_no_seed_line(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "unified")
    data = _client(user).get(_url(p)).json()
    views = _views(data)
    assert views["overview"]["source"] == "always"
    assert all(v["visible"] for v in data["views"])
    assert {v["source"] for v in data["views"]} == {"always", "default"}
    assert data["seed_line"] is None and data["seeded_lens"] is None


def test_scrum_master_first_open_seeds_and_reports_source(cal: Calendar) -> None:
    p = _project(cal, "HYBRID")
    user = _member(p, "scrum_master")
    data = _client(user).get(_url(p)).json()
    views = _views(data)
    for key in ("schedule", "calendar", "resources"):
        assert views[key] == {
            **views[key],
            "visible": False,
            "source": "seed",
            "lens": "scrum_master",
        }
        assert views[key]["binding"] == "advisory"
    assert views["grid"]["visible"] is True
    assert data["seed_line"] == {"lens": "scrum_master", "hidden_count": 3}
    assert data["landing"] == "board"
    # Second read does not re-seed or duplicate.
    again = _client(user).get(_url(p)).json()
    assert again["views"] == data["views"]
    assert ProjectViewState.objects.filter(user=user, project=p).count() == 1


def test_methodology_is_advisory_and_never_hides_schedule(cal: Calendar) -> None:
    agile = _project(cal, "AGILE", "A")
    waterfall = _project(cal, "WATERFALL", "W")
    user = _member(agile, "unified", name="m")
    ProjectMembership.objects.create(project=waterfall, user=user, role=Role.MEMBER)
    a = _views(_client(user).get(_url(agile)).json())
    w = _views(_client(user).get(_url(waterfall)).json())
    assert a["schedule"]["visible"] is True  # ADR-1298
    assert a["calendar"] == {**a["calendar"], "visible": False, "source": "methodology"}
    assert w["sprints"]["binding"] == "advisory" and w["sprints"]["source"] == "methodology"


def test_seed_is_narrowed_by_methodology(cal: Calendar) -> None:
    p = _project(cal, "WATERFALL")
    user = _member(p, "pm")
    views = _views(_client(user).get(_url(p)).json())
    # pm seeds product-backlog, but Waterfall already hides it: methodology wins the label.
    assert views["product-backlog"]["source"] == "methodology"
    assert ProjectViewState.objects.get(user=user, project=p).hides == []


def test_seed_failure_fails_open_and_writes_nothing(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")
    with mock.patch.object(ProjectViewState.objects, "get_or_create", side_effect=DatabaseError):
        data = _client(user).get(_url(p)).json()
    assert all(v["visible"] for v in data["views"])
    assert {v["source"] for v in data["views"]} == {"always", "default"}
    assert not ProjectViewState.objects.filter(user=user).exists()
    # The next read seeds.
    assert _views(_client(user).get(_url(p)).json())["schedule"]["source"] == "seed"


def test_capacity_pool_manager_guard_keeps_people(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")
    with mock.patch("trueppm_api.apps.profiles.services.is_allocation_manager", return_value=True):
        views = _views(_client(user).get(_url(p)).json())
    assert views["resources"]["visible"] is True
    # Their own hide still works.
    resp = _client(user).patch(_url(p), {"key": "resources", "hidden": True}, format="json")
    assert _views(resp.json())["resources"]["source"] == "user"


# --- writes ---------------------------------------------------------------------------


def test_user_choice_overrides_seed_and_survives_reset(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")
    c = _client(user)
    c.get(_url(p))
    resp = c.patch(_url(p), {"key": "schedule", "hidden": False}, format="json")
    assert _views(resp.json())["schedule"] == {
        **_views(resp.json())["schedule"],
        "visible": True,
        "source": "user",
    }
    diff = c.post(_url(p, "reset/"), format="json").json()
    assert diff["kept"] == [{"view": "schedule", "hidden": False}]
    assert _views(c.get(_url(p)).json())["schedule"]["visible"] is True


def test_hiding_the_last_plan_layout_is_refused(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")  # seed hides schedule + calendar; grid is left
    c = _client(user)
    c.get(_url(p))
    resp = c.patch(_url(p), {"key": "grid", "hidden": True}, format="json")
    assert resp.status_code == 400 and resp.json()["code"] == "last_plan_layout"


def test_resolver_falls_back_to_schedule_when_plan_would_be_empty(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p)
    entries = [
        {"view": k, "hidden": True, "source": "user", "lens": None, "at": None}
        for k in ("schedule", "grid", "calendar")
    ]
    ProjectViewState.objects.create(user=user, project=p, hides=entries)
    views = _views(_client(user).get(_url(p)).json())
    assert views["schedule"] == {**views["schedule"], "visible": True, "source": "always"}


def test_show_all_clears_only_seed_hides_and_the_line(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")
    c = _client(user)
    c.get(_url(p))
    c.patch(_url(p), {"key": "risk", "hidden": True}, format="json")
    data = c.patch(_url(p), {"clear_seed": True}, format="json").json()
    views = _views(data)
    assert views["schedule"]["visible"] and views["resources"]["visible"]
    assert views["risk"]["visible"] is False and views["risk"]["source"] == "user"
    assert data["seed_line"] is None


def test_lens_change_never_reseeds_and_offers_apply(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "pm")
    c = _client(user)
    c.get(_url(p))
    c.patch(_url(p), {"key": "risk", "hidden": True}, format="json")
    UserProfile.objects.filter(user=user).update(role_context="scrum_master")
    data = c.get(_url(p)).json()
    assert _views(data)["schedule"]["visible"] is True  # reorders only
    assert data["lens_offer"] == "scrum_master"

    preview = c.post(_url(p, "apply-seed/"), {"lens": "scrum_master"}, format="json").json()
    assert preview["applied"] is False
    assert preview["will_hide"] == ["calendar", "resources", "schedule"]
    assert preview["will_show"] == ["product-backlog"]
    assert preview["will_open_on"] == "board"
    assert preview["kept"] == [{"view": "risk", "hidden": True}]
    assert preview["change_count"] == 4
    assert _views(c.get(_url(p)).json())["schedule"]["visible"] is True  # dry run wrote nothing

    applied = c.post(
        _url(p, "apply-seed/"), {"lens": "scrum_master", "dry_run": False}, format="json"
    ).json()
    assert applied["applied"] is True
    after = c.get(_url(p)).json()
    assert _views(after)["schedule"]["source"] == "seed"
    assert _views(after)["risk"]["source"] == "user"
    assert after["lens_offer"] is None


def test_lens_offer_dismissal_persists(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "unified")
    c = _client(user)
    c.get(_url(p))
    UserProfile.objects.filter(user=user).update(role_context="pm")
    assert c.get(_url(p)).json()["lens_offer"] == "pm"
    data = c.patch(_url(p), {"lens_offer_dismissed": "pm"}, format="json").json()
    assert data["lens_offer"] is None


def test_seed_line_dismissal_and_last_layouts_persist(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master")
    c = _client(user)
    c.get(_url(p))
    data = c.patch(
        _url(p), {"seed_line_dismissed": True, "last_layouts": {"plan": "grid"}}, format="json"
    ).json()
    assert data["seed_line"] is None and data["last_layouts"] == {"plan": "grid"}


@pytest.mark.parametrize(
    "body",
    [{"key": "overview", "hidden": True}, {"key": "board"}, {}, {"last_layouts": {"x" * 40: "y"}}],
)
def test_invalid_patch_is_400(cal: Calendar, body: dict[str, Any]) -> None:
    p = _project(cal)
    user = _member(p)
    assert _client(user).patch(_url(p), body, format="json").status_code == 400


# --- ownership and membership -----------------------------------------------------------


@pytest.mark.parametrize("role", [Role.VIEWER, Role.MEMBER, Role.SCHEDULER, Role.ADMIN, Role.OWNER])
def test_every_member_role_manages_only_their_own_state(cal: Calendar, role: str) -> None:
    p = _project(cal)
    other = _member(p, "scrum_master", name="other")
    user = _member(p, "unified", role=role, name=f"me-{role}")
    c = _client(user)
    assert c.patch(_url(p), {"key": "risk", "hidden": True}, format="json").status_code == 200
    _client(other).get(_url(p))
    mine = ProjectViewState.objects.get(user=user, project=p)
    theirs = ProjectViewState.objects.get(user=other, project=p)
    assert [e["view"] for e in mine.hides] == ["risk"]
    assert "risk" not in {e["view"] for e in theirs.hides}


@pytest.mark.parametrize(
    ("method", "suffix"), [("get", ""), ("patch", ""), ("post", "apply-seed/"), ("post", "reset/")]
)
def test_non_member_is_refused(cal: Calendar, method: str, suffix: str) -> None:
    p = _project(cal)
    outsider = User.objects.create_user(username="outsider", password="pw")
    resp = getattr(_client(outsider), method)(_url(p, suffix), {"lens": "pm"}, format="json")
    assert resp.status_code in (403, 404)
    assert not ProjectViewState.objects.filter(user=outsider).exists()


def test_anonymous_is_refused(cal: Calendar) -> None:
    p = _project(cal)
    assert APIClient().get(_url(p)).status_code in (401, 403)


# --- hidden_views compatibility window -------------------------------------------------


def test_legacy_patch_fans_out_and_reads_back_user_hides_only(cal: Calendar) -> None:
    p1, p2 = _project(cal, name="one"), _project(cal, name="two")
    user = _member(p1, "scrum_master", name="legacy")
    ProjectMembership.objects.create(project=p2, user=user, role=Role.MEMBER)
    c = _client(user)
    c.get(_url(p1))  # seeds p1 (schedule, calendar, resources)
    resp = c.patch("/api/v1/auth/me/profile/", {"hidden_views": ["risk"]}, format="json")
    assert resp.status_code == 200
    assert resp.data["hidden_views"] == ["risk"]  # seeded hides are never reported
    assert resp["Deprecation"].startswith("@") and "GMT" in resp["Sunset"]
    for p in (p1, p2):
        assert _views(c.get(_url(p)).json())["risk"]["source"] == "user"
    assert _views(c.get(_url(p1)).json())["schedule"]["source"] == "seed"
    me = c.get("/api/v1/auth/me/")
    assert me.data["hidden_views"] == ["risk"] and "Sunset" in me
    # A later legacy write replaces the user set, as the global list did.
    c.patch("/api/v1/auth/me/profile/", {"hidden_views": []}, format="json")
    assert _views(c.get(_url(p2)).json())["risk"]["visible"] is True


def test_hidden_views_backfill_copies_user_hides_per_membership(cal: Calendar) -> None:
    p1, p2 = _project(cal, name="one"), _project(cal, name="two")
    user = User.objects.create_user(username="old", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["risk", "reports"], role_context="pm")
    for p in (p1, p2):
        ProjectMembership.objects.create(project=p, user=user, role=Role.MEMBER)
    backfill_project_view_states(django_apps, None)
    backfill_project_view_states(django_apps, None)  # idempotent
    assert ProjectViewState.objects.filter(user=user).count() == 2
    views = _views(_client(user).get(_url(p1)).json())
    assert views["risk"]["source"] == "user" and not views["risk"]["visible"]
    # Nothing re-seeded on top: pm would hide product-backlog.
    assert views["product-backlog"]["visible"] is True
