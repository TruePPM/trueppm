//! DAG construction and cycle detection using petgraph.
//!
//! Mirrors the Python `_build_graph` and `_check_cycles` functions.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use chrono::NaiveDate;
use petgraph::algo::{tarjan_scc, toposort};
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use crate::models::{Project, Task};

/// Most ids a cycle message lists before collapsing the rest to `… (+M more)`.
/// Mirrors Python's `_CYCLE_MSG_MAX_IDS`.
const CYCLE_MSG_MAX_IDS: usize = 10;
/// Longest `repr()`-style rendering of one id, in characters. Mirrors Python's
/// `_CYCLE_MSG_ID_CHARS`.
const CYCLE_MSG_ID_CHARS: usize = 80;

/// Whether Python's `str.isprintable()` would call `c` printable.
///
/// ASCII is exact. Beyond ASCII, Rust's std carries no Unicode general-category
/// table, so this approximates Python's rule (non-printable = categories Cc, Cf,
/// Cs, Co, Cn, Zl, Zp, Zs other than the ASCII space) with: Cc via
/// `is_control`, Zs/Zl/Zp via `is_whitespace`, the Cf code points listed below,
/// and the private-use planes. Residual divergence: unassigned (Cn) code points,
/// which Python escapes and this function prints verbatim, and any Cf added by a
/// Unicode release newer than the table below. Real task ids are ASCII or
/// ordinary letters, so the exotic tail is not exercised by the conformance
/// fixtures.
fn is_printable(c: char) -> bool {
    if c.is_ascii() {
        return (' '..='~').contains(&c);
    }
    let u = c as u32;
    if c.is_control() || c.is_whitespace() {
        return false;
    }
    let format_chars = matches!(u,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891
        | 0x08E2 | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064
        | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD
        | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A
        | 0xE0001 | 0xE0020..=0xE007F);
    let private_use = matches!(u, 0xE000..=0xF8FF | 0xF_0000..=0xF_FFFD | 0x10_0000..=0x10_FFFD);
    !(format_chars || private_use)
}

/// Render `s` the way Python's `repr(str)` does: quoted with `'` unless the
/// text holds a `'` and no `"`, in which case `"`; `\`, the chosen quote,
/// `\t \n \r` and non-printable characters escaped (`\xNN`, `\uNNNN`,
/// `\UNNNNNNNN`). See [`is_printable`] for the one known divergence.
fn py_repr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if is_printable(c) => out.push(c),
            c => {
                let u = c as u32;
                if u < 0x100 {
                    out.push_str(&format!("\\x{u:02x}"));
                } else if u < 0x10000 {
                    out.push_str(&format!("\\u{u:04x}"));
                } else {
                    out.push_str(&format!("\\U{u:08x}"));
                }
            }
        }
    }
    out.push(quote);
    out
}

