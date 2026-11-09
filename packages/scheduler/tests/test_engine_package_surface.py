"""``trueppm_scheduler.engine`` stays importable as it was before the package split (#4550).

``engine`` was one module through 0.4; #4550 split it into a subpackage for 0.5. The compatibility
contract is that every name importable from the 0.4 module is still importable from
``trueppm_scheduler.engine``, private helpers included, for the whole 0.5 line, and that
a pickle naming ``trueppm_scheduler.engine.<Class>`` still loads.

``_ENGINE_04_NAMES`` is ``dir(trueppm_scheduler.engine)`` on origin/main immediately
before the split, dunders excluded. It is a frozen snapshot, not a mirror of the
package: never regenerate it from the current tree, which would make this test pass by
construction. A name is only removed from it as part of an announced removal of that
re-export.
"""

from __future__ import annotations

import ast
import pickle
from pathlib import Path

import pytest

import trueppm_scheduler
from trueppm_scheduler import engine

_ENGINE_04_NAMES = (
    "Any",
    "Calendar",
    "Callable",
    "CycleCheck",
    "CyclicDependencyError",
    "DateRange",
    "DeliveryMode",
    "Dependency",
    "DependencyType",
    "DrivingEdge",
    "InvalidScheduleInput",
    "Iterable",
    "Iterator",
    "MAX_CALENDAR_EXCEPTIONS",
    "MAX_CALENDAR_SCAN_DAYS",
    "MAX_DEPENDENCIES",
    "MAX_DURATION_DAYS",
    "MAX_EXPANDED_EDGES",
    "MAX_INDEX_CELLS",
    "MAX_LAG_DAYS",
    "MAX_LAG_DELTA_CELLS",
    "MAX_PROJECT_SPAN_DAYS",
    "MAX_VELOCITY_SPRINTS",
    "MC_SENSITIVITY_CAP",
    "MC_SENSITIVITY_SUBSAMPLE",
    "Mapping",
    "MonteCarloResult",
    "NoReturn",
    "Percentile",
    "Project",
    "ScheduleResult",
    "SchedulerError",
    "Sequence",
    "SimulationCapExceeded",
    "SummaryExpansion",
    "Task",
    "TaskSensitivity",
    "_CYCLE_MSG_ID_CHARS",
    "_CYCLE_MSG_MAX_IDS",
    "_Date",
    "_FROM_PREDECESSOR_FINISH",
    "_FixedEdge",
    "_Instant",
    "_InstantRuns",
    "_LAG_DELTA_OVERRUN",
    "_MAX_ORDINAL",
    "_MAX_RUNS_ABSOLUTE",
    "_MAX_VELOCITY_SPRINT_TOTAL",
    "_MC_DAY_EPS",
    "_MC_PRE_START_PAD_BUFFER_DAYS",
    "_MC_REFERENCE_BLOCK_CELLS",
    "_MILESTONE_REPLAY_ATTR",
    "_MIN_ORDINAL",
    "_McIndex",
    "_MilestoneFloors",
    "_MilestoneReading",
    "_MilestoneReplay",
    "_ONE_DAY",
    "_OffsetLookup",
    "_START_ANCHORED",
    "_VELOCITY_CHUNK_CELLS",
    "_VELOCITY_REACH_RTOL",
    "_VerbatimActual",
    "_WorkingDayCounter",
    "_WorkingDayIndex",
    "_ZERO_BASE_ROUND_AWAY",
    "_advance_calendar_days",
    "_append_successor_constraint",
    "_apply_late_dates",
    "_apply_milestone_late_date",
    "_average_ranks",
    "_backward_pass",
    "_build_graph",
    "_build_lag_delta",
    "_build_lag_delta_table",
    "_build_reference_index",
    "_build_working_day_index",
    "_calendar_floors",
    "_canonical_cycle",
    "_check_children_map",
    "_check_duration",
    "_check_expansion_bound",
    "_check_whole_days",
    "_closed_milestone_link",
    "_collect_backward_constraints",
    "_collect_leaves",
    "_completed_dates",
    "_completed_edge_constraints",
    "_completed_offsets",
    "_compute_floats",
    "_compute_scheduled_start",
    "_count_working_days",
    "_cross_product_edges",
    "_describe_link",
    "_duration_sensitivity",
    "_early_start_floors",
    "_edge_anchor",
    "_effective_duration_days",
    "_elapsed_link_days",
    "_equivalent_link",
    "_expand_edges_for_cycle_check",
    "_finish_day_key",
    "_finish_from_start",
    "_finish_instant",
    "_float_late_instant",
    "_floor_above_start",
    "_floor_sampled_at_duration",
    "_forward_edge_constraints",
    "_forward_pass",
    "_free_float_days",
    "_free_start_ref",
    "_index_offset",
    "_instant_day",
    "_is_complete",
    "_is_finite_number",
    "_is_finite_real",
    "_is_valid_duration",
    "_lag_term",
    "_lagged_constraint",
    "_late_display",
    "_late_refs",
    "_link_binds",
    "_link_finish_ref",
    "_link_lower_bound",
    "_link_slack",
    "_link_start",
    "_link_start_ref",
    "_live_milestone_edge",
    "_longest_chain_days",
    "_mask_days_between",
    "_mc_edge_constraints",
    "_mc_effective_duration",
    "_mc_es_floors",
    "_mc_forward_pass",
    "_mc_horizon",
    "_mc_index_size",
    "_mc_instant_edge_bound",
    "_mc_instant_proposal",
    "_mc_milestone_bounds",
    "_mc_milestone_floors",
    "_mc_percentiles",
    "_mc_pre_start_pad_days",
    "_mc_progress_state",
    "_mc_span_link",
    "_mc_verbatim_actuals",
    "_mc_work_proposal",
    "_mc_zero_base_column",
    "_milestone_finish_bound",
    "_milestone_free_instants",
    "_milestone_hard_floors",
    "_milestone_instants",
    "_milestone_latest",
    "_milestone_link",
    "_milestone_proposal",
    "_milestone_refs",
    "_milestone_replay",
    "_next_working_day",
    "_node_key",
    "_nth_working_day",
    "_offset_to_date",
    "_pinned_milestone_instant",
    "_pinned_placement",
    "_place_milestone",
    "_prev_working_day",
    "_project_free_instants",
    "_raise_cycle_error",
    "_raise_mc_index_overrun",
    "_reject_overlapping_links",
    "_reject_summary_start_links",
    "_require_plain_date",
    "_require_project",
    "_resolve_endpoint_leaves",
    "_resolve_task_calendars",
    "_retreat_calendar_days",
    "_safe_fromordinal",
    "_safe_offset",
    "_sample_duration_matrix",
    "_sample_pert",
    "_sample_velocity_durations",
    "_scan_for_working_day",
    "_sf_latest_start",
    "_sf_linked",
    "_shift_duration",
    "_shift_remaining_work",
    "_short_repr",
    "_snap_to_working_day",
    "_snapped_offset",
    "_snapped_offsets",
    "_start_day_index",
    "_start_fixed_link",
    "_start_from_finish",
    "_start_is_recorded",
    "_start_read_cap",
    "_start_reading",
    "_task_span_totals",
    "_task_worst_case_days",
    "_to_reference_columns_inplace",
    "_to_reference_offset",
    "_unknown_calendar_id_message",
    "_validate_agile_inputs",
    "_validate_calendar_fields",
    "_validate_children_map_shape",
    "_validate_dependencies",
    "_validate_edge_list",
    "_validate_monte_carlo_args",
    "_validate_project",
    "_validate_project_calendar",
    "_validate_project_fields",
    "_validate_project_shape",
    "_validate_span_bounds",
    "_validate_task_actual_order",
    "_validate_task_calendar_id",
    "_validate_task_calendars",
    "_validate_task_date_types",
    "_validate_task_durations",
    "_validate_task_numerics",
    "_validate_task_span",
    "_validate_tasks",
    "_validate_unique_task_ids",
    "_velocity_mean",
    "_velocity_observations",
    "_velocity_worst_case_days",
    "_wd_span",
    "_window_start_bound",
    "_working_days_between",
    "_working_days_in_ordinals",
    "annotations",
    "bisect_left",
    "copy",
    "dataclass",
    "date",
    "datetime",
    "expand_summary_dependencies",
    "field",
    "find_cycle",
    "math",
    "monte_carlo",
    "np",
    "nx",
    "overload",
    "perturb_task_duration",
    "replace",
    "schedule",
    "timedelta",
    "weakref",
)

