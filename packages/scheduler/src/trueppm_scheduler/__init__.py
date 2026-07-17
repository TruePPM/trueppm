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

from trueppm_scheduler.derive import (
    Derivation,
    DerivationContribution,
    Quantity,
    UnknownTaskError,
    derive_value,
)
from trueppm_scheduler.engine import (
    MAX_CALENDAR_EXCEPTIONS,
    MAX_CALENDAR_SCAN_DAYS,
    MAX_DURATION_DAYS,
    MAX_EXPANDED_EDGES,
    MAX_LAG_DAYS,
    MAX_LAG_DELTA_CELLS,
    MAX_PROJECT_SPAN_DAYS,
    MAX_VELOCITY_SPRINTS,
    MC_SENSITIVITY_CAP,
    CycleCheck,
    CyclicDependencyError,
    DrivingEdge,
    InvalidScheduleInput,
    MonteCarloResult,
    SchedulerError,
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

# Flat, alphabetically sorted (RUF022). The ``MAX_*`` / ``MC_*`` validator caps
# are exported so downstream validators (e.g. the TruePPM API) enforce the *same*
# bounds as the engine rather than drifting from them.
__all__ = [
    "MAX_CALENDAR_EXCEPTIONS",
    "MAX_CALENDAR_SCAN_DAYS",
    "MAX_DURATION_DAYS",
    "MAX_EXPANDED_EDGES",
    "MAX_LAG_DAYS",
    "MAX_LAG_DELTA_CELLS",
    "MAX_PROJECT_SPAN_DAYS",
    "MAX_VELOCITY_SPRINTS",
    "MC_SENSITIVITY_CAP",
    "Calendar",
    "CycleCheck",
    "CyclicDependencyError",
    "DateRange",
    "DeliveryMode",
    "Dependency",
    "DependencyType",
    "Derivation",
    "DerivationContribution",
    "DrivingEdge",
    "InvalidScheduleInput",
    "MonteCarloResult",
    "Project",
    "Quantity",
    "ScheduleResult",
    "SchedulerError",
    "SimulationCapExceeded",
    "SummaryExpansion",
    "Task",
    "TaskSensitivity",
    "UnknownTaskError",
    "derive_value",
    "expand_summary_dependencies",
    "find_cycle",
    "monte_carlo",
    "schedule",
]
