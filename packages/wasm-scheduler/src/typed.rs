//! Typed-array drag-preview result (#1856).
//!
//! The stateless JSON entry points ([`crate::compute_schedule`],
//! [`crate::wasm_incremental_update`]) and the session's JSON `recalc*` methods
//! serialize a [`crate::models::ScheduleResult`] to a JSON *string* every call.
//! On a drag — where the same project is recomputed every animation frame — that
//! string is then copied UTF-8 → UTF-16 across the WASM boundary and `JSON.parse`d
//! into thousands of fresh JS objects. At 5k tasks that serialization/parse alone
//! blows the 16.7 ms frame budget.
//!
//! This module produces the same per-task CPM facts as **columnar typed arrays**
//! instead, indexed by the session's stable dense node order:
//!
//! - `early_start` / `early_finish` / `late_start` / `late_finish` — `i32` **day
//!   ordinals relative to the session epoch** (`project.start_date`). A JS caller
//!   reconstructs a date as `epoch + ordinal` days, using the epoch exposed once
//!   at session creation.
//! - `total_float` / `free_float` — `f64` **seconds** (the exact unit the JSON
//!   `TaskResult` carries, so values are bit-for-bit comparable; JS divides by
//!   86 400 for working days, as it already does for the JSON shape).
//! - `is_critical` — `u8` (0/1) per task. A `Uint8Array` was chosen over a packed
//!   bitset: at one byte per task it is ~5 KB for 5k tasks (negligible) and needs
//!   no bit-unpacking on the JS side.
//! - `node_indices` — the dense node position of each row. For a full recalc this
//!   is `0..N`; for the downstream-only (incremental) recalc it is the subset of
//!   nodes reachable from the dragged task — i.e. this array *is* the delta-emit.
//!
//! Task **ids never cross the boundary per frame**: the caller reads the id
//! ordering **once** (via [`crate::SchedulerSession::task_ids`]) and maps
//! `row → node = node_indices[row] → id = ids[node]`. Because a drag moves a
//! bar's *date*, not the network topology, the id ordering and epoch are constant
//! for the whole session.
//!
//! The columns are built into a resident scratch `Vec<Task>` (owned by the
//! session) so the per-frame path no longer deep-clones `project.tasks` — the two
//! heap `String`s per task (id, name) stay resident and only the `Copy` input
//! fields are refreshed before the passes overwrite the computed fields.

use chrono::{Datelike, NaiveDate};

use crate::backward::backward_pass;
use crate::floats::compute_floats;
use crate::forward::forward_pass;
use crate::graph::ProjectGraph;
use crate::incremental::downstream_mask;
use crate::models::{Project, Task};

/// Columnar CPM result for a set of tasks, indexed by their row position.
///
/// Pure data (no `wasm_bindgen`/`JsValue`) so native tests can assert
/// correctness parity against the JSON [`crate::models::ScheduleResult`]. The
/// wasm-facing [`crate::DragResult`] is a thin wrapper that hands these columns
/// to JS as typed arrays.
pub(crate) struct TypedResult {
    /// Dense node position of each row (row → node). `0..N` for a full recalc;
    /// the downstream subset for an incremental recalc (the delta).
    pub node_indices: Vec<u32>,
    /// Day ordinals relative to the session epoch.
    pub early_start: Vec<i32>,
    pub early_finish: Vec<i32>,
    pub late_start: Vec<i32>,
    pub late_finish: Vec<i32>,
    /// Float in seconds (parity with `TaskResult`), one entry per row.
    pub total_float: Vec<f64>,
    pub free_float: Vec<f64>,
    /// 1 if the task is on the critical path, else 0 — one entry per row.
    pub is_critical: Vec<u8>,
    /// Whole-project aggregates, as epoch-relative day ordinals.
    pub project_start: i32,
    pub project_finish: i32,
}

impl TypedResult {
    fn with_capacity(cap: usize) -> Self {
        TypedResult {
            node_indices: Vec::with_capacity(cap),
            early_start: Vec::with_capacity(cap),
            early_finish: Vec::with_capacity(cap),
            late_start: Vec::with_capacity(cap),
            late_finish: Vec::with_capacity(cap),
            total_float: Vec::with_capacity(cap),
            free_float: Vec::with_capacity(cap),
            is_critical: Vec::with_capacity(cap),
            project_start: 0,
            project_finish: 0,
        }
    }

