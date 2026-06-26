"""TruePPM Scheduler — critical-path (CPM) and Monte Carlo scheduling engine."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

try:
    # Single source of truth: the version is whatever pip installed (set from
    # pyproject.toml at build time). Deriving it here means the runtime
    # ``__version__`` can never drift from the published wheel's metadata.
    __version__ = _pkg_version("trueppm-scheduler")
except PackageNotFoundError:  # running from an un-installed source tree
    __version__ = "0.0.0+unknown"

from trueppm_scheduler.engine import (
    CycleCheck,
    CyclicDependencyError,
    InvalidScheduleInput,
    MonteCarloResult,
    ScheduleResult,
    SimulationCapExceeded,
    SummaryExpansion,
    TaskSensitivity,
    expand_summary_dependencies,
    find_cycle,
    monte_carlo,
    schedule,
)
from trueppm_scheduler.models import (
    Calendar,
    DateRange,
    DeliveryMode,
    Dependency,
    DependencyType,
    Project,
    Task,
)

__all__ = [
    "Calendar",
    "CycleCheck",
    "CyclicDependencyError",
    "DateRange",
    "DeliveryMode",
    "Dependency",
    "DependencyType",
    "InvalidScheduleInput",
    "MonteCarloResult",
    "Project",
    "ScheduleResult",
    "SimulationCapExceeded",
    "SummaryExpansion",
    "Task",
    "TaskSensitivity",
    "expand_summary_dependencies",
    "find_cycle",
    "monte_carlo",
    "schedule",
]
