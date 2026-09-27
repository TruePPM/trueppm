"""FRONTEND_BASE_URL deploy check (#4188).

Every email builder that reads ``FRONTEND_BASE_URL`` degrades to prose instead of
a relative, unclickable link when it is empty (see ``workspace/tasks.py`` and
``notifications/tasks.py``). That fixes the broken *link*; it does not tell an
operator their invite/reset/notification emails have quietly lost their links in
the first place. This is the boot-time half: a Warning (not an Error, unlike
SECRET_KEY) surfaced on ``manage.py check --deploy``, since an empty value is a
legitimate zero-config default and must not refuse to start an otherwise-working
single-origin install.
"""

from __future__ import annotations

from django.core.checks import Warning as CheckWarning
from django.core.checks import registry

from trueppm_api.core.security_checks import (
    check_frontend_base_url,
    validate_frontend_base_url,
)


def test_empty_in_prod_warns() -> None:
    warnings = validate_frontend_base_url("", debug=False)

    assert len(warnings) == 1
    assert isinstance(warnings[0], CheckWarning)
    assert warnings[0].id == "trueppm.W001"


def test_none_in_prod_warns() -> None:
    """The live-settings entry point's ``getattr`` default is ``None``, not ``""``."""
    warnings = validate_frontend_base_url(None, debug=False)

    assert len(warnings) == 1
    assert warnings[0].id == "trueppm.W001"


def test_the_message_names_the_consequence_and_the_hint_names_the_lever() -> None:
    warning = validate_frontend_base_url("", debug=False)[0]

    assert "TRUEPPM_FRONTEND_BASE_URL" in str(warning.msg)
    assert "invite" in str(warning.hint).lower()
    assert "TRUEPPM_FRONTEND_BASE_URL" in str(warning.hint)


def test_configured_passes() -> None:
    assert validate_frontend_base_url("https://trueppm.example.com", debug=False) == []


def test_debug_is_exempt() -> None:
    """Dev workstations routinely run with no configured public origin."""
    assert validate_frontend_base_url("", debug=True) == []
    assert validate_frontend_base_url(None, debug=True) == []


def test_check_is_registered_as_a_deploy_check() -> None:
    assert check_frontend_base_url in registry.registry.get_checks(include_deployment_checks=True)
