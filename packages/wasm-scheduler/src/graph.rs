//! DAG construction and cycle detection using petgraph.
//!
//! Mirrors the Python `_build_graph` and `_check_cycles` functions.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use chrono::NaiveDate;
use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::models::{Project, Task};

/// An error indicating a cycle was detected in the dependency graph.
#[derive(Debug, Clone)]
pub struct CyclicDependencyError {
    pub cycle: Vec<String>,
}

impl std::fmt::Display for CyclicDependencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Cyclic dependency detected: {}", self.cycle.join(" → "))
    }
}

/// Anything `build_graph` can reject. A Rust `panic!` in WASM traps the entire
/// module — every later call fails until the page reloads (#1087) — so a
/// dependency that names a task id with no matching task must surface as an
/// `Err` (mapped to a JS exception in `lib.rs`), never a panic. Mirrors the
/// Python `_build_graph`, which raises `InvalidScheduleInput` for the same input.
#[derive(Debug, Clone)]
pub enum GraphBuildError {
    /// A dependency references a predecessor or successor id with no matching task.
    UnknownDependencyTask {
        predecessor_id: String,
        successor_id: String,
    },
    /// A cycle was detected during topological sort.
    Cyclic(CyclicDependencyError),
}

impl std::fmt::Display for GraphBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GraphBuildError::UnknownDependencyTask {
                predecessor_id,
                successor_id,
            } => write!(
                f,
                "Dependency references unknown task: {predecessor_id:?} → {successor_id:?}"
            ),
            GraphBuildError::Cyclic(e) => e.fmt(f),
        }
    }
}

/// The built dependency graph, with index mappings for fast lookup.
///
/// Nodes are added in `project.tasks` order, so `NodeIndex::index()` doubles as
/// the task's dense position: the CPM passes carry tasks in a parallel
/// `Vec<Task>` and index it by node position, never by string id (#1535). Edge
/// weights are `project.dependencies` indices, so an edge *is* its dependency —
/// the passes read `deps[*edge.weight()]` directly with no id-keyed lookup.
pub struct ProjectGraph {
    /// Node weight is the task id (used only for cycle-error messages); edge
    /// weight is the index into `project.dependencies`.
    pub graph: DiGraph<String, usize>,
    /// Id → node index. Built once; used at graph-build time and to resolve an
    /// externally-supplied id (e.g. the incremental drag's changed task). Not on
    /// the per-pass hot path.
    pub node_index: HashMap<String, NodeIndex>,
    /// Topological order as dense node indices (#1535): the passes iterate these
    /// and index the parallel task vec directly, with no string hashing per node.
    pub topo_order: Vec<NodeIndex>,
}

/// Build a directed graph from the project's tasks and dependencies.
///
/// Edge weights are indices into `project.dependencies` for later lookup.
///
/// Returns the graph, node index map, and topological order.
/// Returns `Err` for a dependency referencing an unknown task or for a cycle.
pub fn build_graph(project: &Project) -> Result<ProjectGraph, GraphBuildError> {
    let mut graph = DiGraph::<String, usize>::new();
    let mut node_index = HashMap::new();
    let task_ids: std::collections::HashSet<&str> =
        project.tasks.iter().map(|t| t.id.as_str()).collect();

    for task in &project.tasks {
        let idx = graph.add_node(task.id.clone());
        node_index.insert(task.id.clone(), idx);
    }

    for (dep_idx, dep) in project.dependencies.iter().enumerate() {
        if !task_ids.contains(dep.predecessor_id.as_str())
            || !task_ids.contains(dep.successor_id.as_str())
        {
            return Err(GraphBuildError::UnknownDependencyTask {
                predecessor_id: dep.predecessor_id.clone(),
                successor_id: dep.successor_id.clone(),
            });
        }
        let pred = node_index[&dep.predecessor_id];
        let succ = node_index[&dep.successor_id];
        graph.add_edge(pred, succ, dep_idx);
    }

    // Check for cycles via topological sort
    let topo_indices = toposort(&graph, None).map_err(|cycle_node| {
        // Extract a cycle from the graph for the error message
        let cycle_id = graph[cycle_node.node_id()].clone();
        GraphBuildError::Cyclic(CyclicDependencyError {
            cycle: vec![cycle_id.clone(), cycle_id],
        })
    })?;

    // Dense node indices — the passes carry a parallel `Vec<Task>` and index it
    // by `NodeIndex::index()`, so no per-node string is materialized here (#1535).
    let topo_order: Vec<NodeIndex> = topo_indices;

    Ok(ProjectGraph {
        graph,
        node_index,
        topo_order,
    })
}

