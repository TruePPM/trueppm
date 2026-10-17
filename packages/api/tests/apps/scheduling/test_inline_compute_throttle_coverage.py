"""Conformance: every view that runs the scheduling engine inline is throttled (#2839).

#1808 bounded the compute-heavy views it enumerated by hand and missed
``ScheduleDerivationView``, whose ``derive_value`` runs a full ``schedule()`` pass
on each call — so it fell through to the general 1000/min account default and,
for an ``mcp:read`` token, to the baseline read bucket only. A hand-kept list can
only be as complete as the person writing it. This test derives the list instead.

It parses every module under ``trueppm_api/apps`` and finds each view handler that
reaches ``schedule``, ``monte_carlo`` or ``derive_value`` from
``trueppm_scheduler`` — directly, through a module-level helper (in any module,
followed across ``from trueppm_api... import`` edges), or through a ``self.``
method on the same class. Each such handler must:

1. declare a **human** throttle — a class-level ``throttle_scope`` /
   ``throttle_classes`` / ``get_throttles``, an ``@action(throttle_classes=...)``
   on that action, or ``@throttle_classes`` on a function view; and
2. if the class is ``McpReadableViewMixin``-based, opt into the per-token compute
   bucket — ``mcp_compute_heavy = True``, or the action named in
   ``mcp_compute_heavy_actions``.

What it cannot see: an engine call reached through an attribute (``engine.schedule``),
a ``getattr`` dispatch, or a throttle inherited from a base class defined
elsewhere. Those are blind spots, not passes — the positive-control test below pins
the handlers it does see so the scan cannot go silently vacuous.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

import trueppm_api

_ENGINE_COMPUTE = frozenset({"schedule", "monte_carlo", "derive_value"})
_APPS_ROOT = Path(trueppm_api.__file__).parent / "apps"

# Handlers allowed to lack a HUMAN throttle (rule 1), each with its reason. The MCP
# half (rule 2) has no waiver. Ratcheted: an entry that no longer needs waiving
# fails the suite, so the list can only shrink.
_HUMAN_THROTTLE_WAIVERS: dict[str, str] = {
    "projects.program_views:ProgramViewSet.schedule": (
        "The program schedule page refetches on every member project's WebSocket "
        "event (300 ms debounce per project, cancel-and-refetch on invalidate), so "
        "a human throttle needs that cadence bounded client-side first or it 429s "
        "the page during live editing. mcp:read tokens are on the compute bucket."
    ),
}


@dataclass(frozen=True)
class Finding:
    handler: str  # "<app.module>:<Class>.<method>" or "<app.module>:<function>"
    missing_human_throttle: bool
    missing_mcp_compute_heavy: bool


def _base_name(node: ast.expr) -> str:
    if isinstance(node, ast.Subscript):
        return _base_name(node.value)
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def _decorator_name(node: ast.expr) -> str:
    return _base_name(node.func) if isinstance(node, ast.Call) else _base_name(node)


def _called_names(node: ast.AST) -> set[str]:
    return {
        c.func.id
        for c in ast.walk(node)
        if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
    }


def _self_calls(node: ast.AST) -> set[str]:
    return {
        c.func.attr
        for c in ast.walk(node)
        if isinstance(c, ast.Call)
        and isinstance(c.func, ast.Attribute)
        and isinstance(c.func.value, ast.Name)
        and c.func.value.id == "self"
    }


def _class_assigns(cls: ast.ClassDef) -> dict[str, ast.expr | None]:
    out: dict[str, ast.expr | None] = {}
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            out[stmt.target.id] = stmt.value
        elif isinstance(stmt, ast.FunctionDef):
            out.setdefault(f"def:{stmt.name}", None)
    return out


def _string_literals(node: ast.expr | None) -> set[str]:
    if node is None:
        return set()
    return {
        c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)
    }


@dataclass
class _Module:
    tree: ast.Module
    engine_aliases: set[str]
    api_imports: dict[str, tuple[str, str]]  # local alias -> (module, name)
    functions: dict[str, ast.FunctionDef]


def _index(tree: ast.Module) -> _Module:
    engine_aliases: set[str] = set()
    api_imports: dict[str, tuple[str, str]] = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.module:
            for a in n.names:
                alias = a.asname or a.name
                if n.module.startswith("trueppm_scheduler") and a.name in _ENGINE_COMPUTE:
                    engine_aliases.add(alias)
                elif n.module.startswith("trueppm_api."):
                    api_imports[alias] = (n.module, a.name)
    functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    return _Module(tree, engine_aliases, api_imports, functions)


def scan(sources: dict[str, str]) -> list[Finding]:
    """Return the throttle findings for ``{dotted module name: source}``."""
    modules = {name: _index(ast.parse(src)) for name, src in sources.items()}

    # Fixpoint over module-level functions: heavy if it calls an engine alias, a
    # heavy function in its own module, or a heavy function it imported.
    heavy: set[tuple[str, str]] = set()
    changed = True
    while changed:
        changed = False
        for mod_name, mod in modules.items():
            for fname, fnode in mod.functions.items():
                if (mod_name, fname) in heavy:
                    continue
                if _reaches(_called_names(fnode), mod_name, mod, heavy):
                    heavy.add((mod_name, fname))
                    changed = True

    findings: list[Finding] = []
    for mod_name, mod in modules.items():
        short = mod_name.removeprefix("trueppm_api.apps.")
        for node in mod.tree.body:
            if isinstance(node, ast.FunctionDef):
                if not any(_decorator_name(d) == "api_view" for d in node.decorator_list):
                    continue
                if not _reaches(_called_names(node), mod_name, mod, heavy):
                    continue
                throttled = any(
                    _decorator_name(d) == "throttle_classes" for d in node.decorator_list
                )
                if not throttled:
                    findings.append(Finding(f"{short}:{node.name}", True, False))
            elif isinstance(node, ast.ClassDef):
                findings.extend(_scan_class(node, short, mod_name, mod, heavy))
    return findings


def _reaches(names: set[str], mod_name: str, mod: _Module, heavy: set[tuple[str, str]]) -> bool:
    for n in names:
        if n in mod.engine_aliases or (mod_name, n) in heavy:
            return True
        if n in mod.api_imports and mod.api_imports[n] in heavy:
            return True
    return False


def _scan_class(
    cls: ast.ClassDef, short: str, mod_name: str, mod: _Module, heavy: set[tuple[str, str]]
) -> list[Finding]:
    bases = {_base_name(b) for b in cls.bases}
    if not any(b.endswith(("View", "ViewSet")) for b in bases):
        return []
    methods = {s.name: s for s in cls.body if isinstance(s, ast.FunctionDef)}
    heavy_methods: set[str] = set()
    changed = True
    while changed:
        changed = False
        for name, m in methods.items():
            if name in heavy_methods:
                continue
            if _reaches(_called_names(m), mod_name, mod, heavy) or (_self_calls(m) & heavy_methods):
                heavy_methods.add(name)
                changed = True
    # Only entry points are findings: a handler (get/post/...) or an @action. A
    # private helper is heavy, but the handler that calls it is what gets routed.
    handlers = {
        name
        for name in heavy_methods
        if name in {"get", "post", "put", "patch", "delete", "list", "retrieve", "create"}
        or any(_decorator_name(d) == "action" for d in methods[name].decorator_list)
    }
    assigns = _class_assigns(cls)
    class_throttled = bool(
        {"throttle_scope", "throttle_classes", "def:get_throttles"} & assigns.keys()
    )
    mcp_readable = "McpReadableViewMixin" in bases
    heavy_flag = assigns.get("mcp_compute_heavy")
    class_heavy = isinstance(heavy_flag, ast.Constant) and heavy_flag.value is True
    heavy_actions = _string_literals(assigns.get("mcp_compute_heavy_actions"))

    out: list[Finding] = []
    for name in sorted(handlers):
        action_throttled = any(
            isinstance(d, ast.Call)
            and _decorator_name(d) == "action"
            and any(k.arg == "throttle_classes" for k in d.keywords)
            for d in methods[name].decorator_list
        )
        missing_human = not (class_throttled or action_throttled)
        missing_mcp = mcp_readable and not (class_heavy or name in heavy_actions)
        if missing_human or missing_mcp:
            out.append(Finding(f"{short}:{cls.name}.{name}", missing_human, missing_mcp))
    return out


def _tree_sources() -> dict[str, str]:
    sources: dict[str, str] = {}
    pkg_root = _APPS_ROOT.parent.parent
    for path in sorted(_APPS_ROOT.rglob("*.py")):
        if "migrations" in path.parts or "tests" in path.parts:
            continue
        rel = path.relative_to(pkg_root).with_suffix("")
        sources[".".join(rel.parts)] = path.read_text(encoding="utf-8")
    return sources


def _tree_findings() -> list[Finding]:
    return scan(_tree_sources())


def test_every_inline_engine_view_is_throttled() -> None:
    findings = _tree_findings()
    unwaived_human = [
        f.handler
        for f in findings
        if f.missing_human_throttle and f.handler not in _HUMAN_THROTTLE_WAIVERS
    ]
    missing_mcp = [f.handler for f in findings if f.missing_mcp_compute_heavy]
    assert not unwaived_human, (
        "These views run schedule()/monte_carlo()/derive_value() inline in the request "
        "but declare no throttle (throttle_scope / throttle_classes / "
        "@action(throttle_classes=...)), so they fall through to the 1000/min account "
        f"default: {unwaived_human}"
    )
    assert not missing_mcp, (
        "These McpReadableViewMixin views run the engine inline but are not "
        "mcp_compute_heavy (nor named in mcp_compute_heavy_actions), so an mcp:read "
        f"token is held only to the baseline read bucket: {missing_mcp}"
    )


def test_human_throttle_waivers_are_still_needed() -> None:
    still_needed = {f.handler for f in _tree_findings() if f.missing_human_throttle}
    stale = sorted(set(_HUMAN_THROTTLE_WAIVERS) - still_needed)
    assert not stale, f"Remove these waivers; the views are throttled now: {stale}"


def test_scan_sees_the_known_inline_engine_handlers() -> None:
    """Positive control: the scan must keep resolving the handlers it exists for.

    If an import rename or a refactor made the scan blind, the coverage test above
    would pass vacuously. Every handler here reaches the engine inline today.
    """
    sources = _tree_sources()
    # Re-run with every throttle declaration stripped from the real sources, so each
    # known handler must surface as a finding.
    stripped = {
        name: src.replace("throttle_scope", "_ts")
        .replace("throttle_classes", "_tc")
        .replace("mcp_compute_heavy", "_mch")
        for name, src in sources.items()
    }
    seen = {f.handler for f in scan(stripped)}
    expected = {
        "scheduling.views:run_monte_carlo",
        "scheduling.views:MonteCarloWhatIfView.get",
        "scheduling.views:ScheduleDerivationView.get",
        "projects.program_views:ProgramViewSet.schedule",
    }
    assert expected <= seen, f"scan no longer sees: {sorted(expected - seen)}"


def test_scan_flags_an_unthrottled_view_through_a_cross_module_helper() -> None:
    """Negative control: the #2839 shape — a view reaching the engine via a helper."""
    sources = {
        "trueppm_api.apps.demo.services": (
            "def forecast(p):\n"
            "    from trueppm_scheduler.engine import monte_carlo\n"
            "    return monte_carlo(p)\n"
        ),
        "trueppm_api.apps.demo.views": (
            "from trueppm_api.apps.demo.services import forecast\n"
            "class DemoView(McpReadableViewMixin, APIView):\n"
            "    def get(self, request):\n"
            "        return self._run()\n"
            "    def _run(self):\n"
            "        return forecast(None)\n"
            "class ThrottledView(McpReadableViewMixin, APIView):\n"
            "    throttle_scope = 'x'\n"
            "    mcp_compute_heavy = True\n"
            "    def get(self, request):\n"
            "        return forecast(None)\n"
        ),
    }
    assert scan(sources) == [Finding("demo.views:DemoView.get", True, True)]
