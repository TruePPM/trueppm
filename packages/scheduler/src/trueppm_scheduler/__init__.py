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

from trueppm_scheduler.calendar import (
    next_working_day,
    nth_working_day,
    previous_working_day,
    working_day_count,
)
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
    MAX_DEPENDENCIES,
    MAX_DURATION_DAYS,
    MAX_EXPANDED_EDGES,
    MAX_INDEX_CELLS,
    MAX_LAG_DAYS,
    MAX_LAG_DELTA_CELLS,
    MAX_PROJECT_SPAN_DAYS,
    MAX_PROJECT_WORK_DAYS,
    MAX_VELOCITY_SPRINTS,
    MC_SENSITIVITY_CAP,
    CycleCheck,
    CyclicDependencyError,
    DrivingEdge,
    InvalidScheduleInput,
    MonteCarloResult,
    Percentile,
    SchedulerError,
    ScheduleResult,
    SimulationCapExceeded,
    SimulationTimeExceeded,
    SummaryExpansion,
    TaskSensitivity,
    WorkingDayCounter,
    collect_leaves,
    expand_summary_dependencies,
    find_cycle,
    monte_carlo,
    perturb_task_duration,
    schedule,
)
from trueppm_scheduler.graph_export import (
    GRAPH_FORMAT_VERSION,
    GraphEdge,
    GraphExport,
    GraphNode,
    to_graph,
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
from trueppm_scheduler.summary_rollup import roll_up_summary

# Flat, alphabetically sorted (RUF022). The ``MAX_*`` / ``MC_*`` validator caps
# are exported so downstream validators (e.g. the TruePPM API) enforce the *same*
# bounds as the engine rather than drifting from them.
__all__ = [
    "GRAPH_FORMAT_VERSION",
    "MAX_CALENDAR_EXCEPTIONS",
    "MAX_CALENDAR_SCAN_DAYS",
    "MAX_DEPENDENCIES",
    "MAX_DURATION_DAYS",
    "MAX_EXPANDED_EDGES",
    "MAX_INDEX_CELLS",
    "MAX_LAG_DAYS",
    "MAX_LAG_DELTA_CELLS",
    "MAX_PROJECT_SPAN_DAYS",
    "MAX_PROJECT_WORK_DAYS",
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
    "GraphEdge",
    "GraphExport",
    "GraphNode",
    "InvalidScheduleInput",
    "MonteCarloResult",
    "Percentile",
    "Project",
    "Quantity",
    "ScheduleResult",
    "SchedulerError",
    "SimulationCapExceeded",
    "SimulationTimeExceeded",
    "SummaryExpansion",
    "Task",
    "TaskSensitivity",
    "UnknownTaskError",
    "WorkingDayCounter",
    "collect_leaves",
    "derive_value",
    "expand_summary_dependencies",
    "find_cycle",
    "monte_carlo",
    "next_working_day",
    "nth_working_day",
    "perturb_task_duration",
    "previous_working_day",
    "roll_up_summary",
    "schedule",
    "to_graph",
    "working_day_count",
]
