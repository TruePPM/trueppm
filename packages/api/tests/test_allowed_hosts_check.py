"""Wildcard ALLOWED_HOSTS deploy check (#3515).

``ALLOWED_HOSTS`` is the only enforcement point Django applies to the host a
request claims — ``HttpRequest.get_host()`` validates its result before any view
runs, whichever header supplied it. A bare ``*`` disables that check, so the two
absolute URLs the API derives from the request (the OIDC ``redirect_uri``
fallback and the inbound Git-webhook URL an admin pastes into GitHub/GitLab)
follow whatever host the caller sent.

That makes this guard, not ``USE_X_FORWARDED_HOST``, the load-bearing control of
the pair: the forwarded-host setting only changes *which* header supplies the
value, and both candidates are bounded by this list.
"""

from __future__ import annotations

from django.core.checks import Error, registry

from trueppm_api.core.security_checks import check_allowed_hosts, validate_allowed_hosts


def test_bare_wildcard_is_refused() -> None:
    errors = validate_allowed_hosts(["*"], debug=False, allow_wildcard=False)

    assert len(errors) == 1
    assert isinstance(errors[0], Error)
    assert errors[0].id == "trueppm.E012"


def test_the_message_names_the_consequence_and_the_hint_names_the_lever() -> None:
    """A check whose text does not say what breaks teaches an operator nothing."""
    error = validate_allowed_hosts(["*"], debug=False, allow_wildcard=False)[0]

    assert "host validation" in str(error.msg)
    assert "TRUEPPM_ALLOW_WILDCARD_HOSTS" in str(error.hint)


def test_named_hosts_pass() -> None:
    assert (
        validate_allowed_hosts(
            ["trueppm.example.com", "trueppm-api", "localhost"],
            debug=False,
            allow_wildcard=False,
        )
        == []
    )


def test_wildcard_subdomain_passes() -> None:
    """'.example.com' constrains the host to a suffix the operator chose.

    Only the bare '*', which constrains nothing, is the failure this guard exists
    for — per-tenant-subdomain installs are a legitimate configuration.
    """
    assert validate_allowed_hosts([".example.com"], debug=False, allow_wildcard=False) == []


def test_wildcard_among_named_hosts_is_still_refused() -> None:
    """'*' short-circuits validation regardless of what else is listed."""
    errors = validate_allowed_hosts(["trueppm.example.com", "*"], debug=False, allow_wildcard=False)

    assert len(errors) == 1


def test_debug_is_exempt() -> None:
    """settings/dev.py sets ALLOWED_HOSTS=['*'] deliberately and is fenced already."""
    assert validate_allowed_hosts(["*"], debug=True, allow_wildcard=False) == []


def test_the_opt_out_clears_the_error() -> None:
    assert validate_allowed_hosts(["*"], debug=False, allow_wildcard=True) == []


def test_empty_and_missing_host_lists_are_not_this_check_s_business() -> None:
    """An empty ALLOWED_HOSTS is a different failure (every request 400s), and
    ``env.list`` already makes the variable required in prod."""
    assert validate_allowed_hosts([], debug=False, allow_wildcard=False) == []
    assert validate_allowed_hosts(None, debug=False, allow_wildcard=False) == []


def test_check_is_registered_as_a_deploy_check() -> None:
    assert check_allowed_hosts in registry.registry.get_checks(include_deployment_checks=True)
