"""#2276 — heavy tasks route to the ``heavy`` queue, everything else stays on the default."""

from __future__ import annotations

from django.conf import settings

from trueppm_api.celery import app as celery_app
from trueppm_api.core.celery_queues import (
    DEFAULT_QUEUE,
    HEAVY_TASKS,
    build_task_routes,
)


def test_every_heavy_task_name_is_a_registered_task() -> None:
    """A typo in HEAVY_TASKS would silently leave that task on the default queue."""
    celery_app.loader.import_default_modules()
    missing = [name for name in HEAVY_TASKS if name not in celery_app.tasks]
    assert not missing, f"HEAVY_TASKS names unregistered tasks: {missing}"


def test_heavy_tasks_resolve_to_heavy_queue_and_light_to_default() -> None:
    celery_app.loader.import_default_modules()
    router = celery_app.amqp.router
    for name in HEAVY_TASKS:
        assert router.route({}, name)["queue"].name == "heavy", name
    for light in (
        "scheduling.drain_schedule_queue",
        "notifications.drain_notification_emails",
        "webhooks.drain_webhook_queue",
        "workspace.drain_invite_emails",
    ):
        assert router.route({}, light)["queue"].name == DEFAULT_QUEUE, light


def test_default_queue_is_celerys_own_name() -> None:
    """Renaming it would strand messages already queued by the previous release."""
    assert settings.CELERY_TASK_DEFAULT_QUEUE == "celery"


def test_heavy_queue_can_be_collapsed_onto_the_default() -> None:
    routes = build_task_routes(DEFAULT_QUEUE)
    assert {r["queue"] for r in routes.values()} == {DEFAULT_QUEUE}
