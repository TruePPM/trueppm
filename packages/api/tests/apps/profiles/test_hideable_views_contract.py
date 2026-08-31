"""The server half of the cross-language nav-vocabulary contract (ADR-0942 §6).

``contracts/hideable-views.json`` is the single checked-in vocabulary both editions of
the nav customization list assert against: this module for
``apps.profiles.constants.HIDEABLE_VIEW_KEYS``, and
``packages/web/src/features/shell/methodologyTabs.test.ts`` for the web's authored
``HIDEABLE_VIEW_KEYS`` / ``ALWAYS_ON_VIEW_KEYS``. Drift therefore fails a pipeline in
whichever language introduces it.

Why this exists at all. Until ADR-0942 the web derived its hideable set from band
membership (``VIEW_GROUPS.flatMap(g => g.views)``) and this module asked, in prose, that
the two lists be kept in sync. Prose is what let the derivation happen: it made
``overview`` and ``settings`` unhideable only as a side effect of standing outside every
band. ADR-0942 puts both *inside* bands, at which point the derivation would silently
have made them hideable, the client would have PATCHed a key this set rejects, and the
guarantee that a user's nav can never be emptied would be gone — surfacing to the user as
a 400 from a toggle the UI offered them.

No test can prove the vocabulary is *right*. What these assert is that there is exactly
one answer to "which views are hideable", and that adding a view to a band cannot change
it by accident.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.profiles.constants import HIDEABLE_VIEW_KEYS
from trueppm_api.apps.profiles.models import UserProfile

User = get_user_model()
URL = "/api/v1/auth/me/profile/"


def _repo_root() -> Path:
    """Walk up to THIS checkout's root rather than counting ``parents[N]``.

    A hard-coded index breaks the moment the tests tree is reorganized, and it breaks
    with a ``FileNotFoundError`` that names the contract file — pointing the reader at
    the wrong thing entirely.

    The walk is anchored on a repo marker (``.git``, which is a *file* in a git
    worktree and a directory in a normal checkout) and not merely on finding a
    ``contracts/`` directory. Anchoring matters: an unanchored probe that misses the
    in-repo copy keeps climbing into the CI build dir, ``$HOME`` and ``/``, and a stray
    ``contracts/hideable-views.json`` anywhere above would be silently adopted — the
    drift gate would then pass while validating a vocabulary from outside the repo.
    Stopping at the checkout root makes a missing contract a loud failure instead.
    """
    for candidate in Path(__file__).resolve().parents:
        if not (candidate / ".git").exists():
            continue
        contract = candidate / "contracts" / "hideable-views.json"
        if contract.is_file():
            return candidate
        raise AssertionError(
            f"Found the checkout root at {candidate} but no contracts/"
            f"hideable-views.json in it — the cross-language nav vocabulary contract "
            f"is missing (ADR-0942 §6). If you just created it, `git add` it."
        )
    raise AssertionError(f"No checkout root (a directory containing .git) found above {__file__}.")


def _contract() -> dict[str, list[str]]:
    path = _repo_root() / "contracts" / "hideable-views.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_server_hideable_set_matches_the_contract() -> None:
    """``constants.HIDEABLE_VIEW_KEYS`` is exactly the contract's ``hideable`` list."""
    contract = _contract()
    expected = set(contract["hideable"])
    assert expected == HIDEABLE_VIEW_KEYS, (
        "profiles/constants.py HIDEABLE_VIEW_KEYS has drifted from "
        "contracts/hideable-views.json. Missing here: "
        f"{sorted(expected - HIDEABLE_VIEW_KEYS)}; extra here: "
        f"{sorted(HIDEABLE_VIEW_KEYS - expected)}. Adding a hideable view means editing "
        "the contract, this set, and the web's authored HIDEABLE_VIEW_KEYS."
    )


def test_always_on_keys_are_rejected_by_the_server_vocabulary() -> None:
    """The contract's ``alwaysOn`` keys are absent here — the two sets are disjoint.

    This is the invariant the 400 in ``validate_hidden_views`` enforces at runtime, and
    the one that guarantees a user's nav can never be emptied (ADR-0030/0139).
    """
    contract = _contract()
    always_on = set(contract["alwaysOn"])
    assert always_on, "the contract's alwaysOn list must not be empty"
    assert not (always_on & HIDEABLE_VIEW_KEYS), (
        f"{sorted(always_on & HIDEABLE_VIEW_KEYS)} are declared always-on but are also "
        "hideable — a user could hide them and empty their own nav."
    )


def test_contract_lists_are_deduplicated() -> None:
    """A duplicate would make the set comparison above pass while the file misleads."""
    contract = _contract()
    for key in ("hideable", "alwaysOn"):
        values = contract[key]
        assert len(values) == len(set(values)), f"duplicate entries in contract '{key}'"


@pytest.mark.django_db
def test_the_whole_client_hideable_set_round_trips_through_the_endpoint() -> None:
    """Every key the web offers as a toggle is actually writable — end to end.

    Set equality against the contract (above) proves the three *lists* agree. It does
    not prove the endpoint accepts them: `validate_hidden_views` is what a real client
    hits, and a `max_length` bound or a serializer change could reject a key the
    constant still contains. This PATCHes the entire hideable vocabulary in one body,
    which is also the widest payload the UI can generate (hide everything), so it
    doubles as the bound check on `ListField(max_length=32)`.

    Why it matters here specifically: ADR-0942 decoupled hideability from band
    membership, so the client list is now authored rather than derived. An authored
    list can drift into a key the server refuses, and the failure mode is a 400 raised
    by a toggle the UI itself offered the user.
    """
    contract = _contract()
    user = User.objects.create_user(username="hv_roundtrip", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.patch(URL, {"hidden_views": contract["hideable"]}, format="json")

    assert resp.status_code == 200, resp.data
    assert sorted(resp.data["hidden_views"]) == sorted(contract["hideable"])
    assert sorted(UserProfile.objects.get(user=user).hidden_views) == sorted(contract["hideable"])


@pytest.mark.django_db
@pytest.mark.parametrize("always_on", ["overview", "settings"])
def test_each_always_on_key_is_refused_by_the_endpoint(always_on: str) -> None:
    """The always-on guarantee is enforced by the server, not merely by the client.

    ADR-0942 moved ``overview`` and ``settings`` INTO bands, so they are no longer
    unhideable by the structural accident of standing outside every band — the
    guarantee now rests on an authored vocabulary plus this 400. Parametrized rather
    than asserted as a pair so a failure names which key regressed.

    The client never offers these as toggles, which is exactly why the server check has
    to be tested directly: a UI-only guarantee is one refactor away from being no
    guarantee, and nothing else would notice.
    """
    user = User.objects.create_user(username=f"hv_{always_on}", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)

    resp = client.patch(URL, {"hidden_views": [always_on]}, format="json")

    assert resp.status_code == 400
    assert "hidden_views" in resp.data
    assert always_on in str(resp.data["hidden_views"])
    # Nothing was written — a refused hide must not leave a partial set behind.
    profile = UserProfile.objects.filter(user=user).first()
    assert profile is None or profile.hidden_views == []
