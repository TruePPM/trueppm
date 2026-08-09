"""Tests for the dependency-aware readiness probe (#1894).

Covers:
  - GET /api/v1/readyz is reachable UNAUTHENTICATED (kubelet has no credential)
  - 200 + all-ok checks when the database, cache, and migrations are all healthy
  - 503 when the cache probe fails
  - 503 when the database probe fails
  - 503 when migrations are unapplied/in-flight (#2217)
  - 503 with migration_state "ahead" when the pod BOOTED against a database that
    records migrations it does not ship — an image rolled back without restoring
    the schema (#2806); the check a migration plan is structurally unable to make
  - 200 when the same "ahead" state is reached by DRIFT after boot — the forward
    rolling upgrade, where gating the old pods would empty the Service (#2806)
  - the replaces=-squash discipline does not false-positive as "ahead" (#2806)
  - TRUEPPM_READYZ_ALLOW_DB_AHEAD re-opens the "ahead" gate for a deliberate
    additive-only rollback, without hiding the state and without touching "behind"
  - the body leaks no infrastructure detail — only coarse ok/fail per dependency
    plus the coarse migration-state enum
  - the selector helpers probe DB, cache, and migrations independently
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest
from rest_framework.test import APIClient

from trueppm_api.apps.observability.selectors import (
    READY_MIGRATIONS_AHEAD,
    READY_MIGRATIONS_BEHIND,
    READY_MIGRATIONS_IN_SYNC,
    READY_MIGRATIONS_UNKNOWN,
)

if TYPE_CHECKING:
    from django.db.migrations.loader import MigrationLoader

URL = "/api/v1/readyz"

# An app label that is always installed and always has migrations, so a synthetic
# "recorded but not shipped" row lands inside the scope the probe judges.
_INSTALLED_APP = "auth"
_FUTURE_MIGRATION = "0099_future_from_a_newer_image"


def _loader() -> MigrationLoader:
    """Build a real MigrationLoader against the test connection."""
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor

    return MigrationExecutor(connection).loader


@pytest.fixture(autouse=True)
def reset_process_latches() -> Iterator[None]:
    """Clear the module-level latches around every test in this file.

    ``_first_migration_state`` and ``_db_ahead_override_warned`` are per-*process*
    state by design (they model "what did this pod boot into" and "have we said
    this once"). In a pytest worker that process outlives every test, so without
    this the first test to set them silently decides the outcome of the rest —
    the classic pass-alone / fail-in-suite ordering coupling.
    """
    import trueppm_api.apps.observability.selectors as selectors_module

    selectors_module._first_migration_state = None
    selectors_module._db_ahead_override_warned = False
    try:
        yield
    finally:
        selectors_module._first_migration_state = None
        selectors_module._db_ahead_override_warned = False


@pytest.fixture
def booted_ahead() -> Iterator[None]:
    """Pin the process as having booted against an already-newer schema.

    That is the rollback posture: the pod started with the database ahead of its
    code, rather than drifting there mid-rollout while it was already serving.
    """
    import trueppm_api.apps.observability.selectors as selectors_module

    selectors_module._first_migration_state = READY_MIGRATIONS_AHEAD
    yield


@pytest.fixture
def recorded_future_migration() -> Iterator[None]:
    """Record a migration this image does not ship, then remove it.

    Reproduces the audit's empirical check: with only the plan-based probe, a row
    for a migration absent from this image's graph left ``readyz`` reporting ready.
    """
    from django.db import connection
    from django.db.migrations.recorder import MigrationRecorder

    recorder = MigrationRecorder(connection)
    recorder.record_applied(_INSTALLED_APP, _FUTURE_MIGRATION)
    try:
        yield
    finally:
        recorder.record_unapplied(_INSTALLED_APP, _FUTURE_MIGRATION)


@pytest.mark.django_db
class TestReadyzEndpoint:
    def test_unauthenticated_and_healthy_returns_200(self) -> None:
        # No force_authenticate: the probe must answer without any credential.
        # The test database has every migration applied, so the migration check
        # is "ok" alongside the DB and cache round-trips.
        res = APIClient().get(URL)
        assert res.status_code == 200
        assert res.data["status"] == "ok"
        assert res.data["checks"] == {"database": "ok", "cache": "ok", "migrations": "ok"}
        assert res.data["migration_state"] == READY_MIGRATIONS_IN_SYNC

    def test_cache_failure_returns_503(self) -> None:
        with patch("trueppm_api.apps.observability.selectors._probe_cache", return_value=False):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["cache"] == "fail"
        assert res.data["checks"]["database"] == "ok"
        # Only the cache is down — the migration state is still reported honestly.
        assert res.data["migration_state"] == READY_MIGRATIONS_IN_SYNC

    def test_database_failure_returns_503(self) -> None:
        with patch("trueppm_api.apps.observability.selectors._probe_database", return_value=False):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["database"] == "fail"

    def test_unapplied_migration_returns_503(self) -> None:
        """A pod with unapplied/in-flight migrations must report not-ready (#2217).

        Simulates the rolling-upgrade window where the image's code carries
        migrations the connected database has not applied yet — the pod is up but
        its schema and code disagree, so it must be kept out of the Service.
        """
        with patch(
            "trueppm_api.apps.observability.selectors._probe_migrations",
            return_value=READY_MIGRATIONS_BEHIND,
        ):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["migrations"] == "fail"
        assert res.data["migration_state"] == READY_MIGRATIONS_BEHIND
        # DB and cache are still healthy — only the migration gate is closed.
        assert res.data["checks"]["database"] == "ok"
        assert res.data["checks"]["cache"] == "ok"

    def test_database_ahead_of_image_returns_503(
        self, recorded_future_migration: None, booted_ahead: None
    ) -> None:
        """A rolled-back image against a newer schema must report not-ready (#2806).

        The regression this pins: ``migration_plan()`` walks *this image's* graph,
        so a recorded migration the image never shipped can never appear in it and
        the probe used to answer 200 — the false backstop upgrade.md advertised.
        """
        res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["status"] == "fail"
        assert res.data["checks"]["migrations"] == "fail"
        assert res.data["migration_state"] == READY_MIGRATIONS_AHEAD
        # The drift is one-directional: nothing is wrong with DB or cache.
        assert res.data["checks"]["database"] == "ok"
        assert res.data["checks"]["cache"] == "ok"

    def test_ahead_after_boot_stays_ready_so_a_rolling_upgrade_keeps_serving(
        self, recorded_future_migration: None
    ) -> None:
        """An old pod must keep serving while a new pod migrates the schema (#2806).

        The forward rolling upgrade drives the database ahead of every old-image
        pod still in the Service: the new pod's ``migrate`` init container moves
        the schema while the old ones keep serving. Gating those would empty the
        Service of endpoints at the exact moment the new pods are not Ready yet —
        a self-inflicted outage on every upgrade. This pod booted ``in_sync`` and
        only drifted, so it stays ready while still reporting the drift.
        """
        import trueppm_api.apps.observability.selectors as selectors_module

        selectors_module._first_migration_state = READY_MIGRATIONS_IN_SYNC
        res = APIClient().get(URL)
        assert res.status_code == 200
        assert res.data["checks"]["migrations"] == "ok"
        # Reported, not hidden — the operator still sees the drift.
        assert res.data["migration_state"] == READY_MIGRATIONS_AHEAD

    def test_allow_db_ahead_reopens_the_gate_without_hiding_the_state(
        self, recorded_future_migration: None, booted_ahead: None, settings: object
    ) -> None:
        """The opt-out changes readiness, not the diagnosis (#2806).

        An operator who has read the release's migrations and knows they are
        additive must be able to complete the image-only rollback the runbook
        recommends — but the probe must still say the schema is newer.
        """
        settings.TRUEPPM_READYZ_ALLOW_DB_AHEAD = True
        res = APIClient().get(URL)
        assert res.status_code == 200
        assert res.data["status"] == "ok"
        assert res.data["checks"]["migrations"] == "ok"
        assert res.data["migration_state"] == READY_MIGRATIONS_AHEAD

    def test_allow_db_ahead_logs_a_warning_once_per_process(
        self,
        recorded_future_migration: None,
        booted_ahead: None,
        settings: object,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The open gate is invisible to `status`/`checks`, so it must reach the log.

        Once per process, not per probe: kubelet calls readiness every ~10 s.
        """
        import trueppm_api.apps.observability.selectors as selectors_module

        settings.TRUEPPM_READYZ_ALLOW_DB_AHEAD = True
        with caplog.at_level("WARNING", logger=selectors_module.__name__):
            APIClient().get(URL)
            APIClient().get(URL)
        warnings = [r for r in caplog.records if "TRUEPPM_READYZ_ALLOW_DB_AHEAD" in r.message]
        assert len(warnings) == 1

    def test_no_override_warning_when_the_gate_is_closed(
        self, recorded_future_migration: None, booted_ahead: None, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A gated `ahead` pod is already visible as not-ready — no warning needed."""
        import trueppm_api.apps.observability.selectors as selectors_module

        with caplog.at_level("WARNING", logger=selectors_module.__name__):
            APIClient().get(URL)
        assert not [r for r in caplog.records if "TRUEPPM_READYZ_ALLOW_DB_AHEAD" in r.message]

    def test_allow_db_ahead_does_not_reopen_the_behind_gate(self, settings: object) -> None:
        """Nothing makes a half-migrated pod safe to serve."""
        settings.TRUEPPM_READYZ_ALLOW_DB_AHEAD = True
        with patch(
            "trueppm_api.apps.observability.selectors._probe_migrations",
            return_value=READY_MIGRATIONS_BEHIND,
        ):
            res = APIClient().get(URL)
        assert res.status_code == 503
        assert res.data["checks"]["migrations"] == "fail"

    def test_body_leaks_no_infrastructure_detail(self) -> None:
        """A failing probe must expose only 'fail', never a connection string/host."""
        with patch("trueppm_api.apps.observability.selectors._probe_cache", return_value=False):
            res = APIClient().get(URL)
        # Values are the coarse literals only — nothing host/DSN-shaped.
        assert set(res.data["checks"].values()) <= {"ok", "fail"}

    def test_migration_state_is_a_coarse_enum(self, recorded_future_migration: None) -> None:
        """The new field must never name the offending migration or its app."""
        res = APIClient().get(URL)
        assert res.data["migration_state"] in {
            READY_MIGRATIONS_IN_SYNC,
            READY_MIGRATIONS_BEHIND,
            READY_MIGRATIONS_AHEAD,
            READY_MIGRATIONS_UNKNOWN,
        }
        assert _FUTURE_MIGRATION not in str(res.data)
        assert _INSTALLED_APP not in str(res.data)


@pytest.mark.django_db
class TestReadinessSelectors:
    def test_probe_database_true_when_db_up(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_database

        assert _probe_database() is True

    def test_probe_cache_true_when_cache_up(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_cache

        assert _probe_cache() is True

    def test_probe_cache_false_on_backend_error(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_cache

        with patch("django.core.cache.cache.set", side_effect=ConnectionError("cache down")):
            assert _probe_cache() is False

    def test_probe_migrations_in_sync_when_all_applied(self) -> None:
        from trueppm_api.apps.observability.selectors import _probe_migrations

        # The pytest-django test database is migrated to the leaf, so the plan
        # is empty and no recorded migration is unknown to this image.
        assert _probe_migrations() == READY_MIGRATIONS_IN_SYNC

    def test_probe_migrations_behind_when_plan_nonempty(self) -> None:
        """A non-empty migration plan (unapplied/in-flight) means not-ready."""
        from django.db.migrations.executor import MigrationExecutor

        from trueppm_api.apps.observability.selectors import _probe_migrations

        # Simulate an outstanding migration: the executor returns a non-empty
        # plan, so the probe must report not-ready. Patching migration_plan on
        # the class covers the function-local import inside the probe.
        with patch.object(
            MigrationExecutor, "migration_plan", return_value=[("app", "0002_pending")]
        ):
            assert _probe_migrations() == READY_MIGRATIONS_BEHIND

    def test_probe_migrations_ahead_when_db_records_unknown_migration(
        self, recorded_future_migration: None
    ) -> None:
        """A recorded migration this image does not ship means not-ready (#2806)."""
        from trueppm_api.apps.observability.selectors import _probe_migrations

        assert _probe_migrations() == READY_MIGRATIONS_AHEAD

    def test_probe_migrations_unknown_on_error(self) -> None:
        """Any executor error is swallowed into not-ready, like the DB/cache probes."""
        from django.db.migrations.executor import MigrationExecutor

        from trueppm_api.apps.observability.selectors import _probe_migrations

        with patch.object(
            MigrationExecutor, "migration_plan", side_effect=RuntimeError("loader blew up")
        ):
            assert _probe_migrations() == READY_MIGRATIONS_UNKNOWN

    def test_migration_probe_failure_does_not_poison_the_database_probe(self) -> None:
        """A failing migration probe must not make the database look down.

        ``ATOMIC_REQUESTS`` is on and the migration probe now runs first, so a
        database error raised inside it would abort the request's transaction and
        leave ``_probe_database`` reporting ``fail`` for a perfectly healthy
        database — an operator sent chasing the wrong outage mid-incident. The
        probe's own ``transaction.atomic()`` savepoint keeps the failure local.
        """
        from django.db import connection

        from trueppm_api.apps.observability.selectors import get_readiness

        def explode(*_args: object, **_kwargs: object) -> None:
            with connection.cursor() as cursor:
                cursor.execute("SELECT * FROM a_table_that_does_not_exist")

        with patch("django.db.migrations.executor.MigrationExecutor", side_effect=explode):
            ready, checks, migration_state = get_readiness()

        assert ready is False
        assert migration_state == READY_MIGRATIONS_UNKNOWN
        assert checks["migrations"] == "fail"
        # The point of the test: the healthy dependency is still reported healthy.
        assert checks["database"] == "ok"

    def test_get_readiness_reports_per_dependency(self) -> None:
        from trueppm_api.apps.observability.selectors import get_readiness

        ready, checks, migration_state = get_readiness()
        assert ready is True
        assert checks == {"database": "ok", "cache": "ok", "migrations": "ok"}
        assert migration_state == READY_MIGRATIONS_IN_SYNC


@pytest.mark.django_db
class TestUnknownAppliedMigrationDetection:
    """Direct coverage for the DB-ahead comparison's two deliberate exclusions."""

    def test_clean_tree_has_nothing_unknown(self) -> None:
        from trueppm_api.apps.observability.selectors import _has_migrations_unknown_to_image

        # Includes the real 0001_squashed_* migrations: the project squashes with
        # replaces= and keeps the originals on disk, and applying a squash records
        # each replaced original — so every recorded row resolves against disk.
        assert _has_migrations_unknown_to_image(_loader()) is False

    def test_recorded_migration_missing_from_disk_is_unknown(
        self, recorded_future_migration: None
    ) -> None:
        from trueppm_api.apps.observability.selectors import _has_migrations_unknown_to_image

        assert _has_migrations_unknown_to_image(_loader()) is True

    def test_recorded_original_covered_by_a_squash_replaces_is_known(self) -> None:
        """A squash that deletes its originals must not flip every pod to not-ready.

        The repo's `replaces=` discipline keeps originals on disk, so today they
        resolve directly. This pins the guard for a future squash that does not:
        the original is dropped from disk and only named in the replacement's
        `replaces=` list, and it must still count as known.
        """
        from django.db.migrations.migration import Migration

        from trueppm_api.apps.observability.selectors import _has_migrations_unknown_to_image

        loader = _loader()
        original = next(
            key
            for key in loader.applied_migrations
            if key[0] == _INSTALLED_APP and key in loader.disk_migrations
        )
        squash = Migration("0001_squashed", _INSTALLED_APP)
        squash.replaces = [original]

        # Drop the original from disk and stand a replacement in its place.
        del loader.disk_migrations[original]
        loader.disk_migrations[(_INSTALLED_APP, "0001_squashed")] = squash
        assert _has_migrations_unknown_to_image(loader) is False

        # Control: without the replaces= cover, the same row reads as unknown.
        del loader.disk_migrations[(_INSTALLED_APP, "0001_squashed")]
        assert _has_migrations_unknown_to_image(loader) is True

    def test_recorded_migration_for_an_uninstalled_app_is_ignored(self) -> None:
        """Rows for apps this image does not install are deliberately not flagged.

        Removing an optional app from INSTALLED_APPS — and running the community
        image against a database an Enterprise image migrated — would otherwise
        pin every pod at not-ready forever. This image ships no code that reads
        those tables, so their schema cannot disagree with it.
        """
        from django.db import connection
        from django.db.migrations.recorder import MigrationRecorder

        from trueppm_api.apps.observability.selectors import _has_migrations_unknown_to_image

        recorder = MigrationRecorder(connection)
        recorder.record_applied("an_app_this_image_does_not_install", "0001_initial")
        try:
            assert _has_migrations_unknown_to_image(_loader()) is False
        finally:
            recorder.record_unapplied("an_app_this_image_does_not_install", "0001_initial")