    /// Append task at dense node position `node` (its computed fields are set by
    /// the passes that ran just before this call).
    fn push(&mut self, node: usize, t: &Task, epoch: NaiveDate) {
        self.node_indices.push(node as u32);
        self.early_start
            .push(to_ordinal(t.early_start.unwrap(), epoch));
        self.early_finish
            .push(to_ordinal(t.early_finish.unwrap(), epoch));
        self.late_start
            .push(to_ordinal(t.late_start.unwrap(), epoch));
        self.late_finish
            .push(to_ordinal(t.late_finish.unwrap(), epoch));
        self.total_float.push(t.total_float);
        self.free_float.push(t.free_float);
        self.is_critical.push(u8::from(t.is_critical));
    }
}

/// A date as a day ordinal relative to `epoch` (`project.start_date`). Both use
/// `num_days_from_ce`, so the subtraction is exact; the result fits `i32` for any
/// date the validator admits (spans are bounded well under `i32::MAX` days).
fn to_ordinal(date: NaiveDate, epoch: NaiveDate) -> i32 {
    date.num_days_from_ce() - epoch.num_days_from_ce()
}

/// Refresh the scratch buffer's *input* fields from `project` without touching
/// its resident `String`s (id, name) or `Option<String>`s (calendar_id,
/// delivery_mode) — those are constant for the whole session (a drag moves only
/// `planned_start`), so re-cloning them every frame is exactly the allocation
/// this path exists to avoid. All refreshed fields are `Copy`, so this is
/// allocation-free. The passes overwrite every computed field, so stale computed
/// values from the previous frame never leak.
fn sync_inputs(scratch: &mut [Task], project: &Project) {
    for (dst, src) in scratch.iter_mut().zip(project.tasks.iter()) {
        dst.duration = src.duration;
        dst.planned_start = src.planned_start;
        dst.planned_finish = src.planned_finish;
        dst.percent_complete = src.percent_complete;
        dst.actual_start = src.actual_start;
        dst.actual_finish = src.actual_finish;
        dst.optimistic_duration = src.optimistic_duration;
        dst.most_likely_duration = src.most_likely_duration;
        dst.pessimistic_duration = src.pessimistic_duration;
        dst.story_points = src.story_points;
    }
}

/// Run the three CPM passes (forward → backward → floats) over `scratch` in
/// place, returning the project finish. Identical math to
/// [`crate::compute_full`] / [`crate::incremental::compute_downstream`]; the only
/// difference is that the caller owns `scratch`, so no per-frame `Vec<Task>`
/// clone is paid.
fn run_passes(
    scratch: &mut [Task],
    project: &Project,
    pg: &ProjectGraph,
) -> Result<NaiveDate, String> {
    forward_pass(
        scratch,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project.start_date,
        &project.calendar,
        project.status_date,
    )?;

    let project_finish = scratch
        .iter()
        .filter_map(|t| t.early_finish)
        .max()
        .ok_or("No tasks with early_finish after forward pass")?;

    backward_pass(
        scratch,
        &pg.topo_order,
        pg,
        &project.dependencies,
        project_finish,
        &project.calendar,
    )?;

    compute_floats(
        scratch,
        &pg.topo_order,
        pg,
        &project.dependencies,
        &project.calendar,
    )?;

    Ok(project_finish)
}

/// Ensure `scratch` mirrors the project's task set. A session never changes its
/// topology, so this is a one-time clone on the first call (or a defensive
/// re-clone if a length mismatch ever appears); subsequent frames reuse it.
fn ensure_scratch(scratch: &mut Vec<Task>, project: &Project) {
    if scratch.len() != project.tasks.len() {
        *scratch = project.tasks.clone();
    }
}

