"""The server half of the SSO error-code cross-language contract (#3951).

``contracts/sso-error-codes.json`` is the single checked-in vocabulary both editions
of the SSO callback error taxonomy assert against: this module for the codes
derived from ``services.OIDCError``'s subclass hierarchy plus the literal
``error="..."`` redirects in ``views.py``, and
``packages/web/src/features/auth/SsoCompletePage.errorCodes.test.tsx`` for the
web's authored ``ERROR_COPY`` keys. Drift therefore fails a pipeline in whichever
language introduces it, instead of degrading silently in production — which is
exactly what happened before: four backend codes fell through to generic copy for
months (#2876) with nothing to catch it.

Also pins ``services.OIDC_SCOPES`` / ``GITHUB_SCOPES`` against
``contracts/sso-scopes.json`` — see that file's header and
``packages/web/src/features/auth/ssoScopesContract.test.ts`` for the web half.
"""

from __future__ import annotations

import inspect
import json
import re
from pathlib import Path
from typing import Any

from trueppm_api.apps.sso import services, views


def _repo_root() -> Path:
    """Walk up to THIS checkout's root rather than counting ``parents[N]``.

    Anchored on a repo marker (``.git``, a file in a git worktree and a directory in
    a normal checkout), not merely on finding a ``contracts/`` directory — an
    unanchored probe that misses the in-repo copy would keep climbing into the CI
    build dir, ``$HOME`` and ``/``, where a stray ``contracts/sso-error-codes.json``
    could be silently adopted and the drift gate would pass while validating a
    vocabulary from outside the repo.
    """
    for candidate in Path(__file__).resolve().parents:
        if not (candidate / ".git").exists():
            continue
        return candidate
    raise AssertionError(f"No checkout root (a directory containing .git) found above {__file__}.")


def _contract(name: str) -> dict[str, Any]:
    path = _repo_root() / "contracts" / name
    if not path.is_file():
        raise AssertionError(
            f"contracts/{name} is missing (#3951). If you just created it, `git add` it."
        )
    result: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return result


def _error_codes_contract() -> dict[str, list[str]]:
    return _contract("sso-error-codes.json")


def _scopes_contract() -> dict[str, list[str]]:
    return _contract("sso-scopes.json")


# ---------------------------------------------------------------------------
# Deriving the backend's actual error-code set
# ---------------------------------------------------------------------------


def _subclass_error_codes() -> set[str]:
    """Every ``code`` an ``OIDCError`` subclass can carry.

    Walking ``__subclasses__()`` (rather than hand-listing the classes) means a new
    subclass is picked up automatically the moment it exists — the exact drift this
    contract exists to catch. A subclass that does NOT override ``code`` inherits
    the base class's ``"oidc_error"``, which is indistinguishable here from the base
    class itself; that is intentional, since an unmapped code and an
    intentionally-generic one both reduce to the same fallback behavior.
    """
    return {cls.code for cls in services.OIDCError.__subclasses__()}


# Matches `error="..."` — the view-level literal redirects that are NOT raised as an
# OIDCError (e.g. the IdP's own `?error=` passthrough, a missing code/state). Deliberately
# excludes `error=exc.code` (no quotes: that's an OIDCError, already covered above) and
# `error=error` (the bare parameter passthrough is the redirect *helper*, not a literal).
_VIEW_LITERAL_ERROR_RE = re.compile(r'error="([a-z_]+)"')


def _view_literal_error_codes() -> set[str]:
    """Every code a bare ``self._redirect(error="...")`` / ``_spa_completion_url(error="...")``
    call in ``views.py`` can produce — the codes that are never raised as an
    :class:`~trueppm_api.apps.sso.services.OIDCError` at all (the IdP-denied and
    malformed-request short-circuits that fire before an ``OIDCError`` could be raised).

    Read from source rather than hand-listed so a new literal redirect added later is
    picked up automatically instead of requiring someone to remember this test exists.
    """
    source = Path(inspect.getfile(views)).read_text(encoding="utf-8")
    found = set(_VIEW_LITERAL_ERROR_RE.findall(source))
    assert found, (
        'the error="..." regex found nothing in sso/views.py — it likely no longer '
        "matches the source after a refactor; update _VIEW_LITERAL_ERROR_RE (#3951)."
    )
    return found


