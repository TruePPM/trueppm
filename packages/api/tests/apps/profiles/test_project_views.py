"""The server-resolved project view set (ADR-1478, #3715).

Covers precedence and ``source``/``binding``, first-resolve seeding and its fail-open
path, the never-empty rule, apply-seed/reset/Show all touching only seed entries, the
``hidden_views`` compatibility window, the ``hidden_views`` backfill, and ownership.
"""

from __future__ import annotations

import json
import re
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
from trueppm_api.apps.profiles import services
from trueppm_api.apps.profiles.backfill import backfill_project_view_states
from trueppm_api.apps.profiles.constants import (
    HIDEABLE_VIEW_KEYS,
    LENS_VIEW_SEEDS,
    METHODOLOGY_HIDDEN_VIEWS,
    METHODOLOGY_NEVER_HIDES,
    LensSeed,
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
    with mock.patch.object(ProjectViewState.objects, "create", side_effect=DatabaseError):
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


def test_a_list_stored_with_no_membership_survives_the_first_v2_open(cal: Calendar) -> None:
    """A list written before any project reaches the project joined later (G1, #3715)."""
    p = _project(cal)
    user = User.objects.create_user(username="early", password="pw")
    UserProfile.objects.create(user=user, role_context="scrum_master")
    c = _client(user)
    assert c.patch("/api/v1/auth/me/profile/", {"hidden_views": ["risk"]}, format="json").data[
        "hidden_views"
    ] == ["risk"]
    assert not ProjectViewState.objects.filter(user=user).exists()  # nothing to fan out to
    ProjectMembership.objects.create(project=p, user=user, role=Role.MEMBER)
    views = _views(c.get(_url(p)).json())
    assert views["risk"] == {**views["risk"], "visible": False, "source": "user"}
    assert views["resources"]["source"] == "seed"  # the lens seed still applies around it
    assert c.get("/api/v1/auth/me/").data["hidden_views"] == ["risk"]
    assert c.get("/api/v1/auth/me/profile/").data["hidden_views"] == ["risk"]


def test_a_stale_stored_list_does_not_flip_the_deprecated_read_on_a_later_project(
    cal: Calendar,
) -> None:
    """One v2 choice is not overridden by an older v1 list when another project opens."""
    a, b = _project(cal, name="A"), _project(cal, name="B")
    user = _member(a, "pm", name="stale")
    c = _client(user)
    c.patch("/api/v1/auth/me/profile/", {"hidden_views": ["risk"]}, format="json")
    c.get(_url(a))
    assert c.patch(_url(a), {"key": "risk", "hidden": False}, format="json").status_code == 200
    before = c.get("/api/v1/auth/me/").data["hidden_views"]
    ProjectMembership.objects.create(project=b, user=user, role=Role.MEMBER)
    views_b = _views(c.get(_url(b)).json())
    assert c.get("/api/v1/auth/me/").data["hidden_views"] == before
    assert views_b["risk"]["source"] != "user"


def _visit(user: Any, project: Project, when: str) -> None:
    from datetime import datetime

    from trueppm_api.apps.profiles.models import ProjectVisit

    ProjectVisit.objects.create(user=user, project=project, visited_at=datetime.fromisoformat(when))


def test_backfill_resolves_a_visited_project_of_an_empty_list_without_seeding(
    cal: Calendar,
) -> None:
    """Already opened before the upgrade → no seed and no offer (ADR-1478 §6.1, 2026-11-24)."""
    visited, joined_later = _project(cal, name="visited"), _project(cal, name="later")
    user = _member(visited, "scrum_master", name="veteran")
    ProjectMembership.objects.create(project=joined_later, user=user, role=Role.MEMBER)
    _visit(user, visited, "2026-10-01T09:00:00+00:00")
    backfill_project_view_states(django_apps, None)
    backfill_project_view_states(django_apps, None)  # idempotent
    state = ProjectViewState.objects.get(user=user, project=visited)
    assert (state.seeded_lens, state.hides) == ("scrum_master", [])
    c = _client(user)
    data = c.get(_url(visited)).json()
    assert _views(data)["schedule"]["visible"] is True
    assert data["lens_offer"] is None and data["seed_line"] is None
    # A visit recorded after the migration (here: no row at migration time) still seeds,
    # as does a project never opened.
    _visit(user, joined_later, "2026-12-01T09:00:00+00:00")
    later = c.get(_url(joined_later)).json()
    assert _views(later)["schedule"]["source"] == "seed"
    assert later["seed_line"] == {"lens": "scrum_master", "hidden_count": 3}


def test_backfill_resolves_a_visited_project_of_a_user_with_no_profile(cal: Calendar) -> None:
    p = _project(cal)
    user = User.objects.create_user(username="noprofile", password="pw")
    ProjectMembership.objects.create(project=p, user=user, role=Role.MEMBER)
    _visit(user, p, "2026-10-01T09:00:00+00:00")
    backfill_project_view_states(django_apps, None)
    state = ProjectViewState.objects.get(user=user, project=p)
    assert (state.seeded_lens, state.hides) == ("unified", [])


def test_backfill_leaves_non_member_visits_and_non_empty_lists_alone(cal: Calendar) -> None:
    p = _project(cal)
    gone = _member(p, "scrum_master", name="gone")
    _visit(gone, p, "2026-10-01T09:00:00+00:00")
    ProjectMembership.objects.filter(user=gone).update(is_deleted=True)
    listed = User.objects.create_user(username="listed", password="pw")
    UserProfile.objects.create(user=listed, hidden_views=["risk"], role_context="scrum_master")
    ProjectMembership.objects.create(project=p, user=listed, role=Role.MEMBER)
    _visit(listed, p, "2026-10-01T09:00:00+00:00")
    backfill_project_view_states(django_apps, None)
    assert not ProjectViewState.objects.filter(user=gone).exists()
    state = ProjectViewState.objects.get(user=listed, project=p)
    assert [e["view"] for e in state.hides] == ["risk"]  # the list pass, unchanged
    stale = _member(p, "scrum_master", name="stalekey")
    UserProfile.objects.update_or_create(
        user=stale, defaults={"hidden_views": ["retired-key"], "role_context": "scrum_master"}
    )
    _visit(stale, p, "2026-10-01T09:00:00+00:00")
    backfill_project_view_states(django_apps, None)
    row = ProjectViewState.objects.get(user=stale, project=p)
    assert (row.seeded_lens, row.hides) == ("scrum_master", [])


def test_last_layouts_stay_bounded_across_requests(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p)
    c = _client(user)
    for batch in range(5):
        body = {"last_layouts": {f"t{batch}-{i}": "grid" for i in range(8)}}
        assert c.patch(_url(p), body, format="json").status_code == 200
    layouts = ProjectViewState.objects.get(user=user, project=p).last_layouts
    assert len(layouts) == 16 and "t4-7" in layouts and "t0-0" not in layouts


def test_agent_read_reports_the_seed_without_writing_it(cal: Calendar) -> None:
    """An ``mcp:read`` agent asking "why can't I see Sprints?" must not seed the row.

    Seeding is permanent, so an agent's first read would otherwise freeze the user's seed
    at whatever lens they held then, and a read-scoped credential would be writing.
    """
    from trueppm_api.apps.profiles import services

    p = _project(cal, "HYBRID")
    user = _member(p, "scrum_master")
    preview = services.resolve_project_views(user, p, persist=False)
    assert {v.key for v in preview.views if v.source == "seed"} == {
        "schedule",
        "calendar",
        "resources",
    }
    assert not ProjectViewState.objects.filter(user=user, project=p).exists()

    with mock.patch("trueppm_api.apps.profiles.views.is_agent_token", return_value=True):
        data = _client(user).get(_url(p)).json()
    assert data["seed_line"] == {"lens": "scrum_master", "hidden_count": 3}
    assert not ProjectViewState.objects.filter(user=user, project=p).exists()

    # The web's own first read still seeds, and the agent then reads the stored row.
    _client(user).get(_url(p))
    assert ProjectViewState.objects.filter(user=user, project=p).count() == 1
    with mock.patch("trueppm_api.apps.profiles.views.is_agent_token", return_value=True):
        assert _client(user).get(_url(p)).json()["seeded_lens"] == "scrum_master"


# --- the lens offer appears only after a lens change, once (AC 6) -----------------------


def test_empty_seed_offers_nothing_on_first_open_or_after_a_no_op_apply(cal: Calendar) -> None:
    """A pm on Waterfall seeds nothing (methodology already hides product-backlog).

    The row still records the lens it was resolved under, so there is no offer to
    apply the very lens the user holds, and a zero-change apply cannot leave one.
    """
    p = _project(cal, "WATERFALL")
    user = _member(p, "pm")
    c = _client(user)
    first = c.get(_url(p)).json()
    assert first["lens_offer"] is None and first["seed_line"] is None
    assert first["seeded_lens"] is None
    assert ProjectViewState.objects.get(user=user, project=p).seeded_lens == "pm"
    diff = services.apply_lens_seed(user, p, "pm", dry_run=False)
    assert diff["change_count"] == 0
    assert c.get(_url(p)).json()["lens_offer"] is None


def test_zero_change_apply_after_a_lens_change_clears_the_offer(cal: Calendar) -> None:
    p = _project(cal, "WATERFALL")
    user = _member(p, "unified")
    c = _client(user)
    c.get(_url(p))
    UserProfile.objects.filter(user=user).update(role_context="pm")
    assert c.get(_url(p)).json()["lens_offer"] == "pm"
    applied = c.post(_url(p, "apply-seed/"), {"lens": "pm", "dry_run": False}, format="json")
    assert applied.json()["change_count"] == 0
    assert c.get(_url(p)).json()["lens_offer"] is None


def test_lens_change_with_a_diff_offers_once_and_clears_after_apply(cal: Calendar) -> None:
    p = _project(cal, "HYBRID")
    user = _member(p, "pm")
    c = _client(user)
    assert c.get(_url(p)).json()["lens_offer"] is None
    UserProfile.objects.filter(user=user).update(role_context="scrum_master")
    assert c.get(_url(p)).json()["lens_offer"] == "scrum_master"
    applied = c.post(
        _url(p, "apply-seed/"), {"lens": "scrum_master", "dry_run": False}, format="json"
    ).json()
    assert applied["change_count"] > 0
    for _ in range(2):
        assert c.get(_url(p)).json()["lens_offer"] is None


def test_backfilled_row_offers_nothing_until_the_lens_changes(cal: Calendar) -> None:
    p = _project(cal)
    user = User.objects.create_user(username="migrated", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["risk"], role_context="pm")
    ProjectMembership.objects.create(project=p, user=user, role=Role.MEMBER)
    backfill_project_view_states(django_apps, None)
    assert ProjectViewState.objects.get(user=user, project=p).seeded_lens == "pm"
    c = _client(user)
    data = c.get(_url(p)).json()
    assert data["lens_offer"] is None and data["seed_line"] is None
    assert _views(data)["product-backlog"]["visible"] is True  # still not re-seeded
    UserProfile.objects.filter(user=user).update(role_context="scrum_master")
    assert c.get(_url(p)).json()["lens_offer"] == "scrum_master"


# --- a legacy fan-out does not pre-empt the first-open seed (migration item 2) ----------


def test_fan_out_of_an_empty_list_still_seeds_the_first_open(cal: Calendar) -> None:
    p1, p2 = _project(cal, name="one"), _project(cal, name="two")
    user = _member(p1, "scrum_master", name="fan")
    ProjectMembership.objects.create(project=p2, user=user, role=Role.MEMBER)
    services.fan_out_hidden_views(user, [])
    assert ProjectViewState.objects.get(user=user, project=p2).seeded_lens == ""
    data = _client(user).get(_url(p2)).json()
    assert {k for k, v in _views(data).items() if v["source"] == "seed"} == {
        "schedule",
        "calendar",
        "resources",
    }
    assert data["seed_line"] == {"lens": "scrum_master", "hidden_count": 3}
    assert data["lens_offer"] is None


def test_fan_out_hides_survive_the_first_open_seed(cal: Calendar) -> None:
    """No user loses or regains a view: their own entries win over the seed."""
    p = _project(cal)
    user = _member(p, "scrum_master", name="keeps")
    c = _client(user)
    resp = c.patch("/api/v1/auth/me/profile/", {"hidden_views": ["risk", "grid"]}, format="json")
    assert resp.status_code == 200
    views = _views(c.get(_url(p)).json())
    assert views["risk"] == {**views["risk"], "visible": False, "source": "user"}
    assert views["grid"] == {**views["grid"], "visible": False, "source": "user"}
    assert views["resources"]["source"] == "seed"
    # Seed + user would empty Plan, so Schedule falls back rather than vanishing.
    assert views["schedule"] == {**views["schedule"], "visible": True, "source": "always"}
    assert c.get("/api/v1/auth/me/profile/").data["hidden_views"] == ["grid", "risk"]


def test_fan_out_reaches_a_row_a_concurrent_first_open_created(cal: Calendar) -> None:
    """A resolve that creates the row just before the fan-out's insert keeps the hides."""
    p = _project(cal)
    user = _member(p, "scrum_master", name="race")
    manager_cls = type(ProjectViewState.objects)
    original = manager_cls.bulk_create

    def racing_bulk_create(self: Any, objs: Any, *args: Any, **kwargs: Any) -> Any:
        services.resolve_project_views(user, p)  # the other request's first open
        return original(self, objs, *args, **kwargs)

    with mock.patch.object(manager_cls, "bulk_create", racing_bulk_create):
        services.fan_out_hidden_views(user, ["risk"])
    views = _views(_client(user).get(_url(p)).json())
    assert views["risk"] == {**views["risk"], "visible": False, "source": "user"}
    assert views["resources"]["source"] == "seed"  # the racing seed is kept around it


def test_show_all_on_a_fanned_out_row_does_not_reseed_later(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master", name="showall")
    services.fan_out_hidden_views(user, ["risk"])
    c = _client(user)
    c.patch(_url(p), {"clear_seed": True}, format="json")
    views = _views(c.get(_url(p)).json())
    assert not any(v["source"] == "seed" for v in views.values())
    assert views["risk"]["source"] == "user"


def test_agent_read_of_a_fanned_out_row_previews_the_seed_without_writing(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, "scrum_master", name="agentfan")
    services.fan_out_hidden_views(user, [])
    preview = services.resolve_project_views(user, p, persist=False)
    assert {v.key for v in preview.views if v.source == "seed"} == {
        "schedule",
        "calendar",
        "resources",
    }
    assert ProjectViewState.objects.get(user=user, project=p).seeded_lens == ""


# --- legacy writes, registry drift, deprecation headers -------------------------------


def test_legacy_write_hiding_every_plan_layout_is_accepted_and_v2_keeps_schedule(
    cal: Calendar,
) -> None:
    """The v1 shell may hide Schedule, Grid and Calendar (separate tabs there).

    ADR-1478 §6.2 keeps that write working unchanged, so it is not refused with
    ``last_plan_layout``; the v2 resolver shows Schedule with ``source: always``.
    """
    p = _project(cal)
    user = _member(p, "unified", name="allplan")
    c = _client(user)
    body = {"hidden_views": ["schedule", "grid", "calendar"]}
    assert c.patch("/api/v1/auth/me/profile/", body, format="json").status_code == 200
    views = _views(c.get(_url(p)).json())
    assert views["schedule"] == {**views["schedule"], "visible": True, "source": "always"}


def test_a_retired_or_always_on_seed_key_is_ignored_and_logged(
    cal: Calendar, caplog: pytest.LogCaptureFixture
) -> None:
    p = _project(cal)
    user = _member(p, "pm", name="drift")
    seeds = {
        **LENS_VIEW_SEEDS,
        "pm": LensSeed(hide=frozenset({"risk", "overview", "retired-view"}), landing={}),
    }
    with mock.patch.dict(services.LENS_VIEW_SEEDS, seeds), caplog.at_level("WARNING"):
        data = _client(user).get(_url(p)).json()
    assert {k for k, v in _views(data).items() if v["source"] == "seed"} == {"risk"}
    assert _views(data)["overview"]["source"] == "always"
    logged = " ".join(r.getMessage() for r in caplog.records)
    assert "'overview'" in logged and "'retired-view'" in logged


def test_profile_get_carries_the_deprecation_and_sunset_headers(cal: Calendar) -> None:
    p = _project(cal)
    user = _member(p, name="sunset")
    resp = _client(user).get("/api/v1/auth/me/profile/")
    assert resp.status_code == 200
    assert resp["Deprecation"].startswith("@")
    assert resp["Sunset"].endswith("GMT")
    # The Link target is a real published page and a real heading on it.
    link = resp["Link"]
    assert 'rel="deprecation"' in link
    path, _, anchor = link.split("https://docs.trueppm.com/", 1)[1].split(">", 1)[0].partition("#")
    docs = Path(__file__).resolve().parents[4] / "website" / "src" / "content" / "docs"
    page = docs / f"{path.strip('/')}.md"
    assert page.is_file(), page
    slugs = {
        re.sub(r"[^a-z0-9 -]", "", line.lstrip("#").strip().lower()).replace(" ", "-")
        for line in page.read_text().splitlines()
        if line.startswith("#")
    }
    assert anchor in slugs