/// Full CPM over the cached graph, emitted as columnar typed arrays indexed by
/// dense node order (`node_indices == 0..N`). No JSON, no per-frame task clone.
pub(crate) fn compute_full_typed(
    project: &Project,
    pg: &ProjectGraph,
    scratch: &mut Vec<Task>,
    epoch: NaiveDate,
) -> Result<TypedResult, String> {
    ensure_scratch(scratch, project);
    sync_inputs(scratch, project);
    let project_finish = run_passes(scratch, project, pg)?;
    let project_start = scratch.iter().filter_map(|t| t.early_start).min().unwrap();

    let n = scratch.len();
    let mut result = TypedResult::with_capacity(n);
    for (node, t) in scratch.iter().enumerate() {
        result.push(node, t, epoch);
    }
    result.project_start = to_ordinal(project_start, epoch);
    result.project_finish = to_ordinal(project_finish, epoch);
    Ok(result)
}

/// Downstream-only CPM over the cached graph, emitted as columnar typed arrays.
/// Only tasks reachable from `changed_task_id` (inclusive) are pushed, so
/// `node_indices` is the drag delta. Whole-project aggregates are still computed
/// over the full task set, matching the JSON path.
pub(crate) fn compute_downstream_typed(
    project: &Project,
    pg: &ProjectGraph,
    scratch: &mut Vec<Task>,
    epoch: NaiveDate,
    changed_task_id: &str,
) -> Result<TypedResult, String> {
    // Resolve + reject a stale id BEFORE running the passes (#1087).
    let mask = downstream_mask(pg, changed_task_id, project.tasks.len())?;

    ensure_scratch(scratch, project);
    sync_inputs(scratch, project);
    let project_finish = run_passes(scratch, project, pg)?;
    let project_start = scratch.iter().filter_map(|t| t.early_start).min().unwrap();

    let downstream_count = mask.iter().filter(|&&d| d).count();
    let mut result = TypedResult::with_capacity(downstream_count);
    for (node, t) in scratch.iter().enumerate() {
        if mask[node] {
            result.push(node, t, epoch);
        }
    }
    result.project_start = to_ordinal(project_start, epoch);
    result.project_finish = to_ordinal(project_finish, epoch);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::build_graph;
    use crate::incremental::{compute_downstream, incremental_update};
    use crate::models::{Calendar, Dependency, DependencyType, Project, Task};
    use crate::{compute_full, schedule_impl};
    use chrono::NaiveDate;

    fn make_task(id: &str, days: i32) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: days as f64 * 86400.0,
            planned_start: None,
            planned_finish: None,
            early_start: None,
            early_finish: None,
            late_start: None,
            late_finish: None,
            total_float: 0.0,
            free_float: 0.0,
            is_critical: false,
            percent_complete: 0.0,
            actual_start: None,
            actual_finish: None,
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
            calendar_id: None,
            delivery_mode: None,
            story_points: None,
        }
    }

    fn dep(pred: &str, succ: &str) -> Dependency {
        Dependency {
            predecessor_id: pred.to_string(),
            successor_id: succ.to_string(),
            dep_type: DependencyType::FS,
            lag: 0.0,
        }
    }

    fn ord_to_date(ordinal: i32, epoch: NaiveDate) -> NaiveDate {
        NaiveDate::from_num_days_from_ce_opt(epoch.num_days_from_ce() + ordinal).unwrap()
    }

    fn chain_project() -> Project {
        Project {
            id: "p".to_string(),
            name: "chain".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![
                make_task("A", 5),
                make_task("B", 3),
                make_task("C", 2),
                make_task("D", 4),
            ],
            dependencies: vec![dep("A", "B"), dep("B", "C"), dep("A", "D")],
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        }
    }

    /// The typed-array full result must carry the same per-task CPM values as the
    /// JSON `compute_full` result for the same project — the correctness-parity
    /// contract for the boundary change (#1856).
    #[test]
    fn typed_full_matches_json_full() {
        let project = chain_project();
        let epoch = project.start_date;
        let pg = build_graph(&project).unwrap();

        let json = compute_full(&project, &pg).unwrap();
        let mut scratch = project.tasks.clone();
        let typed = compute_full_typed(&project, &pg, &mut scratch, epoch).unwrap();

        assert_eq!(typed.node_indices.len(), json.tasks.len());
        assert_eq!(ord_to_date(typed.project_start, epoch), json.project_start);
        assert_eq!(
            ord_to_date(typed.project_finish, epoch),
            json.project_finish
        );

        // Row order for a full result is dense node order == project.tasks order.
        let json_by_id: std::collections::HashMap<&str, &_> =
            json.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
        for row in 0..typed.node_indices.len() {
            let node = typed.node_indices[row] as usize;
            let id = project.tasks[node].id.as_str();
            let jt = json_by_id[id];
            assert_eq!(
                ord_to_date(typed.early_start[row], epoch),
                jt.early_start,
                "{id} ES"
            );
            assert_eq!(
                ord_to_date(typed.early_finish[row], epoch),
                jt.early_finish,
                "{id} EF"
            );
            assert_eq!(
                ord_to_date(typed.late_start[row], epoch),
                jt.late_start,
                "{id} LS"
            );
            assert_eq!(
                ord_to_date(typed.late_finish[row], epoch),
                jt.late_finish,
                "{id} LF"
            );
            assert_eq!(typed.total_float[row], jt.total_float, "{id} TF");
            assert_eq!(typed.free_float[row], jt.free_float, "{id} FF");
            assert_eq!(typed.is_critical[row] == 1, jt.is_critical, "{id} crit");
        }
    }

    /// The typed downstream result must match the JSON `compute_downstream`
    /// result (same downstream task set, same values) after a drag.
    #[test]
    fn typed_downstream_matches_json_downstream_after_drag() {
        let mut project = chain_project();
        let epoch = project.start_date;
        let pg = build_graph(&project).unwrap();

        // Drag A out a week.
        project.tasks[0].planned_start = Some(NaiveDate::from_ymd_opt(2026, 4, 8).unwrap());

        let json = compute_downstream(&project, &pg, "A").unwrap();
        let mut scratch = project.tasks.clone();
        let typed = compute_downstream_typed(&project, &pg, &mut scratch, epoch, "A").unwrap();

        assert_eq!(typed.node_indices.len(), json.tasks.len());
        let json_by_id: std::collections::HashMap<&str, &_> =
            json.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
        for row in 0..typed.node_indices.len() {
            let node = typed.node_indices[row] as usize;
            let id = project.tasks[node].id.as_str();
            let jt = json_by_id[id];
            assert_eq!(
                ord_to_date(typed.early_start[row], epoch),
                jt.early_start,
                "{id} ES"
            );
            assert_eq!(
                ord_to_date(typed.early_finish[row], epoch),
                jt.early_finish,
                "{id} EF"
            );
            assert_eq!(
                ord_to_date(typed.late_start[row], epoch),
                jt.late_start,
                "{id} LS"
            );
            assert_eq!(
                ord_to_date(typed.late_finish[row], epoch),
                jt.late_finish,
                "{id} LF"
            );
            assert_eq!(typed.total_float[row], jt.total_float, "{id} TF");
            assert_eq!(typed.free_float[row], jt.free_float, "{id} FF");
            assert_eq!(typed.is_critical[row] == 1, jt.is_critical, "{id} crit");
        }
    }

    /// A scratch buffer reused across frames — with only `planned_start` changing
    /// between frames — must yield the same result as a fresh clone each frame.
    /// This is the core #1856 invariant: reusing the resident buffer (no per-frame
    /// deep clone) never leaks stale computed values.
    #[test]
    fn reused_scratch_matches_fresh_each_frame() {
        let mut project = chain_project();
        let epoch = project.start_date;
        let pg = build_graph(&project).unwrap();

        // One resident scratch buffer, reused for every frame.
        let mut scratch = project.tasks.clone();

        for day in [1, 8, 15, 3] {
            project.tasks[0].planned_start = Some(NaiveDate::from_ymd_opt(2026, 4, day).unwrap());

            // Reused resident scratch.
            let reused = compute_full_typed(&project, &pg, &mut scratch, epoch).unwrap();
            // Fresh clone (the pre-#1856 behaviour).
            let mut fresh_scratch = project.tasks.clone();
            let fresh = compute_full_typed(&project, &pg, &mut fresh_scratch, epoch).unwrap();

            assert_eq!(reused.early_start, fresh.early_start);
            assert_eq!(reused.early_finish, fresh.early_finish);
            assert_eq!(reused.late_start, fresh.late_start);
            assert_eq!(reused.late_finish, fresh.late_finish);
            assert_eq!(reused.total_float, fresh.total_float);
            assert_eq!(reused.free_float, fresh.free_float);
            assert_eq!(reused.is_critical, fresh.is_critical);
            assert_eq!(reused.project_start, fresh.project_start);
            assert_eq!(reused.project_finish, fresh.project_finish);
        }
    }

    /// A stale changed id (deleted mid-drag) is rejected as a clean Err, never a
    /// panic that traps the module (#1087) — parity with the JSON path.
    #[test]
    fn typed_downstream_rejects_unknown_id() {
        let project = chain_project();
        let pg = build_graph(&project).unwrap();
        let mut scratch = project.tasks.clone();
        assert!(
            compute_downstream_typed(&project, &pg, &mut scratch, project.start_date, "GHOST")
                .is_err()
        );
    }

    /// A larger, realistic-scale project (5,000 tasks in a mixed chain/fan-out
    /// shape) exercises the per-frame incremental path without a per-frame deep
    /// clone or JSON serialization — the scale #1856 targets.
    #[test]
    fn incremental_5k_tasks_runs_without_full_clone_or_json() {
        const N: usize = 5_000;
        let mut tasks = Vec::with_capacity(N);
        let mut deps = Vec::with_capacity(N);
        for i in 0..N {
            tasks.push(make_task(&format!("T{i}"), (i % 5) as i32 + 1));
            if i > 0 {
                // A predecessor a few nodes back → a wide, deep DAG. Clamp to 0
                // so the earliest nodes still chain to the root.
                let pred = i.saturating_sub(1 + (i % 3));
                deps.push(dep(&format!("T{pred}"), &format!("T{i}")));
            }
        }
        let project = Project {
            id: "big".to_string(),
            name: "5k".to_string(),
            start_date: NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks,
            dependencies: deps,
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        };
        let epoch = project.start_date;
        let pg = build_graph(&project).unwrap();
        let mut scratch = project.tasks.clone();

        // Simulate a drag: many frames over ONE resident scratch buffer.
        let mut project = project;
        for day in 1..=20 {
            project.tasks[0].planned_start =
                Some(NaiveDate::from_ymd_opt(2026, 4, (day % 28) + 1).unwrap());
            let typed = compute_downstream_typed(&project, &pg, &mut scratch, epoch, "T0").unwrap();
            // Dragging the root task shifts (nearly) the whole network downstream.
            assert!(!typed.node_indices.is_empty());
            assert_eq!(typed.early_start.len(), typed.node_indices.len());
        }

        // Final full recompute still parity-matches the JSON full path at scale.
        let json = schedule_impl(&project).unwrap();
        let typed = compute_full_typed(&project, &pg, &mut scratch, epoch).unwrap();
        assert_eq!(typed.node_indices.len(), json.tasks.len());
    }

    /// Sanity: the drag genuinely moves the schedule, and `incremental_update`
    /// (stateless) agrees with the typed downstream path — guards against a
    /// vacuous parity test.
    #[test]
    fn typed_downstream_agrees_with_stateless_incremental() {
        let mut project = chain_project();
        let epoch = project.start_date;
        let pg = build_graph(&project).unwrap();
        project.tasks[0].planned_start = Some(NaiveDate::from_ymd_opt(2026, 4, 8).unwrap());

        let stateless = incremental_update(&project, "A").unwrap();
        let mut scratch = project.tasks.clone();
        let typed = compute_downstream_typed(&project, &pg, &mut scratch, epoch, "A").unwrap();

        let stateless_by_id: std::collections::HashMap<&str, &_> =
            stateless.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
        for row in 0..typed.node_indices.len() {
            let node = typed.node_indices[row] as usize;
            let id = project.tasks[node].id.as_str();
            let st = stateless_by_id[id];
            assert_eq!(ord_to_date(typed.early_finish[row], epoch), st.early_finish);
        }
    }
}
