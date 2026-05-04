"""Regression test for #319 — beat-scheduled tasks must be registered under their short names.

Every entry in ``CELERY_BEAT_SCHEDULE`` references its target by a short name
(e.g. ``"scheduling.drain_schedule_queue"``). If the corresponding ``@idempotent_task``
or ``@shared_task`` decorator does not pass ``name="..."``, Celery registers the
task under its fully-qualified module path and the worker rejects beat-fired
messages with ``Received unregistered task of type ...``. This is silent — beat
keeps firing, the worker keeps rejecting, and every drain/purge stays dead.

This test enumerates ``CELERY_BEAT_SCHEDULE`` and asserts that each entry's task
name resolves in ``celery_app.tasks``. Adding a new beat entry without a matching
``name=`` kwarg will fail this test.
"""

from __future__ import annotations

from django.conf import settings

from trueppm_api.celery import app as celery_app


def test_every_beat_schedule_entry_resolves_to_a_registered_task() -> None:
    """Each CELERY_BEAT_SCHEDULE entry's task short name must be in celery_app.tasks."""
    schedule = settings.CELERY_BEAT_SCHEDULE
    assert schedule, "CELERY_BEAT_SCHEDULE is empty — test would be vacuous"

    # Force task discovery so the assertion sees the same registry the worker
    # builds at startup. Without this the test would import celery_app before
    # any task module has registered itself and fail spuriously.
    celery_app.loader.import_default_modules()

    registered = set(celery_app.tasks.keys())
    missing: list[tuple[str, str]] = []
    for entry_name, entry in schedule.items():
        task_name = entry["task"]
        if task_name not in registered:
            missing.append((entry_name, task_name))

    assert not missing, (
        "Beat schedule entries reference unregistered task names. Add "
        'name="<short.name>" to the corresponding @idempotent_task or '
        f"@shared_task decorator. Missing: {missing}"
    )
