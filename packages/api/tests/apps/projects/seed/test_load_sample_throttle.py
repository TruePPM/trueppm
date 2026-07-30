"""Abuse bounds on the two actions that run the seed importer (#2402).

``POST /programs/load-sample/`` and ``POST /programs/import/`` both rebuild an
entire program per call — a hard delete of the caller's prior program with the
same code, then a full import (per-row saves with history rows, the replay
timeline, the forecast backfill) synchronously inside one transaction. Both were
left on the viewset's general ``user`` default of 1000/min, so one authenticated
member could drive a thousand teardown-and-rebuild cycles a minute. These tests
pin the per-action throttles that replace that default.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.projects.program_views import (
    LoadSampleThrottle,
    ProgramViewSet,
    SeedImportThrottle,
)

from .test_importer import _seed

pytestmark = pytest.mark.django_db

User = get_user_model()

LOAD_SAMPLE_URL = "/api/v1/programs/load-sample/"
IMPORT_URL = "/api/v1/programs/import/"

# The cheapest bundled fixture — the throttle is what is under test, so pay the
# smallest possible import cost for the one call that is allowed through.
CHEAPEST_SAMPLE = "helios-crm-replacement"


@pytest.fixture(autouse=True)
def _clear_throttle_cache() -> Any:
    """Throttle history lives in the LocMem cache; clear it around each test so a
    drained bucket never leaves a later test pre-throttled."""
    cache.clear()
    yield
    cache.clear()


def _patch_rate(
    monkeypatch: pytest.MonkeyPatch,
    rate: str | None,
    throttle: type[LoadSampleThrottle] | type[SeedImportThrottle] = LoadSampleThrottle,
) -> None:
    """Override just this throttle's rate (``None`` = no cap, as the kill switch sets).

    Set on the subclass, not on ``SimpleRateThrottle``, so the general anon/user
    buckets are untouched. A plain ``override_settings`` would not work: DRF binds
    ``THROTTLE_RATES`` at import, so it never reaches the already-bound class.

    Caveat worth knowing: the subclasses only *inherit* ``THROTTLE_RATES``, so
    monkeypatch's undo re-sets it as an explicit attribute on the subclass, which
    then shadows the inherited one for the rest of the session. Harmless — the
    restored value is the same object DRF bound at import — but it does mean a
    later ``override_settings(REST_FRAMEWORK=…)`` test could not reach these two
    classes. Use this helper rather than adding a second patching idiom.
    """
    monkeypatch.setattr(
        throttle,
        "THROTTLE_RATES",
        {**throttle.THROTTLE_RATES, throttle.scope: rate},
    )


@pytest.fixture
def user() -> Any:
    return User.objects.create_user(username="evaluator", password="pw")


@pytest.fixture
def client(user: Any) -> APIClient:
    api = APIClient()
    api.force_login(user)
    return api


def test_action_declares_the_scoped_throttle_not_the_user_default() -> None:
    """The action must REPLACE the general ``user`` default, not stack with it.

    Wired via the ``@action(throttle_classes=[...])`` kwarg, so this asserts the
    kwarg actually reached the generated route rather than being silently
    dropped — the failure mode would be a 1000/min endpoint that looks bounded.
    """
    initkwargs = ProgramViewSet.load_sample.kwargs
    assert initkwargs["throttle_classes"] == [LoadSampleThrottle]


def test_throttle_scope_matches_the_configured_rate_key() -> None:
    """The class-bound scope must match the ``DEFAULT_THROTTLE_RATES`` key, or DRF
    silently falls through to no throttling at all."""
    assert LoadSampleThrottle.scope == "sample_load"
    assert LoadSampleThrottle.THROTTLE_RATES.get("sample_load")


def test_exceeding_the_rate_returns_429(client: APIClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second load inside the window is rejected before the import runs.

    Patch the rate on the class: DRF binds THROTTLE_RATES at import, so a plain
    settings override never reaches the already-bound throttle.
    """
    _patch_rate(monkeypatch, "1/min")
    cache.clear()

    first = client.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json")
    second = client.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json")

    assert first.status_code == 201
    assert second.status_code == 429
    # The rejection must short-circuit in initial() — no second import ran, so
    # the throttled call cannot have left a partial program behind.
    assert Program.objects.filter(is_deleted=False).count() == 1