_ALL_04 = (
    "MAX_CALENDAR_EXCEPTIONS",
    "MAX_CALENDAR_SCAN_DAYS",
    "MAX_DEPENDENCIES",
    "MAX_DURATION_DAYS",
    "MAX_EXPANDED_EDGES",
    "MAX_INDEX_CELLS",
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
    "Percentile",
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
    "perturb_task_duration",
    "schedule",
)

_ENGINE_DIR = Path(engine.__file__).parent


@pytest.mark.parametrize("name", _ENGINE_04_NAMES)
def test_every_04_name_is_still_importable(name: str) -> None:
    """``from trueppm_scheduler.engine import <name>`` resolves for every 0.4 name."""
    namespace: dict[str, object] = {}
    exec(f"from trueppm_scheduler.engine import {name}", namespace)
    assert name in namespace


def test_the_snapshot_is_the_whole_04_surface() -> None:
    """A guard on the guard: the snapshot has not been trimmed to what happens to exist."""
    assert len(_ENGINE_04_NAMES) == 245
    assert len(set(_ENGINE_04_NAMES)) == len(_ENGINE_04_NAMES)


def test_package_all_is_unchanged() -> None:
    """``trueppm_scheduler.__all__`` is the same list, in the same order, as on 0.4."""
    assert list(trueppm_scheduler.__all__) == list(_ALL_04)


