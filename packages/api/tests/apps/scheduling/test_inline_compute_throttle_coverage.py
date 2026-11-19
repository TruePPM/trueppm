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

1. declare a **human** throttle that throttles something — a non-empty class-level
   ``throttle_classes`` (``ScopedRateThrottle`` counts only beside a non-empty
   ``throttle_scope``; a bare scope does nothing under the default classes), a
   ``get_throttles`` override, a non-empty ``@action(throttle_classes=...)`` on
   that action, or a non-empty ``@throttle_classes`` on a function view; and
2. if the class is ``McpReadableViewMixin``-based, opt into the per-token compute
   bucket — ``mcp_compute_heavy = True``, or the action named in
   ``mcp_compute_heavy_actions``.

It also sees an engine function reached through a module alias
(``import trueppm_scheduler.engine as engine; engine.schedule(...)``), a ``getattr``
dispatch on such an alias (treated as reaching the engine whatever the name, since
the name may be computed), and an engine function passed around as a value. A
throttle, scope, ``get_throttles`` or MCP flag is resolved through the class's base
classes, in this module or imported from another ``trueppm_api`` module, nearest
declaration first, so an inherited throttle passes and a base whose throttle was
removed fails every subclass that relied on it (#4497).

What it still cannot see: a base class it cannot resolve statically (imported from
outside ``trueppm_api``, or reached as ``module.Base``), which contributes nothing,
and an engine-reaching handler that a subclass inherits rather than defines. The
positive-control test below pins the handlers it does see, so the scan cannot go
silently vacuous.
"""

from __future__ import annotations

import ast
import importlib.util
from dataclasses import dataclass
from pathlib import Path

import trueppm_api

_ENGINE_COMPUTE = frozenset({"schedule", "monte_carlo", "derive_value"})
_APPS_ROOT = Path(trueppm_api.__file__).parent / "apps"

# Handlers allowed to lack a HUMAN throttle (rule 1), each with its reason. The MCP
# half (rule 2) has no waiver. Ratcheted: an entry that no longer needs waiving
# fails the suite, so the list can only shrink. Empty today.
_HUMAN_THROTTLE_WAIVERS: dict[str, str] = {}


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


def _is_real_throttle_list(node: ast.expr | None) -> bool:
    """Does a ``throttle_classes`` value actually throttle something?

    ``[]`` throttles nothing, and ``[ScopedRateThrottle]`` alone throttles nothing
    without a scope (its ``allow_request`` returns True when the view has no
    ``throttle_scope``). A non-literal expression is trusted.
    """
    if not isinstance(node, (ast.List, ast.Tuple)):
        return node is not None
    names = [_base_name(e) for e in node.elts]
    return bool(names) and names != ["ScopedRateThrottle"] * len(names)


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
    engine_modules: set[str]  # local names bound to a trueppm_scheduler module
    api_imports: dict[str, tuple[str, str]]  # local alias -> (module, name)
    functions: dict[str, ast.FunctionDef]
    classes: dict[str, ast.ClassDef]


def _is_module(dotted: str) -> bool:
    try:
        return importlib.util.find_spec(dotted) is not None
    except (ImportError, ValueError):
        return False


def _index(tree: ast.Module) -> _Module:
    engine_aliases: set[str] = set()
    engine_modules: set[str] = set()
    api_imports: dict[str, tuple[str, str]] = {}
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.name.split(".")[0] == "trueppm_scheduler":
                    # ``import a.b`` binds ``a``; ``import a.b as c`` binds ``c``.
                    engine_modules.add(a.asname or a.name.split(".")[0])
        elif isinstance(n, ast.ImportFrom) and n.module:
            for a in n.names:
                alias = a.asname or a.name
                if n.module.startswith("trueppm_scheduler"):
                    if a.name in _ENGINE_COMPUTE:
                        engine_aliases.add(alias)
                    elif _is_module(f"{n.module}.{a.name}"):
                        engine_modules.add(alias)
                elif n.module.startswith("trueppm_api."):
                    api_imports[alias] = (n.module, a.name)
    functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    return _Module(tree, engine_aliases, engine_modules, api_imports, functions, classes)


def _root_name(node: ast.expr) -> str | None:
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _references_engine(node: ast.AST, mod: _Module) -> bool:
    """Does ``node`` reach the engine other than by a bare-name call to a helper?

    A bare engine alias used anywhere (called, or passed as a value), an engine
    function read off a scheduler module alias (``engine.schedule``), or any
    ``getattr`` on a scheduler module alias — its name may be computed, so it is
    treated as reaching the engine rather than proven not to.
    """
    for c in ast.walk(node):
        if isinstance(c, ast.Name) and c.id in mod.engine_aliases:
            return True
        if (
            isinstance(c, ast.Attribute)
            and c.attr in _ENGINE_COMPUTE
            and _root_name(c.value) in mod.engine_modules
        ):
            return True
        if (
            isinstance(c, ast.Call)
            and isinstance(c.func, ast.Name)
            and c.func.id == "getattr"
            and c.args
            and _root_name(c.args[0]) in mod.engine_modules
        ):
            return True
    return False


def _node_reaches(node: ast.AST, mod_name: str, mod: _Module, heavy: set[tuple[str, str]]) -> bool:
    return _references_engine(node, mod) or _reaches(_called_names(node), mod_name, mod, heavy)


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
                if _node_reaches(fnode, mod_name, mod, heavy):
                    heavy.add((mod_name, fname))
                    changed = True

    findings: list[Finding] = []
    for mod_name, mod in modules.items():
        short = mod_name.removeprefix("trueppm_api.apps.")
        for node in mod.tree.body:
            if isinstance(node, ast.FunctionDef):
                if not any(_decorator_name(d) == "api_view" for d in node.decorator_list):
                    continue
                if not _node_reaches(node, mod_name, mod, heavy):
                    continue
                throttled = any(
                    isinstance(d, ast.Call)
                    and _decorator_name(d) == "throttle_classes"
                    and bool(d.args)
                    and _is_real_throttle_list(d.args[0])
                    for d in node.decorator_list
                )
                if not throttled:
                    findings.append(Finding(f"{short}:{node.name}", True, False))
            elif isinstance(node, ast.ClassDef):
                findings.extend(_scan_class(node, short, mod_name, mod, heavy, modules))
    return findings


def _resolve_base(
    base: ast.expr, mod_name: str, modules: dict[str, _Module]
) -> tuple[str, ast.ClassDef] | None:
    """The ``(module, ClassDef)`` a base expression names, if statically resolvable."""
    if isinstance(base, ast.Subscript):
        base = base.value
    if not isinstance(base, ast.Name):
        return None
    mod = modules[mod_name]
    if base.id in mod.classes:
        return mod_name, mod.classes[base.id]
    target = mod.api_imports.get(base.id)
    if target is not None and target[0] in modules:
        cls = modules[target[0]].classes.get(target[1])
        if cls is not None:
            return target[0], cls
    return None


def _inherited(
    cls: ast.ClassDef,
    mod_name: str,
    modules: dict[str, _Module],
    seen: frozenset[int] = frozenset(),
) -> tuple[dict[str, ast.expr | None], set[str]]:
    """Class-level declarations and ancestor names, resolved through the bases.

    Approximates the MRO: the class's own body wins, then its bases left to right,
    each with its own ancestors behind it.
    """
    assigns: dict[str, ast.expr | None] = {}
    names = {_base_name(b) for b in cls.bases}
    if id(cls) in seen:
        return assigns, names
    for base in reversed(cls.bases):
        resolved = _resolve_base(base, mod_name, modules)
        if resolved is None:
            continue
        base_assigns, base_names = _inherited(resolved[1], resolved[0], modules, seen | {id(cls)})
        assigns.update(base_assigns)
        names |= base_names
    assigns.update(_class_assigns(cls))
    return assigns, names


def _reaches(names: set[str], mod_name: str, mod: _Module, heavy: set[tuple[str, str]]) -> bool:
    for n in names:
        if n in mod.engine_aliases or (mod_name, n) in heavy:
            return True
        if n in mod.api_imports and mod.api_imports[n] in heavy:
            return True
    return False


def _scan_class(
    cls: ast.ClassDef,
    short: str,
    mod_name: str,
    mod: _Module,
    heavy: set[tuple[str, str]],
    modules: dict[str, _Module],
) -> list[Finding]:
    # A view by any ancestor's name, so ``ChildView(Base)`` with ``Base(APIView)``
    # imported from another module still counts.
    assigns, ancestors = _inherited(cls, mod_name, modules)
    if not any(b.endswith(("View", "ViewSet")) for b in ancestors):
        return []
    methods = {s.name: s for s in cls.body if isinstance(s, ast.FunctionDef)}
    heavy_methods: set[str] = set()
    changed = True
    while changed:
        changed = False
        for name, m in methods.items():
            if name in heavy_methods:
                continue
            if _node_reaches(m, mod_name, mod, heavy) or (_self_calls(m) & heavy_methods):
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
    scope = assigns.get("throttle_scope")
    has_scope = "throttle_scope" in assigns and not (
        isinstance(scope, ast.Constant) and not scope.value
    )
    classes = assigns.get("throttle_classes")
    class_throttled = "def:get_throttles" in assigns or (
        # ScopedRateThrottle is real only with a scope beside it.
        "throttle_classes" in assigns
        and (_is_real_throttle_list(classes) or (classes is not None and has_scope))
        and not (isinstance(classes, (ast.List, ast.Tuple)) and not classes.elts)
    )
    mcp_readable = "McpReadableViewMixin" in ancestors
    heavy_flag = assigns.get("mcp_compute_heavy")
    class_heavy = isinstance(heavy_flag, ast.Constant) and heavy_flag.value is True
    heavy_actions = _string_literals(assigns.get("mcp_compute_heavy_actions"))

    out: list[Finding] = []
    for name in sorted(handlers):
        action_throttled = any(
            isinstance(d, ast.Call)
            and _decorator_name(d) == "action"
            and any(
                k.arg == "throttle_classes" and _is_real_throttle_list(k.value) for k in d.keywords
            )
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
    # ``run_monte_carlo`` left this set with #2273: it queues the simulation on a
    # Celery worker, so the request handler no longer reaches ``monte_carlo()``.
    expected = {
        "scheduling.views:MonteCarloWhatIfView.get",
        "scheduling.views:ScheduleDerivationView.get",
        "projects.program_views:ProgramViewSet.schedule",
    }
    assert expected <= seen, f"scan no longer sees: {sorted(expected - seen)}"


def test_scan_rejects_throttle_declarations_that_throttle_nothing() -> None:
    """``throttle_classes=[]`` and a scope-less ``ScopedRateThrottle`` are not throttles."""
    engine = "from trueppm_scheduler.engine import schedule\n"
    sources = {
        "trueppm_api.apps.demo.views": engine + "class EmptyView(APIView):\n"
        "    throttle_classes = []\n"
        "    def get(self, request):\n"
        "        return schedule(None)\n"
        "class ScopelessView(APIView):\n"
        "    throttle_classes = [ScopedRateThrottle]\n"
        "    def get(self, request):\n"
        "        return schedule(None)\n"
        "class EmptyScopeView(APIView):\n"
        "    throttle_classes = [ScopedRateThrottle]\n"
        "    throttle_scope = ''\n"
        "    def get(self, request):\n"
        "        return schedule(None)\n"
        "class ScopedView(APIView):\n"
        "    throttle_classes = [ScopedRateThrottle]\n"
        "    throttle_scope = 'x'\n"
        "    def get(self, request):\n"
        "        return schedule(None)\n"
        "class EmptyActionViewSet(GenericViewSet):\n"
        "    @action(detail=True, throttle_classes=[])\n"
        "    def run(self, request):\n"
        "        return schedule(None)\n"
        "class ActionViewSet(GenericViewSet):\n"
        "    @action(detail=True, throttle_classes=[SomeUserThrottle])\n"
        "    def run(self, request):\n"
        "        return schedule(None)\n"
        "@api_view(['GET'])\n"
        "@throttle_classes([])\n"
        "def empty_fbv(request):\n"
        "    return schedule(None)\n",
    }
    flagged = {f.handler for f in scan(sources) if f.missing_human_throttle}
    assert flagged == {
        "demo.views:EmptyView.get",
        "demo.views:ScopelessView.get",
        "demo.views:EmptyScopeView.get",
        "demo.views:EmptyActionViewSet.run",
        "demo.views:empty_fbv",
    }


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
            "    throttle_classes = [ScopedRateThrottle]\n"
            "    throttle_scope = 'x'\n"
            "    mcp_compute_heavy = True\n"
            "    def get(self, request):\n"
            "        return forecast(None)\n"
        ),
    }
    assert scan(sources) == [Finding("demo.views:DemoView.get", True, True)]


def test_scan_sees_attribute_getattr_and_value_dispatch_to_the_engine() -> None:
    """#4497 blind spot 1: an engine call not made through a bare imported name."""
    sources = {
        "trueppm_api.apps.demo.views": (
            "import trueppm_scheduler.engine as engine\n"
            "import trueppm_scheduler\n"
            "from trueppm_scheduler import engine as eng2\n"
            "from trueppm_scheduler.engine import monte_carlo\n"
            "class AttrView(APIView):\n"
            "    def get(self, request):\n"
            "        return engine.schedule(None)\n"
            "class DottedView(APIView):\n"
            "    def get(self, request):\n"
            "        return trueppm_scheduler.engine.derive_value(None)\n"
            "class GetattrView(APIView):\n"
            "    def get(self, request):\n"
            "        return getattr(eng2, request.GET['fn'])(None)\n"
            "class ValueView(APIView):\n"
            "    def get(self, request):\n"
            "        return run_later(monte_carlo, None)\n"
            "class InertView(APIView):\n"
            "    def get(self, request):\n"
            "        return engine.Project\n"
        ),
    }
    flagged = {f.handler for f in scan(sources) if f.missing_human_throttle}
    assert flagged == {
        "demo.views:AttrView.get",
        "demo.views:DottedView.get",
        "demo.views:GetattrView.get",
        "demo.views:ValueView.get",
    }


def test_scan_resolves_throttles_inherited_across_modules() -> None:
    """#4497 blind spot 2: a throttle (and MCP flag) declared on a base class elsewhere."""
    sources = {
        "trueppm_api.apps.demo.base": (
            "class ThrottledBase(McpReadableViewMixin, APIView):\n"
            "    throttle_classes = [ScopedRateThrottle]\n"
            "    throttle_scope = 'compute'\n"
            "    mcp_compute_heavy = True\n"
            "class BareBase(McpReadableViewMixin, APIView):\n"
            "    pass\n"
        ),
        "trueppm_api.apps.demo.views": (
            "from trueppm_scheduler.engine import schedule\n"
            "from trueppm_api.apps.demo.base import BareBase, ThrottledBase\n"
            "class Middle(ThrottledBase):\n"
            "    pass\n"
            "class InheritsView(Middle):\n"
            "    def get(self, request):\n"
            "        return schedule(None)\n"
            "class OverridesToNothingView(ThrottledBase):\n"
            "    throttle_classes = []\n"
            "    def get(self, request):\n"
            "        return schedule(None)\n"
            "class BareView(BareBase):\n"
            "    def get(self, request):\n"
            "        return schedule(None)\n"
        ),
    }
    assert sorted(scan(sources), key=lambda f: f.handler) == [
        Finding("demo.views:BareView.get", True, True),
        Finding("demo.views:OverridesToNothingView.get", True, False),
    ]


def test_removing_a_base_throttle_fails_the_subclass_that_relied_on_it() -> None:
    base_src = (
        "class Base(APIView):\n"
        "    throttle_classes = [ScopedRateThrottle]\n"
        "    throttle_scope = 'compute'\n"
    )
    view_src = (
        "from trueppm_scheduler.engine import schedule\n"
        "from trueppm_api.apps.demo.base import Base\n"
        "class ChildView(Base):\n"
        "    def get(self, request):\n"
        "        return schedule(None)\n"
    )
    with_throttle = {
        "trueppm_api.apps.demo.base": base_src,
        "trueppm_api.apps.demo.views": view_src,
    }
    assert scan(with_throttle) == []
    without = {
        "trueppm_api.apps.demo.base": "class Base(APIView):\n    pass\n",
        "trueppm_api.apps.demo.views": view_src,
    }
    assert scan(without) == [Finding("demo.views:ChildView.get", True, False)]