/// Critical-path order: a lexicographic topological sort keyed by
/// `(early_start, id)` (#909).
///
/// Filtering any topological order already keeps a predecessor ahead of its
/// successor, but petgraph's `toposort` tie-break differs from networkx's, so a
/// plain filtered `topo_order` is cross-engine non-deterministic. Sorting the
/// filtered list by `(early_start, id)` *value* restores determinism but can
/// invert an edge-connected critical pair that shares an `early_start` (e.g. an
/// SS-lag-0 link, where the successor starts the same day as its predecessor).
/// A lexicographic Kahn — the ready set is a min-heap on `(early_start, id)` —
/// is simultaneously deterministic AND a valid topological order. Because task
/// ids are unique the key never ties, so the result depends only on
/// `(early_start, id)` and is identical to the Python engine's
/// `networkx.lexicographical_topological_sort(g, key=(early_start, id))`.
///
/// Dense-index Kahn (#1535): indegree is a `Vec<u32>` indexed by node position
/// and the ready set is a min-heap over node indices. The heap key stays
/// `(early_start, id)` — the id is the task's *string* id, not its node index —
/// so the tie-break is identical to the Python engine's
/// `networkx.lexicographical_topological_sort(g, key=(early_start, id))`. Keying
/// the heap by node index instead would break cross-engine determinism whenever
/// two ready tasks share an `early_start` but sit in a different insertion order
/// than their ids sort (#909), so the id string is retained — borrowed from
/// `tasks`, never cloned. Returns node indices; the caller maps to ids.
pub fn lexicographical_topo_order(pg: &ProjectGraph, tasks: &[Task]) -> Vec<NodeIndex> {
    let es_of = |idx: NodeIndex| -> NaiveDate {
        tasks[idx.index()]
            .early_start
            .expect("early_start is set for every task after the forward pass")
    };
    let mut indegree: Vec<u32> = vec![0; tasks.len()];
    for idx in pg.graph.node_indices() {
        indegree[idx.index()] = pg
            .graph
            .neighbors_directed(idx, Direction::Incoming)
            .count() as u32;
    }
    // Heap key `(early_start, &id, idx)`: ordered by (date, id) exactly as before;
    // the trailing index only carries the node through the heap and never ties
    // because ids are unique.
    let mut ready: BinaryHeap<Reverse<(NaiveDate, &str, NodeIndex)>> = pg
        .graph
        .node_indices()
        .filter(|&idx| indegree[idx.index()] == 0)
        .map(|idx| Reverse((es_of(idx), tasks[idx.index()].id.as_str(), idx)))
        .collect();

    let mut order = Vec::with_capacity(tasks.len());
    while let Some(Reverse((_, _, idx))) = ready.pop() {
        for edge in pg.graph.edges_directed(idx, Direction::Outgoing) {
            let succ = edge.target();
            let d = &mut indegree[succ.index()];
            *d -= 1;
            if *d == 0 {
                ready.push(Reverse((es_of(succ), tasks[succ.index()].id.as_str(), succ)));
            }
        }
        order.push(idx);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Calendar, Dependency, DependencyType, Task};

    fn make_task(id: &str, duration_days: i32) -> Task {
        Task {
            id: id.to_string(),
            name: id.to_string(),
            duration: duration_days as f64 * 86400.0,
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

    #[test]
    fn test_build_simple_graph() {
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "B".to_string(),
                dep_type: DependencyType::FS,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        };
        let pg = build_graph(&project).unwrap();
        let topo_ids: Vec<&str> = pg.topo_order.iter().map(|&i| pg.graph[i].as_str()).collect();
        assert_eq!(topo_ids, vec!["A", "B"]);
    }

    #[test]
    fn test_cycle_detection() {
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5), make_task("B", 3)],
            dependencies: vec![
                Dependency {
                    predecessor_id: "A".to_string(),
                    successor_id: "B".to_string(),
                    dep_type: DependencyType::FS,
                    lag: 0.0,
                },
                Dependency {
                    predecessor_id: "B".to_string(),
                    successor_id: "A".to_string(),
                    dep_type: DependencyType::FS,
                    lag: 0.0,
                },
            ],
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        };
        assert!(build_graph(&project).is_err());
    }

    #[test]
    fn test_unknown_dependency_task_errors_not_panics() {
        // #1087: a dependency naming a task id with no matching task used to
        // `panic!`, trapping the WASM module. It must return `Err` instead.
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 5)],
            dependencies: vec![Dependency {
                predecessor_id: "A".to_string(),
                successor_id: "GHOST".to_string(),
                dep_type: DependencyType::FS,
                lag: 0.0,
            }],
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        };
        assert!(matches!(
            build_graph(&project),
            Err(GraphBuildError::UnknownDependencyTask { .. })
        ));
    }
}
