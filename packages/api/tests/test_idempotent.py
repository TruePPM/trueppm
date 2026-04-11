"""Tests for the @idempotent_task decorator (trueppm_api.core.idempotent)."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers — reset the lock key registry between tests
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    """Clear the lock key registry before each test."""
    from trueppm_api.core import idempotent

    idempotent._lock_key_registry.clear()


# ---------------------------------------------------------------------------
# Lock key registry
# ---------------------------------------------------------------------------


def test_registry_raises_on_duplicate() -> None:
    from trueppm_api.core.idempotent import _register_lock_key

    _register_lock_key("foo:{0}")
    with pytest.raises(ValueError, match="Duplicate"):
        _register_lock_key("foo:{0}")


def test_registry_allows_different_keys() -> None:
    from trueppm_api.core.idempotent import _register_lock_key

    _register_lock_key("a:{0}")
    _register_lock_key("b:{0}")  # should not raise


# ---------------------------------------------------------------------------
# Decorator basics — lock acquired
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_task_runs_when_lock_acquired(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """When the lock is acquired, the wrapped function executes normally."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True  # Lock acquired
    mock_client.register_script.return_value = MagicMock()  # release script

    from trueppm_api.core.idempotent import idempotent_task

    call_log: list[str] = []

    @idempotent_task(
        lock_key_template="test_run:{0}",
        lock_ttl=60,
        on_contention="skip",
        name="test.runs_when_acquired",
    )
    def my_task(self: object, item_id: str) -> str:
        call_log.append(item_id)
        return item_id

    # With bind=True, run() injects the task instance as self automatically.
    my_task.run("abc")

    assert call_log == ["abc"]


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_lock_released_on_success(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """The lock is released (compare-and-delete) after successful execution."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True
    mock_release = MagicMock()
    mock_client.register_script.return_value = mock_release

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="release_test:{0}",
        lock_ttl=60,
        on_contention="skip",
        name="test.released_on_success",
    )
    def my_task(self: object, item_id: str) -> None:
        pass

    my_task.run("xyz")

    # Release script should have been called.
    mock_release.assert_called_once()


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_lock_released_on_exception(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """The lock is released even when the wrapped function raises."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True
    mock_release = MagicMock()
    mock_client.register_script.return_value = mock_release

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="exc_test:{0}",
        lock_ttl=60,
        on_contention="skip",
        name="test.released_on_exception",
    )
    def my_task(self: object, item_id: str) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        my_task.run("xyz")

    mock_release.assert_called_once()


# ---------------------------------------------------------------------------
# Contention: skip strategy
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_skip_on_contention(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """With on_contention='skip', a held lock causes the task to be discarded."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = None  # Lock NOT acquired

    from trueppm_api.core.idempotent import idempotent_task

    call_log: list[str] = []

    @idempotent_task(
        lock_key_template="skip:{0}",
        lock_ttl=60,
        on_contention="skip",
        name="test.skip_contention",
    )
    def my_task(self: object, item_id: str) -> None:
        call_log.append(item_id)

    my_task.run("abc")

    assert call_log == []  # Task body was NOT called


# ---------------------------------------------------------------------------
# Contention: queue strategy
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_queue_on_contention_requeues(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """With on_contention='queue', a held lock causes the task to be re-queued."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = None  # Lock NOT acquired

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="queue:{0}",
        lock_ttl=60,
        on_contention="queue",
        queue_countdown=5,
        max_queue_attempts=3,
        name="test.queue_contention",
    )
    def my_task(self: object, item_id: str) -> None:
        pass

    with patch.object(my_task, "apply_async") as mock_apply:
        my_task.run("abc")

        mock_apply.assert_called_once_with(
            args=["abc"],
            kwargs={},
            countdown=5,
            headers={"x-requeue-count": 1},
        )


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_queue_drops_at_max_attempts(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """With on_contention='queue', exceeding max attempts drops the task."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = None  # Lock NOT acquired

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="queue_max:{0}",
        lock_ttl=60,
        on_contention="queue",
        max_queue_attempts=3,
        name="test.queue_max_attempts",
    )
    def my_task(self: object, item_id: str) -> None:
        pass

    with patch.object(my_task, "apply_async") as mock_apply:
        # Simulate request headers with requeue count at max.
        my_task.request.headers = {"x-requeue-count": 3}
        try:
            my_task.run("abc")
        finally:
            my_task.request.headers = {}

        # Should NOT re-queue — max attempts reached.
        mock_apply.assert_not_called()


# ---------------------------------------------------------------------------
# Contention: retry strategy
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_retry_on_contention(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """With on_contention='retry', a held lock raises self.retry()."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = None  # Lock NOT acquired

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="retry:{0}",
        lock_ttl=60,
        on_contention="retry",
        queue_countdown=15,
        max_retries=3,
        name="test.retry_contention",
    )
    def my_task(self: object, item_id: str) -> None:
        pass

    # Celery's retry() raises Retry exception.
    retry_exc = Exception("Retry!")
    with patch.object(my_task, "retry", side_effect=retry_exc) as mock_retry:
        with pytest.raises(Exception, match="Retry"):
            my_task.run("abc")

        mock_retry.assert_called_once_with(countdown=15, max_retries=3)


