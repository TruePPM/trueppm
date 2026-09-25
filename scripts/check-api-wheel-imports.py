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

    python check-api-wheel-imports.py             # probe the installed package
    python check-api-wheel-imports.py --self-test  # prove the probe can fail
"""

from __future__ import annotations

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
        finally:
            sys.path.remove(tmp)
    if ok != 0 or bad != 1:
        print(f"check-api-wheel-imports --self-test FAILED (clean={ok}, broken={bad})")
        return 1
    print("check-api-wheel-imports --self-test ok")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(probe("trueppm_api", setup_django=True))
