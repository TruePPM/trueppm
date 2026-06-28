"""Tests for the seed_integration_fixtures management command (#1375).

Residual of #1350: the integration-fixtures seeder seeds real, loginable
accounts, so a fixed weak password must never reach a public (non-DEBUG)
instance. Resolution order mirrors ``seed_demo_project._resolve_demo_password``:
env var > DEBUG-only static default > generated token; the env secret is never
echoed; a destructive re-seed on a non-DEBUG instance with no password is
refused unless ``--force`` is passed.
"""

from __future__ import annotations

from io import StringIO

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.management.commands.seed_integration_fixtures import (
    _DEBUG_DEFAULT_PASSWORD,
    _EMAIL,
    INTEGRATION_PASSWORD_ENV,
    _resolve_integration_password,
)
from trueppm_api.apps.projects.models import Project, Task

User = get_user_model()


# ---------------------------------------------------------------------------
# Password resolution — pure function, no DB (#1375)
# ---------------------------------------------------------------------------


class TestIntegrationPasswordResolution:
    def test_env_var_is_used_verbatim(
        self, settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings.DEBUG = False  # type: ignore[attr-defined]
        monkeypatch.setenv(INTEGRATION_PASSWORD_ENV, "operator-chosen-secret")
        assert _resolve_integration_password() == ("operator-chosen-secret", "env")

    def test_env_var_wins_even_under_debug(
        self, settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings.DEBUG = True  # type: ignore[attr-defined]
        monkeypatch.setenv(INTEGRATION_PASSWORD_ENV, "operator-chosen-secret")
        assert _resolve_integration_password() == ("operator-chosen-secret", "env")

    def test_static_default_under_debug_when_no_env(
        self, settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings.DEBUG = True  # type: ignore[attr-defined]
        monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
        assert _resolve_integration_password() == (_DEBUG_DEFAULT_PASSWORD, "debug")

    def test_random_token_when_not_debug_and_no_env(
        self, settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        settings.DEBUG = False  # type: ignore[attr-defined]
        monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
        password, source = _resolve_integration_password()
        assert source == "generated"
        assert password != _DEBUG_DEFAULT_PASSWORD
        assert len(password) >= 16
        # Each invocation generates a fresh token.
        assert password != _resolve_integration_password()[0]


# ---------------------------------------------------------------------------
# Prod guard — refuse destructive re-seed without a real password (#1375)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_refuses_seed_off_debug_without_env_or_force(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
    with pytest.raises(CommandError, match="Refusing to seed integration fixtures"):
        call_command("seed_integration_fixtures")
    # Nothing was created — the guard fires before any write.
    assert not Project.objects.filter(name="CI Integration Project").exists()


@pytest.mark.django_db
def test_force_overrides_guard_with_generated_password(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
    call_command("seed_integration_fixtures", "--force")
    assert Project.objects.filter(name="CI Integration Project").exists()
    # The generated throwaway must not be the static default credential.
    assert User.objects.get(email=_EMAIL).check_password(_DEBUG_DEFAULT_PASSWORD) is False


# ---------------------------------------------------------------------------
# Seeded credential follows the resolver (#1375)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_seeded_user_password_is_static_default_under_debug(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.DEBUG = True  # type: ignore[attr-defined]
    monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
    call_command("seed_integration_fixtures")
    assert User.objects.get(email=_EMAIL).check_password(_DEBUG_DEFAULT_PASSWORD) is True


@pytest.mark.django_db
def test_seeded_user_password_honors_env_var(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.DEBUG = False  # type: ignore[attr-defined]
    monkeypatch.setenv(INTEGRATION_PASSWORD_ENV, "operator-chosen-secret")
    call_command("seed_integration_fixtures")
    assert User.objects.get(email=_EMAIL).check_password("operator-chosen-secret") is True


@pytest.mark.django_db
def test_env_var_password_is_not_echoed_to_stdout(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An operator/CI-supplied secret must not be re-emitted into stdout/logs (#1375)."""
    settings.DEBUG = False  # type: ignore[attr-defined]
    monkeypatch.setenv(INTEGRATION_PASSWORD_ENV, "operator-chosen-secret")
    out = StringIO()
    call_command("seed_integration_fixtures", stdout=out)
    output = out.getvalue()
    assert "operator-chosen-secret" not in output
    # The operator still gets a breadcrumb pointing at where the value came from.
    assert INTEGRATION_PASSWORD_ENV in output


@pytest.mark.django_db
def test_seed_is_idempotent_under_debug(
    settings: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.DEBUG = True  # type: ignore[attr-defined]
    monkeypatch.delenv(INTEGRATION_PASSWORD_ENV, raising=False)
    call_command("seed_integration_fixtures")
    call_command("seed_integration_fixtures")
    assert Project.objects.filter(name="CI Integration Project").count() == 1
    project = Project.objects.get(name="CI Integration Project")
    # Owner membership + one seed task survive a re-seed without duplicating.
    assert ProjectMembership.objects.filter(project=project, role=Role.OWNER).count() == 1
    assert Task.objects.filter(project=project, name="CI Seed Task").count() == 1
