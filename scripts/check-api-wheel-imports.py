#!/usr/bin/env python3
"""Boot Django and import every module of an INSTALLED trueppm_api (#4122).

Run with the interpreter of the venv under test, from a directory that is not the
source tree, so ``import trueppm_api`` resolves to what was installed.

Why this walks every module instead of a hand-picked list: #4080 shipped an API whose
declared scheduler floor (>=0.1.0a0) admitted a scheduler without
``trueppm_scheduler.derive``. ``apps/scheduling/serializers.py`` imports it at module
scope, so the install could not load. ``uv lock --check`` stayed green because it only
proves the lock satisfies pyproject. A list of "entry points" goes stale the day a new
module takes a scheduler import; walking the package cannot.

Importing a module only executes its module-scope imports. The API also imports
scheduler symbols inside functions (``_WorkingDayCounter``, ``_collect_leaves`` and
dozens of public ones), which no import walk can see until that code path runs. So the
probe also parses every installed source file and resolves each
``from trueppm_scheduler... import X`` / ``import trueppm_scheduler...`` it finds,
wherever it sits, against the installed scheduler.

    python check-api-wheel-imports.py             # probe the installed package
    python check-api-wheel-imports.py --self-test  # prove the probe can fail
"""

from __future__ import annotations

import ast
import importlib
import os
import sys
import tempfile
import textwrap
import traceback
from pathlib import Path

# Not import-time-safe by design: entry-point shims that read the environment on
# import, and test modules that ship inside the package.
SKIP_SUFFIXES = (".asgi", ".wsgi")
SKIP_PARTS = (".tests", ".test_", ".migrations", ".management.commands", ".settings")


def walk(package: str) -> list[str]:
    """List modules by walking the directory, not ``pkgutil.walk_packages``.

    ``trueppm_api/apps`` has no ``__init__.py`` (a namespace package), which
    ``pkgutil`` silently skips: it would report 47 modules and none of the ones that
    import the scheduler. A probe that cannot see ``apps.scheduling`` is vacuous.
    """
    pkg = importlib.import_module(package)
    names = [package]
    for root in map(Path, pkg.__path__):
        for path in sorted(root.rglob("*.py")):
            rel = path.relative_to(root).with_suffix("")
            parts = list(rel.parts)
            if parts[-1] == "__init__":
                parts.pop()
            if not parts:
                continue
            name = ".".join([package, *parts])
            if name.endswith(SKIP_SUFFIXES) or any(p in name for p in SKIP_PARTS):
                continue
            names.append(name)
    return names


