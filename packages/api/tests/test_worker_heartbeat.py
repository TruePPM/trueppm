"""Tests for the celery worker file-touch heartbeat (#3346).

Covers:
  - the default heartbeat file path, and that TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE
    overrides it
  - worker_ready touches (creates) the file
  - heartbeat_sent refreshes an existing file's mtime
  - worker_shutting_down removes the file
  - a write failure (e.g. an unwritable parent directory) is logged, not raised
  - the signal handlers are actually connected to celery's signals, not merely
    defined
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from trueppm_api.core import worker_heartbeat


@pytest.fixture
def heartbeat_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "heartbeat-file"
    monkeypatch.setenv("TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE", str(path))
    return path


class TestHeartbeatFile:
    def test_default_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("TRUEPPM_CELERY_WORKER_HEARTBEAT_FILE", raising=False)
        assert worker_heartbeat.heartbeat_file() == Path("/tmp/trueppm-celery-worker-heartbeat")

    def test_env_override(self, heartbeat_path: Path) -> None:
        assert worker_heartbeat.heartbeat_file() == heartbeat_path


class TestTouchAndRemove:
    def test_touch_creates_the_file(self, heartbeat_path: Path) -> None:
        assert not heartbeat_path.exists()
        worker_heartbeat._touch(heartbeat_path)
        assert heartbeat_path.exists()

    def test_touch_creates_missing_parent_directories(self, tmp_path: Path) -> None:
        nested = tmp_path / "a" / "b" / "heartbeat-file"
        worker_heartbeat._touch(nested)
        assert nested.exists()

    def test_touch_refreshes_mtime_on_an_existing_file(self, heartbeat_path: Path) -> None:
        worker_heartbeat._touch(heartbeat_path)
        first_mtime = heartbeat_path.stat().st_mtime
        time.sleep(0.01)
        worker_heartbeat._touch(heartbeat_path)
        assert heartbeat_path.stat().st_mtime > first_mtime

    def test_touch_failure_is_logged_not_raised(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        # A parent path that is a FILE, not a directory, makes mkdir/touch fail.
        blocking_file = tmp_path / "not-a-directory"
        blocking_file.write_text("x")
        unwritable = blocking_file / "heartbeat-file"

        with caplog.at_level("WARNING", logger=worker_heartbeat.__name__):
            worker_heartbeat._touch(unwritable)  # must not raise

        assert any("could not touch" in r.message for r in caplog.records)

    def test_remove_deletes_the_file(self, heartbeat_path: Path) -> None:
        worker_heartbeat._touch(heartbeat_path)
        assert heartbeat_path.exists()
        worker_heartbeat._remove(heartbeat_path)
        assert not heartbeat_path.exists()

    def test_remove_is_a_noop_when_the_file_is_already_gone(self, heartbeat_path: Path) -> None:
        assert not heartbeat_path.exists()
        worker_heartbeat._remove(heartbeat_path)  # must not raise


class TestSignalHandlers:
    def test_worker_ready_touches_the_file(self, heartbeat_path: Path) -> None:
        assert not heartbeat_path.exists()
        worker_heartbeat._on_worker_ready()
        assert heartbeat_path.exists()

    def test_heartbeat_sent_touches_the_file(self, heartbeat_path: Path) -> None:
        assert not heartbeat_path.exists()
        worker_heartbeat._on_heartbeat_sent()
        assert heartbeat_path.exists()

    def test_worker_shutting_down_removes_the_file(self, heartbeat_path: Path) -> None:
        worker_heartbeat._touch(heartbeat_path)
        assert heartbeat_path.exists()
        worker_heartbeat._on_worker_shutting_down()
        assert not heartbeat_path.exists()

    def test_handlers_are_connected_to_celery_signals(self, heartbeat_path: Path) -> None:
        """Regression guard: defining a handler is not the same as wiring it up.

        Drives celery's real signal dispatch (``Signal.send``) rather than
        inspecting the signal's internal receiver storage, so this stays valid
        across celery versions that store receivers differently. Importing
        ``trueppm_api.celery`` is what connects the handlers (it imports this
        module for that side effect); it is idempotent to import more than
        once, so re-importing it here does not double-connect.
        """
        from celery.signals import heartbeat_sent, worker_ready, worker_shutting_down

        import trueppm_api.celery  # noqa: F401 — import for the side effect

        assert not heartbeat_path.exists()
        worker_ready.send(sender=None)
        assert heartbeat_path.exists(), "worker_ready is not connected to the heartbeat handler"

        heartbeat_path.unlink()
        heartbeat_sent.send(sender=None)
        assert heartbeat_path.exists(), "heartbeat_sent is not connected to the heartbeat handler"

        worker_shutting_down.send(sender=None)
        assert not heartbeat_path.exists(), (
            "worker_shutting_down is not connected to the heartbeat handler"
        )
