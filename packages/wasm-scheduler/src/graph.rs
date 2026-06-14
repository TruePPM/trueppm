//! DAG construction and cycle detection using petgraph.
//!
//! Mirrors the Python `_build_graph` and `_check_cycles` functions.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

use chrono::NaiveDate;
use petgraph::algo::toposort;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::Direction;

use crate::models::{Dependency, Project, Task};

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
pub struct ProjectGraph {
    pub graph: DiGraph<String, usize>,
    pub node_index: HashMap<String, NodeIndex>,
    pub topo_order: Vec<String>,
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

    let topo_order: Vec<String> = topo_indices.iter().map(|&idx| graph[idx].clone()).collect();

    Ok(ProjectGraph {
        graph,
        node_index,
        topo_order,
    })
}

/// Get the dependency data for an edge between two nodes.
pub fn get_dependency<'a>(
    pg: &ProjectGraph,
    deps: &'a [Dependency],
    pred_id: &str,
    succ_id: &str,
) -> &'a Dependency {
    let pred_idx = pg.node_index[pred_id];
    let succ_idx = pg.node_index[succ_id];
    let edge = pg
        .graph
        .edges_connecting(pred_idx, succ_idx)
        .next()
        .expect("edge must exist between connected nodes");
    &deps[*edge.weight()]
}

/// Get predecessor task IDs for a given node.
pub fn predecessors(pg: &ProjectGraph, task_id: &str) -> Vec<String> {
    let idx = pg.node_index[task_id];
    pg.graph
        .neighbors_directed(idx, Direction::Incoming)
        .map(|n| pg.graph[n].clone())
        .collect()
}

/// Get successor task IDs for a given node.
pub fn successors(pg: &ProjectGraph, task_id: &str) -> Vec<String> {
    let idx = pg.node_index[task_id];
    pg.graph
        .neighbors_directed(idx, Direction::Outgoing)
        .map(|n| pg.graph[n].clone())
        .collect()
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
pub fn lexicographical_topo_order(pg: &ProjectGraph, task_map: &HashMap<String, Task>) -> Vec<String> {
    let es_of = |id: &str| -> NaiveDate {
        task_map[id]
            .early_start
            .expect("early_start is set for every task after the forward pass")
    };
    let mut indegree: HashMap<String, usize> = pg
        .topo_order
        .iter()
        .map(|id| (id.clone(), predecessors(pg, id).len()))
        .collect();
    let mut ready: BinaryHeap<Reverse<(NaiveDate, String)>> = pg
        .topo_order
        .iter()
        .filter(|id| indegree[*id] == 0)
        .map(|id| Reverse((es_of(id), id.clone())))
        .collect();

    let mut order = Vec::with_capacity(pg.topo_order.len());
    while let Some(Reverse((_, id))) = ready.pop() {
        for succ in successors(pg, &id) {
            if let Some(d) = indegree.get_mut(&succ) {
                *d -= 1;
                if *d == 0 {
                    ready.push(Reverse((es_of(&succ), succ)));
                }
            }
        }
        order.push(id);
    }
    order
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Calendar, DependencyType, Task};

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
            optimistic_duration: None,
            most_likely_duration: None,
            pessimistic_duration: None,
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
        };
        let pg = build_graph(&project).unwrap();
        assert_eq!(pg.topo_order, vec!["A", "B"]);
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
        };
        assert!(matches!(
            build_graph(&project),
            Err(GraphBuildError::UnknownDependencyTask { .. })
        ));
    }
}