def scheduler_references(
    package: str, scheduler: str
) -> dict[tuple[str, str], list[str]]:
    """Collect every ``scheduler`` import in ``package``'s sources, at any depth.

    Parsed with ``ast`` rather than grepped so multi-line and aliased imports, and
    imports nested in functions, methods and ``if TYPE_CHECKING`` blocks, all count.
    Returns ``{(module, name): [file:line, ...]}``; ``name`` is ``""`` for a bare
    ``import module``. Covers the whole package tree, tests and migrations
    included: an unresolvable name there is the same broken install.
    """
    pkg = importlib.import_module(package)
    refs: dict[tuple[str, str], list[str]] = {}
    for root in map(Path, pkg.__path__):
        for path in sorted(root.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                where = f"{path.relative_to(root)}:{getattr(node, 'lineno', 0)}"
                if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    if node.module == scheduler or node.module.startswith(
                        scheduler + "."
                    ):
                        for alias in node.names:
                            if alias.name != "*":
                                refs.setdefault((node.module, alias.name), []).append(
                                    where
                                )
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        if alias.name == scheduler or alias.name.startswith(
                            scheduler + "."
                        ):
                            refs.setdefault((alias.name, ""), []).append(where)
    return refs


def check_scheduler_symbols(package: str, scheduler: str = "trueppm_scheduler") -> int:
    """Resolve every scheduler name ``package`` imports against the installed one.

    A name resolves if the module has that attribute or ``module.name`` imports as a
    submodule (``from pkg import submodule``), which is exactly what the ``from``
    statement itself would accept at runtime.
    """
    refs = scheduler_references(package, scheduler)
    failures: list[str] = []
    for (module, name), sites in sorted(refs.items()):
        try:
            mod = importlib.import_module(module)
            if name and not hasattr(mod, name):
                try:
                    importlib.import_module(f"{module}.{name}")
                except ModuleNotFoundError:
                    raise ImportError(
                        f"{module} has no attribute or submodule {name!r}"
                    ) from None
        except Exception as exc:  # noqa: BLE001 - report every failure, not the first
            label = f"{module}.{name}" if name else module
            failures.append(
                f"FAIL {label} ({', '.join(sites)}): {type(exc).__name__}: {exc}"
            )
    for line in failures:
        print(line)
    print(
        f"check-api-wheel-imports: {len(refs)} {scheduler} names referenced, "
        f"{len(failures)} unresolved."
    )
    return 1 if failures else 0


def probe(package: str, *, setup_django: bool) -> int:
    if setup_django:
        os.environ.setdefault("DJANGO_SETTINGS_MODULE", "trueppm_api.settings.dev")
        # dev settings refuse to load outside a test runner without this opt-in.
        os.environ.setdefault("TRUEPPM_ALLOW_DEV_SETTINGS", "1")
        import django

        try:
            django.setup()  # loads every INSTALLED_APP, no DB or Valkey connection
        except Exception:
            traceback.print_exc()
            print("FAIL django.setup()")
            return 1

    failures: list[tuple[str, str]] = []
    modules = walk(package)
    for name in modules:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - report every failure, not the first
            failures.append((name, f"{type(exc).__name__}: {exc}"))

    for name, err in failures:
        print(f"FAIL {name}: {err}")
    print(f"check-api-wheel-imports: {len(modules)} modules, {len(failures)} failed.")
    return 1 if failures else 0


def self_test() -> int:
    """Run the real probe against fixture packages, one clean and one broken."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for name, body in (
            ("probe_ok", "import json\n"),
            (
                "probe_bad",
                "from trueppm_scheduler_that_does_not_exist import Quantity\n",
            ),
        ):
            pkg = root / name
            (pkg / "apps" / "sub").mkdir(parents=True)  # `apps` has no __init__.py
            (pkg / "__init__.py").write_text("")
            (pkg / "apps" / "sub" / "mod.py").write_text(textwrap.dedent(body))
        # A fake scheduler and two consumers that import it ONLY inside functions:
        # one names symbols that exist (incl. a submodule), one names a private
        # symbol the scheduler no longer has. Module import succeeds for both.
        sched = root / "probe_sched"
        sched.mkdir()
        (sched / "__init__.py").write_text("")
        (sched / "engine.py").write_text("_WorkingDayCounter = object\n")
        for name, sym in (
            ("probe_fn_ok", "_WorkingDayCounter"),
            ("probe_fn_bad", "_Gone"),
        ):
            pkg = root / name
            (pkg / "apps").mkdir(parents=True)
            (pkg / "__init__.py").write_text("")
            (pkg / "apps" / "mod.py").write_text(
                textwrap.dedent(
                    f"""\
                    def f():
                        from probe_sched.engine import (
                            {sym} as counter,
                        )
                        from probe_sched import engine
                        import probe_sched.engine
                        return counter, engine
                    """
                )
            )
        sys.path.insert(0, tmp)
        try:
            seen = walk("probe_ok")
            if "probe_ok.apps.sub.mod" not in seen:
                print(
                    f"check-api-wheel-imports --self-test FAILED: namespace dir skipped {seen}"
                )
                return 1
            ok = probe("probe_ok", setup_django=False)
            bad = probe("probe_bad", setup_django=False)
            # The import walk alone must NOT see the function-local break; that is
            # the gap the symbol scan closes.
            fn_walk = probe("probe_fn_bad", setup_django=False)
            fn_ok = check_scheduler_symbols("probe_fn_ok", "probe_sched")
            fn_bad = check_scheduler_symbols("probe_fn_bad", "probe_sched")
            refs = scheduler_references("probe_fn_ok", "probe_sched")
        finally:
            sys.path.remove(tmp)
    expected_refs = {
        ("probe_sched.engine", "_WorkingDayCounter"),
        ("probe_sched", "engine"),
        ("probe_sched.engine", ""),
    }
    if set(refs) != expected_refs:
        print(f"check-api-wheel-imports --self-test FAILED: scan found {sorted(refs)}")
        return 1
    if ok != 0 or bad != 1 or fn_walk != 0 or fn_ok != 0 or fn_bad != 1:
        print(
            "check-api-wheel-imports --self-test FAILED "
            f"(clean={ok}, broken={bad}, fn-walk={fn_walk}, fn-ok={fn_ok}, fn-bad={fn_bad})"
        )
        return 1
    print("check-api-wheel-imports --self-test ok")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    rc = probe("trueppm_api", setup_django=True)
    sys.exit(check_scheduler_symbols("trueppm_api") or rc)