# ---------------------------------------------------------------------------
# Lock extension thread
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_lock_extender_runs(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """The lock extension thread calls the extend script periodically."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True  # Lock acquired

    extend_calls: list[dict] = []
    release_mock = MagicMock()

    def fake_register_script(script: str) -> MagicMock:
        if "EXPIRE" in script:
            mock_fn = MagicMock()

            def record_call(**kw: object) -> int:
                extend_calls.append(kw)
                return 1

            mock_fn.side_effect = record_call
            return mock_fn
        return release_mock

    mock_client.register_script.side_effect = fake_register_script

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="extend_test:{0}",
        lock_ttl=6,
        lock_extend_interval=1,
        on_contention="skip",
        name="test.lock_extender",
    )
    def my_task(self: object, item_id: str) -> None:
        time.sleep(2.5)  # Long enough for 2 extension calls

    my_task.run("abc")

    # The extend script should have been called at least once.
    assert len(extend_calls) >= 1


# ---------------------------------------------------------------------------
# Lock key template formatting
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_lock_key_formatted_from_args(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """The lock key template is formatted using positional task args."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock()

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="proj:{0}:action:{1}",
        lock_ttl=60,
        on_contention="skip",
        name="test.key_formatted",
    )
    def my_task(self: object, project_id: str, action: str) -> None:
        pass

    my_task.run("p123", "build")

    # Check that SET was called with the formatted key.
    call_args = mock_client.set.call_args
    assert call_args[0][0] == "proj:p123:action:build"


# ---------------------------------------------------------------------------
# Static lock key (no args)
# ---------------------------------------------------------------------------


@patch("trueppm_api.core.idempotent.settings")
@patch("trueppm_api.core.idempotent.redis_lib")
def test_static_lock_key(mock_redis_mod: MagicMock, mock_settings: MagicMock) -> None:
    """A static lock key (no placeholders) works for global locks."""
    mock_settings.REDIS_URL = "redis://localhost:6379"
    mock_client = MagicMock()
    mock_redis_mod.from_url.return_value = mock_client
    mock_client.set.return_value = True
    mock_client.register_script.return_value = MagicMock()

    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="global_lock",
        lock_ttl=60,
        on_contention="skip",
        name="test.static_key",
    )
    def my_task(self: object) -> None:
        pass

    my_task.run()

    call_args = mock_client.set.call_args
    assert call_args[0][0] == "global_lock"


# ---------------------------------------------------------------------------
# Task kwargs passthrough
# ---------------------------------------------------------------------------


def test_task_kwargs_passthrough() -> None:
    """Extra kwargs are passed through to @shared_task."""
    from trueppm_api.core.idempotent import idempotent_task

    @idempotent_task(
        lock_key_template="passthrough_test",
        lock_ttl=60,
        on_contention="skip",
        name="custom.task.name",
        max_retries=5,
    )
    def my_task(self: object) -> None:
        pass

    assert my_task.name == "custom.task.name"
    assert my_task.max_retries == 5