def test_a_04_pickle_of_a_result_type_still_loads() -> None:
    """Pickle resolves a class by ``module.qualname``; 0.4 wrote ``trueppm_scheduler.engine``.

    A protocol-0 pickle spells the module path as text, so rewriting the defining
    submodule back to ``trueppm_scheduler.engine`` reproduces exactly what 0.4 wrote.
    """
    edge = engine.DrivingEdge(
        predecessor_id="A",
        successor_id="B",
        dep_type=engine.DependencyType.FS,
    )
    current = pickle.dumps(edge, protocol=0)
    module = type(edge).__module__.encode()
    assert module != b"trueppm_scheduler.engine"  # the class moved to a submodule
    written_by_04 = current.replace(module, b"trueppm_scheduler.engine")
    assert b"trueppm_scheduler.engine\n" in written_by_04
    assert pickle.loads(written_by_04) == edge


def _engine_imports(path: Path) -> set[str]:
    """The ``trueppm_scheduler.engine.*`` submodules ``path`` imports at module scope."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in tree.body:
        if (
            isinstance(node, ast.ImportFrom)
            and node.module
            and node.module.startswith("trueppm_scheduler.engine.")
        ):
            out.add(node.module)
    return out


def _submodules() -> dict[str, Path]:
    mods: dict[str, Path] = {}
    for path in sorted(_ENGINE_DIR.rglob("*.py")):
        rel = path.relative_to(_ENGINE_DIR).with_suffix("")
        parts = [p for p in rel.parts if p != "__init__"]
        if parts:
            mods[".".join(["trueppm_scheduler.engine", *parts])] = path
    return mods


def test_engine_submodules_import_each_other_without_a_cycle() -> None:
    """The submodules form a DAG, so none of them depends on import order to load.

    ``engine/__init__.py`` imports every submodule in dependency order; a cycle between
    two submodules would only surface as an ImportError for whichever one a caller
    happened to import first.
    """
    mods = _submodules()
    assert len(mods) > 10, mods
    graph = {name: _engine_imports(path) & set(mods) for name, path in mods.items()}
    state: dict[str, int] = {}

    def visit(node: str, stack: list[str]) -> None:
        state[node] = 1
        for nxt in sorted(graph[node]):
            if state.get(nxt) == 1:
                pytest.fail("import cycle: " + " -> ".join([*stack, node, nxt]))
            if nxt not in state:
                visit(nxt, [*stack, node])
        state[node] = 2

    for name in sorted(graph):
        if name not in state:
            visit(name, [])


def test_no_engine_module_is_over_the_size_budget() -> None:
    """The split exists to keep modules reviewable; one regrowing to 7k lines undoes it."""
    for path in _ENGINE_DIR.rglob("*.py"):
        lines = len(path.read_text(encoding="utf-8").splitlines())
        assert lines <= 1_500, f"{path.relative_to(_ENGINE_DIR)} is {lines} lines"
