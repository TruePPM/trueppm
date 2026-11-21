"""Project creation seeds the creator's starter rail (#3713)."""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.profiles.constants import HIDEABLE_VIEW_KEYS
from trueppm_api.apps.profiles.models import UserProfile
from trueppm_api.apps.profiles.services import SEED_HIDDEN_VIEWS
from trueppm_api.apps.projects.models import Calendar, Program, Project

User = get_user_model()


def _client(user: object) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _create(user: object, cal: Calendar, **extra: object) -> object:
    res = _client(user).post(
        "/api/v1/projects/",
        {"name": "P", "start_date": date(2026, 9, 1).isoformat(), "calendar": str(cal.pk), **extra},
        format="json",
    )
    assert res.status_code == 201, res.data
    return res


def _hidden(user: object) -> list[str]:
    profile = UserProfile.objects.filter(user=user).first()
    return list(profile.hidden_views) if profile else []


@pytest.fixture
def cal(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def test_seed_sets_only_use_hideable_keys_and_are_narrow() -> None:
    for methodology, keys in SEED_HIDDEN_VIEWS.items():
        assert set(keys) <= HIDEABLE_VIEW_KEYS, methodology
        assert "overview" not in keys and "settings" not in keys
        assert len(keys) == len(set(keys))
    # Hybrid starts at ~6 visible of 14.
    assert 14 - len(SEED_HIDDEN_VIEWS["HYBRID"]) == 6


@pytest.mark.django_db
@pytest.mark.parametrize("methodology", ["HYBRID", "WATERFALL", "AGILE"])
def test_first_project_seeds_hidden_views_from_chosen_methodology(
    cal: Calendar, methodology: str
) -> None:
    user = User.objects.create_user(username=f"u-{methodology}", password="pw")
    _create(user, cal, methodology=methodology)
    assert _hidden(user) == sorted(SEED_HIDDEN_VIEWS[methodology])


@pytest.mark.django_db
def test_second_project_does_not_reseed(cal: Calendar) -> None:
    user = User.objects.create_user(username="second", password="pw")
    _create(user, cal, methodology="HYBRID")
    UserProfile.objects.filter(user=user).update(hidden_views=[])  # user un-hid everything
    _create(user, cal, methodology="AGILE")
    assert _hidden(user) == []


@pytest.mark.django_db
def test_existing_customization_is_never_overwritten(cal: Calendar) -> None:
    user = User.objects.create_user(username="custom", password="pw")
    UserProfile.objects.create(user=user, hidden_views=["risk"])
    _create(user, cal, methodology="HYBRID")
    assert _hidden(user) == ["risk"]


@pytest.mark.django_db
def test_omitted_methodology_seeds_the_hybrid_set(cal: Calendar) -> None:
    user = User.objects.create_user(username="omitted", password="pw")
    _create(user, cal)
    assert _hidden(user) == sorted(SEED_HIDDEN_VIEWS["HYBRID"])


@pytest.mark.django_db
def test_existing_project_membership_blocks_the_seed(cal: Calendar) -> None:
    user = User.objects.create_user(username="member", password="pw")
    other = Project.objects.create(name="Other", start_date=date(2026, 9, 1), calendar=cal)
    ProjectMembership.objects.create(project=other, user=user, role=Role.MEMBER)
    _create(user, cal, methodology="HYBRID")
    assert _hidden(user) == []


@pytest.mark.django_db
def test_existing_program_membership_blocks_the_seed(cal: Calendar) -> None:
    user = User.objects.create_user(username="progmember", password="pw")
    program = Program.objects.create(name="Prog")
    ProgramMembership.objects.create(program=program, user=user, role=Role.MEMBER)
    _create(user, cal, methodology="HYBRID")
    assert _hidden(user) == []
