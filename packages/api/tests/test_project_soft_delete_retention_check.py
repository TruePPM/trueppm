"""Tests for the soft-delete retention guard (#3186).

The chart's own ``values.yaml`` comment told operators to set
``TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS`` to ``"0"`` "to keep the default".
``env.int`` parses that as the number zero, which puts the purge cutoff at the
present moment — so the next ``retention.run_purge`` tick hard-deletes every
trashed project and all of its children via CASCADE, irreversibly.

Mirrors the SECRET_KEY and attachment-storage guards: a pure
``validate_project_soft_delete_retention`` function with two callers — the Django
system-check registry and an import-time guard in ``settings/prod.py``.
"""

from __future__ import annotations

import pytest
from django.core.checks import Error, registry

from trueppm_api.core.security_checks import (
    check_project_soft_delete_retention,
    validate_project_soft_delete_retention,
)


def test_zero_is_rejected() -> None:
    """0 is the value that destroys the trash, and the one the comment taught."""
    errors = validate_project_soft_delete_retention(0)
    assert len(errors) == 1
    assert isinstance(errors[0], Error)
    assert errors[0].id == "trueppm.E010"


def test_zero_error_names_the_consequence_not_just_the_rule() -> None:
    """An operator who hits this must learn what 0 does, not that it is invalid."""
    (error,) = validate_project_soft_delete_retention(0)
    assert "hard-deletes" in str(error.msg)
    # The hint must point at the real disable lever, which is NOT this variable.
    assert "System Health" in str(error.hint)


def test_the_default_is_accepted() -> None:
    assert validate_project_soft_delete_retention(30) == []


@pytest.mark.parametrize("value", [1, 7, 30, 90, 3650])
def test_positive_windows_are_accepted(value: int) -> None:
    assert validate_project_soft_delete_retention(value) == []


def test_none_is_accepted_because_it_means_disabled() -> None:
    """``resolve_retention`` returns None for a policy row with enabled=False,
    and ``run_purge`` short-circuits on it. That is the supported way to turn the
    purge off, so the guard must not reject it."""
    assert validate_project_soft_delete_retention(None) == []


def test_check_is_registered_with_the_django_registry() -> None:
    """The guard is registered as well as called at import — the registry is what
    `manage.py check --deploy` exercises."""
    assert check_project_soft_delete_retention in registry.registry.get_checks(
        include_deployment_checks=True
    )


def test_registered_check_reads_the_live_setting(settings) -> None:
    settings.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS = 0
    errors = check_project_soft_delete_retention()
    assert [e.id for e in errors] == ["trueppm.E010"]

    settings.TRUEPPM_PROJECT_SOFT_DELETE_RETENTION_DAYS = 30
    assert check_project_soft_delete_retention() == []
