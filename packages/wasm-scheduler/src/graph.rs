//! DAG construction and cycle detection using petgraph.
//!
//! Mirrors the Python `_build_graph` and `_check_cycles` functions.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

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

/// Reconstruct a full cycle path as task ids, entry node repeated at the end.
///
/// Given a `start` node known to participate in a cycle (petgraph's `toposort`
/// returns exactly such a node), walk the graph to recover the concrete cycle so
/// the error reads `A → B → A` — matching Python's `networkx.find_cycle` output —
/// rather than the doubled single node petgraph alone can offer (#1862).
///
/// This runs only on the cyclic error path, never on the happy path, so an
/// explicit iterative DFS (no recursion — a 5,000-task graph would blow the stack)
/// is fine. The `done` set makes it linear: once a node is fully explored without
/// closing a cycle, it is never revisited. If a cycle is somehow not re-found
/// (it always is, since `start` is on one), fall back to the doubled node so the
/// message is still well-formed.
fn reconstruct_cycle_path(graph: &DiGraph<String, usize>, start: NodeIndex) -> Vec<String> {
    let out = |n: NodeIndex| -> Vec<NodeIndex> {
        graph.neighbors_directed(n, Direction::Outgoing).collect()
    };
    let mut path: Vec<NodeIndex> = vec![start];
    let mut frontier: Vec<Vec<NodeIndex>> = vec![out(start)];
    let mut cursor: Vec<usize> = vec![0];
    let mut on_path: HashSet<NodeIndex> = HashSet::from([start]);
    let mut done: HashSet<NodeIndex> = HashSet::new();

    while let Some(depth) = path.len().checked_sub(1) {
        if cursor[depth] < frontier[depth].len() {
            let next = frontier[depth][cursor[depth]];
            cursor[depth] += 1;
            if on_path.contains(&next) {
                // Back-edge into the current DFS path closes the cycle: emit from
                // the re-entry node to the end, then the re-entry node again.
                let pos = path.iter().position(|&n| n == next).expect("node on path");
                let mut cycle: Vec<String> =
                    path[pos..].iter().map(|&n| graph[n].clone()).collect();
                cycle.push(graph[next].clone());
                return cycle;
            }
            if done.contains(&next) {
                continue;
            }
            path.push(next);
            frontier.push(out(next));
            cursor.push(0);
            on_path.insert(next);
        } else {
            let finished = path.pop().expect("non-empty path");
            on_path.remove(&finished);
            done.insert(finished);
            frontier.pop();
            cursor.pop();
        }
    }

    let id = graph[start].clone();
    vec![id.clone(), id]
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
        // petgraph's `toposort` only hands back *one* node that participates in a
        // cycle, so the message used to be a doubled single node ("B → B") while
        // Python's networkx-backed engine reports the full cycle path
        // ("A → B → A"). That was a cross-engine legibility mismatch (#1862): both
        // engines correctly reject, but a user comparing the two saw different
        // cycles. Reconstruct the full path here so the Rust message matches the
        // informative Python form.
        let cycle = reconstruct_cycle_path(&graph, cycle_node.node_id());
        GraphBuildError::Cyclic(CyclicDependencyError { cycle })
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
                ready.push(Reverse((
                    es_of(succ),
                    tasks[succ.index()].id.as_str(),
                    succ,
                )));
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
        let topo_ids: Vec<&str> = pg
            .topo_order
            .iter()
            .map(|&i| pg.graph[i].as_str())
            .collect();
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
        // The cycle must be reported as the full path (e.g. A → B → A), matching
        // Python's networkx.find_cycle form, not a doubled single node (#1862).
        match build_graph(&project) {
            Err(GraphBuildError::Cyclic(err)) => {
                assert_eq!(
                    err.cycle.len(),
                    3,
                    "expected a full A→B→A cycle path, got {:?}",
                    err.cycle
                );
                assert_eq!(
                    err.cycle.first(),
                    err.cycle.last(),
                    "cycle must be closed (first id repeated at the end): {:?}",
                    err.cycle
                );
                let unique: HashSet<&String> = err.cycle.iter().collect();
                assert_eq!(
                    unique,
                    HashSet::from([&"A".to_string(), &"B".to_string()]),
                    "cycle must name both A and B: {:?}",
                    err.cycle
                );
            }
            _ => panic!("expected a cyclic-dependency error"),
        }
    }

    #[test]
    fn test_cycle_detection_reports_full_three_node_path() {
        // A → B → C → A: the reconstructed path must walk all three nodes and
        // close on the entry, never collapse to a doubled single node (#1862).
        let project = Project {
            id: "p1".to_string(),
            name: "Test".to_string(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: vec![make_task("A", 1), make_task("B", 1), make_task("C", 1)],
            dependencies: vec![
                Dependency {
                    predecessor_id: "A".to_string(),
                    successor_id: "B".to_string(),
                    dep_type: DependencyType::FS,
                    lag: 0.0,
                },
                Dependency {
                    predecessor_id: "B".to_string(),
                    successor_id: "C".to_string(),
                    dep_type: DependencyType::FS,
                    lag: 0.0,
                },
                Dependency {
                    predecessor_id: "C".to_string(),
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
        match build_graph(&project) {
            Err(GraphBuildError::Cyclic(err)) => {
                assert_eq!(err.cycle.len(), 4, "expected A→B→C→A, got {:?}", err.cycle);
                assert_eq!(err.cycle.first(), err.cycle.last());
                let unique: HashSet<&String> = err.cycle.iter().collect();
                assert_eq!(
                    unique,
                    HashSet::from([&"A".to_string(), &"B".to_string(), &"C".to_string()])
                );
            }
            _ => panic!("expected a cyclic-dependency error"),
        }
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
