"""Regression tests for the savepoint-safe on-commit capture (#2945).

The suite has ~55 test modules that assert "this work is deferred to
``transaction.on_commit()``" through the ``django_capture_on_commit_callbacks``
fixture. Django's stock implementation harvests the callbacks by *index*
(``run_on_commit[start_count:]``), which silently returns nothing whenever a savepoint
unwind shrinks the list below ``start_count`` — an order-dependent flake that reports
as ``0 == 1`` on an otherwise successful request. ``tests/on_commit.py`` replaces it
with an identity-based capture and ``tests/conftest.py`` binds the fixture to it;
these tests pin that behavior so a future revert cannot pass unnoticed.

Every case here goes through the *fixture*, so a conftest that stopped overriding
pytest-django's version would fail these too — not just a regression in the helper.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from django.db import connection, transaction

from tests.on_commit import capture_on_commit_callbacks


@pytest.mark.django_db
def test_captures_callback_registered_after_a_savepoint_unwind(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """A savepoint rollback inside the block must not hide a later registration.

    This is the exact shape of the #2945 flake, driven through the savepoint API
    directly: it is the only way to unwind, from *inside* the capture block, a
    savepoint that was opened *before* it. ``savepoint_rollback`` drops every
    ``run_on_commit`` entry registered while that savepoint was active — here both
    the pre-existing one and its sibling — so the callback registered afterwards
    lands at an index below the length the stock implementation memorized on entry,
    and is never seen.
    """
    calls: list[str] = []
    # `connection.savepoint()` alone does not register the savepoint id; appending
    # to `savepoint_ids` is what `transaction.atomic().__enter__` does next, and it
    # is what makes `on_commit` tag its entries with this savepoint.
    sid = connection.savepoint()
    connection.savepoint_ids.append(sid)
    try:
        transaction.on_commit(lambda: calls.append("registered-before-the-block"))

        with django_capture_on_commit_callbacks(execute=True) as captured:
            transaction.on_commit(lambda: calls.append("also-doomed"))
            connection.savepoint_rollback(sid)
            transaction.on_commit(lambda: calls.append("survivor"))
    finally:
        connection.savepoint_ids.remove(sid)

    assert calls == ["survivor"]
    assert len(captured) == 1


@pytest.mark.django_db
def test_does_not_capture_callbacks_registered_before_the_block(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """Pre-existing entries stay out of the capture — the fix must not over-collect.

    Fixtures routinely leave callbacks on ``run_on_commit`` (row creation goes
    through broadcast paths), so a capture that returned everything would make the
    "exactly one dispatch" assertions in the suite vacuous.
    """
    calls: list[str] = []
    transaction.on_commit(lambda: calls.append("before"))

    with django_capture_on_commit_callbacks(execute=True) as captured:
        transaction.on_commit(lambda: calls.append("inside"))

    assert calls == ["inside"]
    assert len(captured) == 1


@pytest.mark.django_db
def test_executes_callbacks_registered_by_other_callbacks(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The re-scan loop is preserved: a callback may register further callbacks."""
    calls: list[str] = []

    def outer() -> None:
        calls.append("outer")
        transaction.on_commit(inner)

    def inner() -> None:
        calls.append("inner")

    with django_capture_on_commit_callbacks(execute=True) as captured:
        transaction.on_commit(outer)

    assert calls == ["outer", "inner"]
    assert len(captured) == 2


@pytest.mark.django_db
def test_execute_false_collects_without_running(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """``execute=False`` still yields the callbacks, unrun — two call sites rely on it."""
    calls: list[str] = []

    with django_capture_on_commit_callbacks(execute=False) as captured:
        transaction.on_commit(lambda: calls.append("deferred"))

    assert calls == []
    assert len(captured) == 1
    captured[0]()
    assert calls == ["deferred"]


@pytest.mark.django_db
def test_robust_callback_failure_is_swallowed_and_logged(
    django_capture_on_commit_callbacks: Callable[..., Any],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A ``robust=True`` callback that raises is logged, not propagated (Django parity)."""

    def boom() -> None:
        raise RuntimeError("robust callbacks swallow this")

    with (
        caplog.at_level("ERROR"),
        django_capture_on_commit_callbacks(execute=True) as captured,
    ):
        transaction.on_commit(boom, robust=True)

    assert len(captured) == 1
    assert "robust callbacks swallow this" in caplog.text


@pytest.mark.django_db
def test_fixture_is_the_shared_helper(
    django_capture_on_commit_callbacks: Callable[..., Any],
) -> None:
    """The fixture must be our override, not pytest-django's index-slice default.

    Django ``TestCase`` subclasses bypass the fixture system entirely and import
    ``capture_on_commit_callbacks`` directly, so the two entry points have to stay the
    same object or one of them silently reverts to the broken implementation.
    """
    assert django_capture_on_commit_callbacks is capture_on_commit_callbacks
