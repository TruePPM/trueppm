"""Rendering-neutral graph export of a computed schedule (#4894).

:func:`to_graph` flattens a :class:`~trueppm_scheduler.ScheduleResult` and the
:class:`~trueppm_scheduler.Project` it came from into plain nodes and edges that
any renderer (Mermaid, Graphviz, a notebook plot, a web canvas) can draw without
knowing anything about the engine. It is a pure function of an existing result:
no CPM arithmetic happens here, so the Python and Rust engines are untouched.

Format contract (``GRAPH_FORMAT_VERSION``)
------------------------------------------
``GraphExport.to_dict()`` emits exactly these keys, and a change to any of them
bumps :data:`GRAPH_FORMAT_VERSION`:

* top level: ``format_version``, ``project_id``, ``project_start``,
  ``project_finish`` (ISO ``YYYY-MM-DD``), ``nodes``, ``edges``.
* node: ``id``, ``name``, ``early_start``, ``early_finish``, ``late_start``,
  ``late_finish`` (ISO dates), ``total_float_days`` (float, working days of the
  task's calendar), ``is_critical`` (bool), ``milestone_at_day_end`` (bool).
* edge: ``predecessor_id``, ``successor_id``, ``dep_type`` (``"FS"``, ``"SS"``,
  ``"FF"`` or ``"SF"``), ``lag_days`` (float, calendar days; negative is a lead),
  ``is_driving`` (bool).

``is_driving`` is membership of the edge in ``ScheduleResult.driving_edges``,
whose three-field shape (:class:`~trueppm_scheduler.DrivingEdge`) is part of this
contract. Nodes are sorted by id and edges by
``(predecessor_id, successor_id, dep_type, lag_days)``, so the same schedule always
serializes to the same bytes.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from dataclasses import (
    dataclass,
)
from datetime import (
    date,
    timedelta,
)
from typing import (
    Any,
)

from trueppm_scheduler._slots import pickle_as_field_dict
from trueppm_scheduler.engine.errors import (
    CyclicDependencyError,
    InvalidScheduleInput,
)
from trueppm_scheduler.engine.graph import (
    find_cycle,
)
from trueppm_scheduler.engine.limits import (
    MAX_DEPENDENCIES,
)
from trueppm_scheduler.engine.results import (
    ScheduleResult,
)
from trueppm_scheduler.models import (
    DependencyType,
    Project,
    _parse_date,
    _reject_duplicate_keys,
    _reject_nonfinite,
    _short_repr,
)

GRAPH_FORMAT_VERSION = 1
"""Version of the :class:`GraphExport` dict/JSON shape; bumped on any key change."""

_DEP_TYPES = frozenset(t.value for t in DependencyType)
_SECONDS_PER_DAY = 86400.0


def _days(value: timedelta) -> float:
    return value.total_seconds() / _SECONDS_PER_DAY


@pickle_as_field_dict
@dataclass(frozen=True, slots=True)
class GraphNode:
    """One task in a :class:`GraphExport`.

    Attributes:
        id: Task id.
        name: Task name.
        early_start: Earliest start of the remaining work.
        early_finish: Earliest finish.
        late_start: Latest start that does not delay the project finish.
        late_finish: Latest finish that does not delay the project finish.
        total_float_days: Total float in working days of the task's calendar
            (not calendar days, unlike ``GraphEdge.lag_days``).
        is_critical: Mirrors ``ScheduleResult`` ``is_critical``; completed tasks
            are never critical, even at zero float.
        milestone_at_day_end: For a zero-duration milestone, whether the instant
            is the end (``True``) or the start (``False``) of ``early_finish``.
    """

    id: str
    name: str
    early_start: date
    early_finish: date
    late_start: date
    late_finish: date
    total_float_days: float
    is_critical: bool
    milestone_at_day_end: bool

    def to_dict(self) -> dict[str, Any]:
        """Return this node as a JSON-serializable dict (dates as ISO strings)."""
        return {
            "id": self.id,
            "name": self.name,
            "early_start": self.early_start.isoformat(),
            "early_finish": self.early_finish.isoformat(),
            "late_start": self.late_start.isoformat(),
            "late_finish": self.late_finish.isoformat(),
            "total_float_days": self.total_float_days,
            "is_critical": self.is_critical,
            "milestone_at_day_end": self.milestone_at_day_end,
        }


@pickle_as_field_dict
@dataclass(frozen=True, slots=True)
class GraphEdge:
    """One dependency in a :class:`GraphExport`.

    Attributes:
        predecessor_id: Id of the constraining task.
        successor_id: Id of the constrained task.
        dep_type: The link's :class:`~trueppm_scheduler.DependencyType`
            (``"FS"``, ``"SS"``, ``"FF"`` or ``"SF"``).
        lag_days: Lag in calendar days (negative is a lead).
        is_driving: ``True`` when the link is in ``ScheduleResult.driving_edges``:
            it binds its successor or has zero relationship free float.
    """

    predecessor_id: str
    successor_id: str
    dep_type: DependencyType
    lag_days: float
    is_driving: bool

    def to_dict(self) -> dict[str, Any]:
        """Return this edge as a JSON-serializable dict."""
        return {
            "predecessor_id": self.predecessor_id,
            "successor_id": self.successor_id,
            "dep_type": str(self.dep_type),
            "lag_days": self.lag_days,
            "is_driving": self.is_driving,
        }


@pickle_as_field_dict
@dataclass(frozen=True, slots=True)
class GraphExport:
    """A schedule as plain nodes and edges, safe to serialize and re-load.

    Build one with :func:`to_graph`; round-trip it with :meth:`to_json` /
    :meth:`from_json`. The key set is frozen under ``format_version`` (see the
    module docstring).

    Attributes:
        project_id: Id of the scheduled project.
        project_start: The date the schedule is anchored to.
        project_finish: The latest ``early_finish`` (a day, not an instant).
        nodes: One node per task, sorted by id.
        edges: One edge per dependency, sorted deterministically.
        format_version: :data:`GRAPH_FORMAT_VERSION` this export was built under.
    """

    project_id: str
    project_start: date
    project_finish: date
    nodes: tuple[GraphNode, ...]
    edges: tuple[GraphEdge, ...]
    format_version: int = GRAPH_FORMAT_VERSION

    def to_dict(self) -> dict[str, Any]:
        """Return the export as a JSON-serializable dict (the frozen shape)."""
        return {
            "format_version": self.format_version,
            "project_id": self.project_id,
            "project_start": self.project_start.isoformat(),
            "project_finish": self.project_finish.isoformat(),
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
        }

    def to_json(self, **kwargs: Any) -> str:
        """Serialize to a JSON string.

        Args:
            **kwargs: Passed to :func:`json.dumps` (for example ``indent=2``).

        Returns:
            The JSON document for :meth:`to_dict`.
        """
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> GraphExport:
        """Rebuild an export from a :meth:`to_dict` mapping.

        Args:
            data: A mapping produced by :meth:`to_dict` (or its JSON form).

        Returns:
            The reconstructed :class:`GraphExport`.

        Raises:
            InvalidScheduleInput: If ``data`` is malformed, carries an unsupported
                ``format_version`` (it must be the integer ``1``; ``1.0`` is
                refused), has a key the format does not define at the top level,
                on a node or on an edge, has more than ``MAX_DEPENDENCIES`` nodes
                or edges (checked before any per-item work), repeats a node id,
                or has an edge naming an id that is not a node (the ids are named
                in the message).
            CyclicDependencyError: If the edges contain a cycle; ``cycle`` names
                the ids on it. No partial graph is returned.

        Note:
            Deliberately accepted, because the export side never guarantees the
            opposite and a hand-edited or third-party document is still drawable:
            nodes and edges in any order (sorting is an export-side determinism
            promise, not a load-side requirement), a node whose ``early_start`` is
            after its ``early_finish``, and a ``project_start`` after
            ``project_finish``. The loader checks structure, not schedule
            plausibility; do not treat a loaded export as a verified schedule.
        """
        try:
            return cls._from_dict(data)
        except (KeyError, TypeError, AttributeError, ValueError) as err:
            if isinstance(err, InvalidScheduleInput | CyclicDependencyError):
                raise
            raise InvalidScheduleInput(f"Malformed graph export: {_short_repr(err)}") from err

    @classmethod
    def _from_dict(cls, data: dict[str, Any]) -> GraphExport:
        version = data["format_version"]
        # ``1.0 == 1`` in Python, so the type is checked too: the format is
        # versioned by integer and a float spelling is a different document.
        if type(version) is not int or version != GRAPH_FORMAT_VERSION:
            raise InvalidScheduleInput(
                f"Unsupported graph export format_version {_short_repr(version)}; "
                f"this release reads version {GRAPH_FORMAT_VERSION}."
            )
        _require_keys(data, _TOP_KEYS, "graph export")
        raw_nodes, raw_edges = data["nodes"], data["edges"]
        if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
            raise InvalidScheduleInput("Graph export nodes and edges must be lists.")
        # Length checks come before any per-item parse so a huge document costs
        # O(1) to refuse; MAX_DEPENDENCIES is the library's existing graph-size cap.
        for what, items in (("nodes", raw_nodes), ("edges", raw_edges)):
            if len(items) > MAX_DEPENDENCIES:
                raise InvalidScheduleInput(
                    f"Graph export has {len(items)} {what}, over the maximum of {MAX_DEPENDENCIES}."
                )
        nodes = tuple(_node_from_dict(n) for n in raw_nodes)
        edges = tuple(_edge_from_dict(e) for e in raw_edges)
        export = cls(
            project_id=_req_str(data["project_id"], "project_id"),
            project_start=_parse_date(data["project_start"], "project_start"),
            project_finish=_parse_date(data["project_finish"], "project_finish"),
            nodes=nodes,
            edges=edges,
        )
        _check_graph(
            [n.id for n in nodes],
            [(e.predecessor_id, e.successor_id) for e in edges],
        )
        return export

    @classmethod
    def from_json(cls, text: str) -> GraphExport:
        """Rebuild an export from a :meth:`to_json` string.

        Args:
            text: The JSON document.

        Returns:
            The reconstructed :class:`GraphExport`.

        Raises:
            InvalidScheduleInput: If ``text`` is not valid JSON, is nested too
                deeply to parse, repeats a JSON object key (the last value would
                otherwise win silently, as :meth:`Project.from_json` also refuses),
                contains ``NaN``/``Infinity``, or fails the checks listed on
                :meth:`from_dict`.
            CyclicDependencyError: If the edges contain a cycle.
        """
        try:
            data = json.loads(
                text,
                parse_constant=_reject_nonfinite,
                object_pairs_hook=_reject_duplicate_keys,
            )
        except (ValueError, TypeError) as err:
            raise InvalidScheduleInput(f"Graph export is not valid JSON: {err}") from err
        except RecursionError as err:
            # Deep nesting overflows the parser's C recursion limit and RecursionError
            # is neither ValueError nor TypeError; mirror Project.from_json (#1207).
            raise InvalidScheduleInput("Graph export JSON is nested too deeply to parse.") from err
        if not isinstance(data, dict):
            raise InvalidScheduleInput("Graph export JSON must be an object.")
        return cls.from_dict(data)


_TOP_KEYS = frozenset(
    {"format_version", "project_id", "project_start", "project_finish", "nodes", "edges"}
)
_NODE_KEYS = frozenset(
    {
        "id",
        "name",
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float_days",
        "is_critical",
        "milestone_at_day_end",
    }
)
_EDGE_KEYS = frozenset({"predecessor_id", "successor_id", "dep_type", "lag_days", "is_driving"})


def _require_keys(d: dict[str, Any], allowed: frozenset[str], what: str) -> None:
    """Refuse a key the format does not define, so a typo or a newer document is loud."""
    extra = sorted(k for k in d if k not in allowed)
    if extra:
        raise InvalidScheduleInput(
            f"Unknown key(s) in {what}: " + ", ".join(_short_repr(k) for k in extra)
        )


def _req_str(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise InvalidScheduleInput(f"{name} must be a string, got {_short_repr(value)}.")
    return value


def _req_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise InvalidScheduleInput(f"{name} must be a bool, got {_short_repr(value)}.")
    return value


def _req_days(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise InvalidScheduleInput(f"{name} must be a finite number, got {_short_repr(value)}.")
    return float(value)


def _node_from_dict(d: dict[str, Any]) -> GraphNode:
    _require_keys(d, _NODE_KEYS, "graph node")
    return GraphNode(
        id=_req_str(d["id"], "node id"),
        name=_req_str(d["name"], "node name"),
        early_start=_parse_date(d["early_start"], "early_start"),
        early_finish=_parse_date(d["early_finish"], "early_finish"),
        late_start=_parse_date(d["late_start"], "late_start"),
        late_finish=_parse_date(d["late_finish"], "late_finish"),
        total_float_days=_req_days(d["total_float_days"], "total_float_days"),
        is_critical=_req_bool(d["is_critical"], "is_critical"),
        milestone_at_day_end=_req_bool(d["milestone_at_day_end"], "milestone_at_day_end"),
    )


def _edge_from_dict(d: dict[str, Any]) -> GraphEdge:
    _require_keys(d, _EDGE_KEYS, "graph edge")
    dep_type = _req_str(d["dep_type"], "dep_type")
    if dep_type not in _DEP_TYPES:
        raise InvalidScheduleInput(f"Unknown dep_type {_short_repr(dep_type)} on graph edge.")
    return GraphEdge(
        predecessor_id=_req_str(d["predecessor_id"], "predecessor_id"),
        successor_id=_req_str(d["successor_id"], "successor_id"),
        dep_type=DependencyType(dep_type),
        lag_days=_req_days(d["lag_days"], "lag_days"),
        is_driving=_req_bool(d["is_driving"], "is_driving"),
    )


def _check_graph(node_ids: list[str], edges: list[tuple[str, str]]) -> None:
    """Refuse duplicate ids, dangling edge endpoints and cycles; never return partially.

    Reuses :func:`find_cycle` rather than a second detector, so the cycle the error
    names is the canonical one the engine itself would report.
    """
    seen = set(node_ids)
    # One Counter pass: the old per-id ``list.count`` made the error path O(n^2).
    dupes = (
        sorted(i for i, n in Counter(node_ids).items() if n > 1)
        if len(seen) < len(node_ids)
        else []
    )
    if dupes:
        raise InvalidScheduleInput(
            "Duplicate task id(s) in graph: " + ", ".join(_short_repr(i) for i in dupes)
        )
    unknown = sorted({i for edge in edges for i in edge if i not in seen})
    if unknown:
        raise InvalidScheduleInput(
            "Dependency references unknown task id(s): "
            + ", ".join(_short_repr(i) for i in unknown)
        )
    check = find_cycle(edges)
    if check.cycle is not None:
        raise CyclicDependencyError(check.cycle)


def to_graph(result: ScheduleResult, project: Project) -> GraphExport:
    """Export a computed schedule as rendering-neutral nodes and edges.

    A pure read of ``result`` and ``project.dependencies``: it adds no scheduling
    math, so it cannot disagree with :func:`~trueppm_scheduler.schedule`. Pass the
    project that was scheduled; a result and project that do not match are refused
    rather than blended.

    What "do not match" covers: the project id, the task-id set (a task added to or
    removed from the project after scheduling), and every driving edge in
    ``result`` (each must still be a dependency of ``project`` with the same
    predecessor, successor and type, so a changed link type is refused). What it
    cannot detect, because ``ScheduleResult`` records only the *driving* links and
    not their lags: a changed lag, or a new or removed non-driving link, between
    the same tasks. Task names and dates are always read from ``result``. Re-run
    ``schedule()`` whenever the project changes rather than relying on this check.

    Args:
        result: The :class:`ScheduleResult` returned by ``schedule(project)``.
        project: The :class:`Project` that was scheduled, supplying each
            dependency's type and lag.

    Returns:
        A :class:`GraphExport` with one node per task and one edge per
        dependency, deterministically ordered.

    Raises:
        InvalidScheduleInput: If ``result`` is not a :class:`ScheduleResult` or
            ``project`` is not a :class:`Project`, if ``result`` was not computed
            from ``project`` (a different project id, a different task-id set, or
            a driving edge that is not a dependency of ``project``), a task has
            no computed dates, a task id is repeated, or a dependency names a
            task that is not in ``result``. The offending ids are named in the
            message.
        CyclicDependencyError: If the dependencies contain a cycle; ``cycle``
            names the ids on it. No partial graph is emitted.
    """
    if not isinstance(project, Project):
        raise InvalidScheduleInput(f"project must be a Project (got {type(project).__name__}).")
    if not isinstance(result, ScheduleResult):
        raise InvalidScheduleInput(
            f"result must be a ScheduleResult (got {type(result).__name__})."
        )
    if result.project_id != project.id:
        raise InvalidScheduleInput(
            f"Result is for project {_short_repr(result.project_id)}, "
            f"not {_short_repr(project.id)}."
        )
    result_ids = {t.id for t in result.tasks}
    project_ids = {t.id for t in project.tasks}
    if result_ids != project_ids:
        parts = []
        if project_ids - result_ids:
            parts.append(
                "in project but not result: "
                + ", ".join(_short_repr(i) for i in sorted(project_ids - result_ids))
            )
        if result_ids - project_ids:
            parts.append(
                "in result but not project: "
                + ", ".join(_short_repr(i) for i in sorted(result_ids - project_ids))
            )
        raise InvalidScheduleInput(
            "Result was not computed from this project; task ids differ (" + "; ".join(parts) + ")."
        )
    project_links = {
        (d.predecessor_id, d.successor_id, d.dep_type.value) for d in project.dependencies
    }
    stale = sorted(
        (e.predecessor_id, e.successor_id, e.dep_type)
        for e in result.driving_edges
        if (e.predecessor_id, e.successor_id, e.dep_type) not in project_links
    )
    if stale:
        raise InvalidScheduleInput(
            "Result was not computed from this project; driving edge(s) not in its "
            "dependencies: "
            + ", ".join(f"{_short_repr(p)}->{_short_repr(s)} ({t})" for p, s, t in stale)
            + "."
        )
    nodes: list[GraphNode] = []
    for t in result.tasks:
        es, ef, ls, lf = t.early_start, t.early_finish, t.late_start, t.late_finish
        if es is None or ef is None or ls is None or lf is None:
            raise InvalidScheduleInput(
                f"Task {_short_repr(t.id)} has no computed dates; pass the result of schedule()."
            )
        nodes.append(
            GraphNode(
                id=t.id,
                name=t.name,
                early_start=es,
                early_finish=ef,
                late_start=ls,
                late_finish=lf,
                total_float_days=_days(t.total_float),
                is_critical=t.is_critical,
                milestone_at_day_end=t.milestone_at_day_end,
            )
        )
    driving = {(e.predecessor_id, e.successor_id, e.dep_type) for e in result.driving_edges}
    edges = [
        GraphEdge(
            predecessor_id=d.predecessor_id,
            successor_id=d.successor_id,
            dep_type=d.dep_type,
            lag_days=_days(d.lag),
            is_driving=(d.predecessor_id, d.successor_id, d.dep_type.value) in driving,
        )
        for d in project.dependencies
    ]
    _check_graph(
        [n.id for n in nodes],
        [(e.predecessor_id, e.successor_id) for e in edges],
    )
    nodes.sort(key=lambda n: n.id)
    edges.sort(key=lambda e: (e.predecessor_id, e.successor_id, e.dep_type, e.lag_days))
    return GraphExport(
        project_id=result.project_id,
        project_start=result.project_start,
        project_finish=result.project_finish,
        nodes=tuple(nodes),
        edges=tuple(edges),
    )
