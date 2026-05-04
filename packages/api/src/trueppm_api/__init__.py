"""TruePPM Django REST API."""

# Loading the Celery app here is the standard Django+Celery integration:
# it forces ``app.set_default()`` at Django startup so ``shared_task.delay()``
# resolves to the configured trueppm_api app rather than an unconfigured
# default Celery instance with ``broker_url=None``. Without this,
# ``recalculate_schedule.delay()`` (and every other shared_task) raises
# ``OperationalError: Connection refused`` and the outbox row is silently
# left in PENDING — which is exactly what produced the cascade-not-firing
# regression in #314.
from .celery import app as celery_app

__all__ = ("celery_app",)
__version__ = "0.1.0"