/// `py_repr` cut to `CYCLE_MSG_ID_CHARS` characters, ending in `…` when cut.
fn short_repr(id: &str) -> String {
    let text = py_repr(id);
    if text.chars().count() > CYCLE_MSG_ID_CHARS {
        let mut cut: String = text.chars().take(CYCLE_MSG_ID_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        text
    }
}

/// An error indicating a cycle was detected in the dependency graph.
///
/// `cycle` is the canonical path (first id repeated at the end). `Display` is a
/// bounded, escaped rendering of it, byte-identical to Python's
/// `CyclicDependencyError` message (#4729, #4781): each id `repr()`-escaped so a
/// control character cannot forge a log line, at most 10 ids listed, then
/// ` … (+M more)`.
#[derive(Debug, Clone)]
pub struct CyclicDependencyError {
    pub cycle: Vec<String>,
}

impl std::fmt::Display for CyclicDependencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let shown: Vec<String> = self
            .cycle
            .iter()
            .take(CYCLE_MSG_MAX_IDS)
            .map(|id| short_repr(id))
            .collect();
        write!(f, "Cyclic dependency detected: {}", shown.join(" → "))?;
        if self.cycle.len() > CYCLE_MSG_MAX_IDS {
            write!(f, " … (+{} more)", self.cycle.len() - CYCLE_MSG_MAX_IDS)?;
        }
        Ok(())
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

/// Return one cycle of `graph`, independent of node/edge insertion order.
///
/// Mirrors Python's `_canonical_cycle` exactly so both engines report the same
/// payload for the same graph (#4781): pick the non-trivial strongly connected
/// component (size > 1, or a self-loop) holding the smallest id, then the
/// shortest cycle through that id found by BFS over successors sorted by id,
/// starting at that id and closing by repeating it. Ids compare as `String`s,
/// i.e. by UTF-8 bytes, which orders identically to Python's code-point order.
///
/// Runs only on the cyclic error path. Iterative (no recursion), so a
/// 5,000-task graph cannot blow the stack.
fn canonical_cycle(graph: &DiGraph<String, usize>) -> Vec<String> {
    let sccs: Vec<Vec<NodeIndex>> = tarjan_scc(graph)
        .into_iter()
        .filter(|c| c.len() > 1 || c.iter().any(|&n| graph.contains_edge(n, n)))
        .collect();
    let start = sccs
        .iter()
        .flat_map(|c| c.iter().copied())
        .min_by(|&a, &b| graph[a].cmp(&graph[b]))
        .expect("canonical_cycle called on an acyclic graph");
    let scc: HashSet<NodeIndex> = sccs
        .iter()
        .find(|c| c.contains(&start))
        .expect("start is in an scc")
        .iter()
        .copied()
        .collect();

    let mut parent: HashMap<NodeIndex, Option<NodeIndex>> = HashMap::from([(start, None)]);
    let mut queue: Vec<NodeIndex> = vec![start];
    let mut closer: Option<NodeIndex> = None;
    let mut head = 0;
    'bfs: while head < queue.len() {
        let node = queue[head];
        head += 1;
        let mut succ: Vec<NodeIndex> = graph
            .neighbors_directed(node, Direction::Outgoing)
            .collect();
        succ.sort_by(|&a, &b| graph[a].cmp(&graph[b]));
        for nxt in succ {
            if nxt == start {
                closer = Some(node);
                break 'bfs;
            }
            if scc.contains(&nxt) && !parent.contains_key(&nxt) {
                parent.insert(nxt, Some(node));
                queue.push(nxt);
            }
        }
    }

    let mut path: Vec<String> = Vec::new();
    let mut cur = closer;
    while let Some(n) = cur {
        path.push(graph[n].clone());
        cur = parent[&n];
    }
    path.reverse();
    path.push(graph[start].clone());
    path
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
    let topo_indices = toposort(&graph, None).map_err(|_| {
        // petgraph's `toposort` names only one arbitrary node on a cycle, so the
        // reported cycle is rebuilt canonically (see `canonical_cycle`) to match
        // Python's choice rather than depend on petgraph's traversal order.
        GraphBuildError::Cyclic(CyclicDependencyError {
            cycle: canonical_cycle(&graph),
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
            scheduled_start: None,
            milestone_at_day_end: false,
            live_day_end_on: None,
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

    fn err_for(ids: &[&str], edges: &[(&str, &str)]) -> CyclicDependencyError {
        let project = Project {
            id: "p".to_string(),
            name: "t".to_string(),
            start_date: chrono::NaiveDate::from_ymd_opt(2026, 4, 1).unwrap(),
            tasks: ids.iter().map(|i| make_task(i, 1)).collect(),
            dependencies: edges
                .iter()
                .map(|(a, b)| Dependency {
                    predecessor_id: a.to_string(),
                    successor_id: b.to_string(),
                    dep_type: DependencyType::FS,
                    lag: 0.0,
                })
                .collect(),
            calendar: Calendar::default(),
            status_date: None,
            calendars: None,
            velocity_samples: None,
            sprint_length_days: None,
        };
        match build_graph(&project) {
            Err(GraphBuildError::Cyclic(e)) => e,
            _ => panic!("expected a cycle"),
        }
    }

    #[test]
    fn canonical_cycle_ignores_insertion_order_and_picks_smallest_scc() {
        // Two disjoint cycles; Z<->Y is listed first but B<->C holds the smaller id.
        let e = err_for(
            &["Z", "Y", "C", "B"],
            &[("Z", "Y"), ("Y", "Z"), ("C", "B"), ("B", "C")],
        );
        assert_eq!(e.cycle, vec!["B", "C", "B"]);
        // Same graph, reversed declaration order: identical payload.
        let r = err_for(
            &["B", "C", "Y", "Z"],
            &[("B", "C"), ("C", "B"), ("Y", "Z"), ("Z", "Y")],
        );
        assert_eq!(r.cycle, e.cycle);
    }

    #[test]
    fn canonical_cycle_is_shortest_through_the_start_id() {
        let e = err_for(
            &["A", "B", "C", "D", "E"],
            &[
                ("A", "B"),
                ("B", "C"),
                ("C", "D"),
                ("D", "A"),
                ("A", "E"),
                ("E", "D"),
            ],
        );
        assert_eq!(e.cycle, vec!["A", "E", "D", "A"]);
    }

    #[test]
    fn message_escapes_truncates_and_counts_like_python() {
        assert_eq!(py_repr("it's"), "\"it's\"");
        assert_eq!(py_repr("q'\"both"), "'q\\'\"both'");
        assert_eq!(py_repr("a\tb\nc\\d"), "'a\\tb\\nc\\\\d'");
        assert_eq!(py_repr("\u{7f}\u{1}"), "'\\x7f\\x01'");
        assert_eq!(
            py_repr("é\u{a0}\u{200b}\u{1F600}"),
            "'é\\xa0\\u200b\u{1F600}'"
        );
        assert_eq!(short_repr(&"L".repeat(100)).chars().count(), 80);
        assert!(short_repr(&"L".repeat(100)).ends_with('…'));

        let ids: Vec<String> = (0..12).map(|i| format!("t{i:02}")).collect();
        let e = CyclicDependencyError { cycle: ids };
        let msg = e.to_string();
        assert!(msg.ends_with("'t09' … (+2 more)"), "{msg}");
        assert!(!msg.contains("t10"));
        // Exactly 10 ids: no suffix.
        let e = CyclicDependencyError {
            cycle: (0..10).map(|i| format!("t{i}")).collect(),
        };
        assert!(!e.to_string().contains("more"));
    }

    /// Cross-engine oracle (#4781): `fixtures/cycle_errors/expected/*.json` is
    /// generated from Python and asserted by `test_wasm_conformance.py` too, so
    /// both engines must report the same cycle payload and message.
    #[test]
    fn cycle_error_fixtures_match_python_oracle() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join("cycle_errors");
        let mut n = 0;
        for entry in std::fs::read_dir(&dir).expect("cycle_errors dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let stem = path.file_stem().unwrap().to_str().unwrap().to_string();
            let project: Project =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let expected: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join("expected").join(format!("{stem}.json")))
                    .unwrap(),
            )
            .unwrap();
            let Err(GraphBuildError::Cyclic(e)) = build_graph(&project) else {
                panic!("{stem}: expected a cycle");
            };
            let want: Vec<String> = expected["cycle"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(e.cycle, want, "{stem}: cycle payload");
            assert_eq!(
                e.to_string(),
                expected["message"].as_str().unwrap(),
                "{stem}: message"
            );
            n += 1;
        }
        assert!(n >= 3, "cycle_errors fixtures missing (found {n})");
    }
}
