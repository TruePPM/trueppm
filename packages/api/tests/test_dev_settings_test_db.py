"""Tests for trueppm_api.settings.dev._apply_test_db_name (#1605).

`scripts/wt new` writes TRUEPPM_TEST_DB=test_trueppm_wt_<slug> into each
worktree's .envrc so N parallel `pytest` runs each build an isolated test
database instead of racing on the shared `test_trueppm`. The helper is
pure/env-injected so it is unit-testable without reloading the settings module.
"""

from __future__ import annotations

from trueppm_api.settings.dev import _apply_test_db_name


def test_env_var_sets_test_db_name() -> None:
    """TRUEPPM_TEST_DB in the env points TEST['NAME'] at the per-worktree DB."""
    databases: dict[str, dict] = {"default": {}}
    _apply_test_db_name(databases, {"TRUEPPM_TEST_DB": "test_trueppm_wt_1605"})
    assert databases["default"]["TEST"]["NAME"] == "test_trueppm_wt_1605"


def test_existing_test_dict_is_preserved() -> None:
    """An existing TEST sub-dict (e.g. TEMPLATE) survives — only NAME is added."""
    databases: dict[str, dict] = {"default": {"TEST": {"TEMPLATE": "migrated", "MIGRATE": False}}}
    _apply_test_db_name(databases, {"TRUEPPM_TEST_DB": "test_trueppm_wt_x"})
    assert databases["default"]["TEST"] == {
        "TEMPLATE": "migrated",
        "MIGRATE": False,
        "NAME": "test_trueppm_wt_x",
    }


def test_unset_env_var_is_noop() -> None:
    """No TRUEPPM_TEST_DB leaves DATABASES untouched (shared-DB default)."""
    databases: dict[str, dict] = {"default": {}}
    _apply_test_db_name(databases, {})
    assert "TEST" not in databases["default"]


def test_empty_env_var_is_noop() -> None:
    """An empty TRUEPPM_TEST_DB does not override the test DB name."""
    databases: dict[str, dict] = {"default": {}}
    _apply_test_db_name(databases, {"TRUEPPM_TEST_DB": ""})
    assert "TEST" not in databases["default"]
