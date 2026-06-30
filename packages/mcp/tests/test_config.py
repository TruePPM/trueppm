"""Configuration-resolution tests for :mod:`trueppm_mcp.config`."""

from __future__ import annotations

import pytest

from trueppm_mcp.config import ConfigError, Settings


def test_from_env_composes_api_base_url() -> None:
    settings = Settings.from_env(
        {"TRUEPPM_API_URL": "https://ppm.example.test", "TRUEPPM_API_TOKEN": "tppm_x"}
    )
    assert settings.api_base_url == "https://ppm.example.test/api/v1"


def test_from_env_is_idempotent_when_api_path_present() -> None:
    settings = Settings.from_env(
        {
            "TRUEPPM_API_URL": "https://ppm.example.test/api/v1",
            "TRUEPPM_API_TOKEN": "tppm_x",
        }
    )
    assert settings.api_base_url == "https://ppm.example.test/api/v1"


def test_from_env_strips_trailing_slash() -> None:
    settings = Settings.from_env(
        {"TRUEPPM_API_URL": "https://ppm.example.test/", "TRUEPPM_API_TOKEN": "tppm_x"}
    )
    assert settings.api_base_url == "https://ppm.example.test/api/v1"


def test_missing_url_raises() -> None:
    with pytest.raises(ConfigError, match="TRUEPPM_API_URL"):
        Settings.from_env({"TRUEPPM_API_TOKEN": "tppm_x"})


def test_missing_token_raises_without_echoing_value() -> None:
    with pytest.raises(ConfigError) as exc_info:
        Settings.from_env({"TRUEPPM_API_URL": "https://ppm.example.test"})
    # The error names the variable but cannot leak a value that was never set.
    assert "TRUEPPM_API_TOKEN" in str(exc_info.value)


def test_blank_token_raises() -> None:
    with pytest.raises(ConfigError, match="TRUEPPM_API_TOKEN"):
        Settings.from_env(
            {"TRUEPPM_API_URL": "https://ppm.example.test", "TRUEPPM_API_TOKEN": "   "}
        )