def test_throttle_is_per_account_not_global(
    client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One member exhausting the bucket must not lock out everyone else — the
    scope keys on the user, so a second account gets its own allowance."""
    _patch_rate(monkeypatch, "1/min")
    cache.clear()

    assert client.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json").status_code == (
        201
    )
    assert client.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json").status_code == (
        429
    )

    other = APIClient()
    other.force_login(User.objects.create_user(username="second", password="pw"))
    assert other.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json").status_code == (
        201
    )


@pytest.mark.parametrize(
    ("throttle", "url", "body"),
    [
        (LoadSampleThrottle, LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}),
        (SeedImportThrottle, IMPORT_URL, None),
    ],
    ids=["load-sample", "import"],
)
def test_operator_kill_switch_neutralizes_these_throttles(
    client: APIClient,
    monkeypatch: pytest.MonkeyPatch,
    throttle: type[LoadSampleThrottle] | type[SeedImportThrottle],
    url: str,
    body: dict[str, Any] | None,
) -> None:
    """A ``None`` rate must disable the cap outright (ADR-0604).

    ``apply_rate_limit_disable`` empties ``DEFAULT_THROTTLE_CLASSES`` and nulls
    every rate — it never names individual classes, so these throttles are covered
    only because they resolve their rate through ``THROTTLE_RATES``. The nightly
    ``api:fuzz`` job depends on BOTH being neutralized: it sets the kill switch
    precisely so the fuzzer exercises views instead of throttles. Re-implementing
    either as one of the Redis-backed ``BaseThrottle`` classes would silently keep
    throttling (those need the ``@bypass_when_disabled`` decorator instead), and
    the fuzz job would quietly go back to testing the rate limiter.
    """
    _patch_rate(monkeypatch, None, throttle)
    cache.clear()

    statuses = [
        client.post(url, body if body is not None else _seed(), format="json").status_code
        for _ in range(3)
    ]

    # Asserted as "nothing was throttled" rather than as an exact code: the two
    # parametrized actions no longer share one. ``load-sample`` still returns 201
    # (synchronous), while ``import`` returns 202 and then 409 on the repeats,
    # because the first call now leaves a live program holding the seed's slug
    # and replacement requires explicit consent (ADR-0726). The kill switch is
    # about 429s; spelling out each action's success code here would couple this
    # test to a contract it does not exercise.
    assert 429 not in statuses


# ---------------------------------------------------------------------------
# POST /programs/import/ — the sibling action running the same importer
# ---------------------------------------------------------------------------


def test_import_action_declares_its_own_throttle() -> None:
    """Sibling parity: ``import_seed`` calls the same ``import_seed()`` under the
    same IsAuthenticated-only gate, so bounding only ``load_sample`` would leave
    the cheaper vector open — its payload is caller-sized, not fixture-fixed."""
    assert ProgramViewSet.import_seed.kwargs["throttle_classes"] == [SeedImportThrottle]


def test_import_uses_a_separate_bucket_from_the_demo_loader() -> None:
    """Distinct scopes, so clicking "Load demo data" never spends a user's real
    import allowance (and vice versa)."""
    assert SeedImportThrottle.scope == "seed_import"
    assert SeedImportThrottle.scope != LoadSampleThrottle.scope
    assert SeedImportThrottle.THROTTLE_RATES.get("seed_import")


def test_exceeding_the_import_rate_returns_429(
    client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_rate(monkeypatch, "1/min", SeedImportThrottle)
    cache.clear()

    first = client.post(IMPORT_URL, _seed(), format="json")
    second = client.post(IMPORT_URL, _seed(), format="json")

    assert first.status_code == 202
    # Throttled in initial(), before the view body — so the second call never
    # reaches the replace check that would otherwise answer 409.
    assert second.status_code == 429


def test_demo_loader_and_import_do_not_share_a_bucket(
    client: APIClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Draining one scope must leave the other's allowance intact — the practical
    consequence of the separate scopes asserted above."""
    _patch_rate(monkeypatch, "1/min", SeedImportThrottle)
    _patch_rate(monkeypatch, "1/min", LoadSampleThrottle)
    cache.clear()

    assert client.post(IMPORT_URL, _seed(), format="json").status_code == 202
    assert client.post(IMPORT_URL, _seed(), format="json").status_code == 429

    # The demo loader's own bucket is untouched.
    assert client.post(LOAD_SAMPLE_URL, {"sample": CHEAPEST_SAMPLE}, format="json").status_code == (
        201
    )
