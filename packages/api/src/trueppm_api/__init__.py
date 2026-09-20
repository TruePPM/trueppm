"""TruePPM Django REST API."""

from importlib.metadata import PackageNotFoundError, version

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

try:
    # Read from installed distribution metadata rather than a hard-coded
    # literal, so this can't drift from pyproject.toml the way it silently
    # had (frozen at "0.1.0" while the package shipped 0.4.0-beta.3) — nothing
    # in-tree reads __version__, so nothing caught it; an external consumer
    # (e.g. trueppm-enterprise pinning this package) doing
    # `import trueppm_api; trueppm_api.__version__` is the one this protects.
    __version__ = version("trueppm-api")
except PackageNotFoundError:
    # Source checkout that was never `pip install -e`'d has no metadata to read.
    __version__ = "0.0.0.dev0"
