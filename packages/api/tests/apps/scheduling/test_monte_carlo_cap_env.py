"""#4652: the Monte Carlo run/task caps are environment-driven, not code constants."""

from __future__ import annotations

import pytest
from django.core.exceptions import ImproperlyConfigured

from trueppm_api.settings.base import _optional_cap


class TestOptionalCap:
    def test_default_when_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TRUEPPM_MC_TASK_CAP", raising=False)
        assert _optional_cap("TRUEPPM_MC_TASK_CAP", 5_000) == 5_000

    def test_env_raises_the_cap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TRUEPPM_MC_SIMULATION_CAP", "5000")
        assert _optional_cap("TRUEPPM_MC_SIMULATION_CAP", 1_000) == 5_000

    @pytest.mark.parametrize("raw", ["", "0", "  "])
    def test_empty_or_zero_removes_the_cap(self, monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
        monkeypatch.setenv("TRUEPPM_MC_TASK_CAP", raw)
        assert _optional_cap("TRUEPPM_MC_TASK_CAP", 5_000) is None

    def test_negative_fails_loud(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TRUEPPM_MC_TASK_CAP", "-1")
        with pytest.raises(ImproperlyConfigured):
            _optional_cap("TRUEPPM_MC_TASK_CAP", 5_000)