def _all_backend_error_codes() -> set[str]:
    return _subclass_error_codes() | _view_literal_error_codes() | {services.OIDCError.code}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_derived_backend_error_codes_match_the_contract() -> None:
    """The full backend error-code set is exactly `mapped` + `genericFallback`.

    This is the gate: add a tenth ``OIDCError`` subclass (or a bare
    ``raise OIDCError(...)``) with a code nobody added to the contract, and this
    fails here — instead of silently rendering the generic "Something went wrong"
    in production, which is exactly what happened to four codes for months (#2876).
    """
    contract = _error_codes_contract()
    expected = set(contract["mapped"]) | set(contract["genericFallback"])
    actual = _all_backend_error_codes()
    assert actual == expected, (
        "The backend's actual SSO error-code set has drifted from "
        "contracts/sso-error-codes.json. New codes not in the contract: "
        f"{sorted(actual - expected)}; contract codes the backend no longer "
        f"produces: {sorted(expected - actual)}. For a genuinely new code, decide "
        "whether it gets real ERROR_COPY (add to `mapped` here AND to "
        "SsoCompletePage.tsx) or is an intentional generic fallback (add to "
        "`genericFallback`)."
    )


def test_mapped_and_generic_fallback_are_disjoint_and_deduplicated() -> None:
    contract = _error_codes_contract()
    mapped, generic = contract["mapped"], contract["genericFallback"]
    assert len(mapped) == len(set(mapped)), "duplicate entries in contract 'mapped'"
    assert len(generic) == len(set(generic)), "duplicate entries in contract 'genericFallback'"
    assert not (set(mapped) & set(generic)), (
        f"{sorted(set(mapped) & set(generic))} are declared both mapped and a generic "
        "fallback — a code needs exactly one treatment."
    )


def test_oidc_error_is_the_only_generic_fallback() -> None:
    """States the #3951 decision explicitly: `oidc_error` is documented, not silent.

    If this ever fails because `genericFallback` grew a second entry, that is a new
    deliberate choice to record here, not a bug in this test.
    """
    contract = _error_codes_contract()
    assert contract["genericFallback"] == ["oidc_error"]


def test_view_literal_regex_still_finds_every_known_view_level_code() -> None:
    """Guards the regex itself: a formatting change in views.py that silently stops
    matching would make ``test_derived_backend_error_codes_match_the_contract`` pass
    vacuously (an emptied-out ``actual`` set trivially failing loud instead — but this
    pins the *content*, not just non-emptiness).
    """
    found = _view_literal_error_codes()
    assert {"access_denied", "invalid_request", "invalid_state", "sso_not_configured"} <= found


# ---------------------------------------------------------------------------
# Scopes pin (ADR-0517 §3.4) — same test pass, per #3951's "related unpinned
# duplication" note. SsoProviderPanel.tsx is NOT touched by this issue (#3950 owns
# it); the web half lives in a new file, ssoScopesContract.test.ts.
# ---------------------------------------------------------------------------


def test_server_fixed_scopes_match_the_contract() -> None:
    contract = _scopes_contract()
    assert contract["oidc"] == services.OIDC_SCOPES, (
        "services.OIDC_SCOPES has drifted from contracts/sso-scopes.json. The admin "
        "panel's Add-mode display (SsoProviderPanel.tsx) hardcodes the same list and "
        "would now be showing a lie."
    )
    assert contract["github"] == services.GITHUB_SCOPES, (
        "services.GITHUB_SCOPES has drifted from contracts/sso-scopes.json. The admin "
        "panel's Add-mode display (SsoProviderPanel.tsx) hardcodes the same list and "
        "would now be showing a lie."
    )
