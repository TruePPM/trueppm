#!/usr/bin/env python3
"""Fail a data migration that imports live application service code (#4603).

Why this exists
---------------
A migration that calls ``apps.<app>.services`` (or another live module such as
``bundled_templates``) changes behavior on a fresh install whenever that function is
refactored: the migration's body is a historical fact, its callee is not. A squash
that loads callables from the retained originals inherits the same coupling, and the
originals can never be deleted. ``projects.0150``, ``projects.0042`` and
``projects.0145`` all did this until #4603.

The rule
--------
No migration under ``packages/api/src/trueppm_api/apps/*/migrations/`` may import
``trueppm_api.apps.<app>.services`` (or a submodule), a module named
``bundled_templates``, or ``sync.sequence`` (the live sequence allocator whose
``backfill_tombstone_floors`` sync.0008 once called). Put a frozen copy in the app's ``backfill`` module (the pattern
``projects.0019``/``0075`` and ``sync.0005`` already use) and import that instead. The
frozen copy is deliberately never "kept in sync" with the live function.

An import that is genuinely safe (a pure constant that cannot drift) opts out with
``# migration-import-ok: <reason>`` on the import line. Like every opt-out in this
repo it is a rubber stamp that removes the silence, not a proof.

Pure static analysis (``ast``): no Django, no database.

Usage:
    scripts/check-migration-imports.py [--root DIR]
    scripts/check-migration-imports.py --self-test
"""

from __future__ import annotations

import ast
import re
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_MIGRATIONS_GLOB = "*/migrations/*.py"
_FORBIDDEN_LEAVES = {"services", "bundled_templates", "sequence"}
_PREFIX = "trueppm_api.apps."
_OPT_OUT = re.compile(r"#\s*migration-import-ok:\s*\S")


def _is_forbidden(module: str) -> bool:
    """True for ``trueppm_api.apps.<app>.<services|bundled_templates>[.…]``."""
    if not module.startswith(_PREFIX):
        return False
    parts = module[len(_PREFIX) :].split(".")
    return len(parts) >= 2 and parts[1] in _FORBIDDEN_LEAVES


def _scan_source(source: str, label: str) -> list[str]:
    lines = source.splitlines()
    out: list[str] = []
    for node in ast.walk(ast.parse(source)):
        modules: list[str] = []
        if isinstance(node, ast.Import):
            modules = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            modules = [node.module]
            # ``from trueppm_api.apps.projects import services``
            modules += [f"{node.module}.{a.name}" for a in node.names]
        else:
            continue
        bad = [m for m in modules if _is_forbidden(m)]
        if not bad:
            continue
        if _OPT_OUT.search(lines[node.lineno - 1]):
            continue
        out.append(f"{label}:{node.lineno}: imports live code {bad[0]!r}")
    return out


def _scan_tree(root: Path) -> tuple[list[str], int]:
    api = root / "packages/api/src/trueppm_api/apps"
    violations: list[str] = []
    files = sorted(api.glob(_MIGRATIONS_GLOB))
    for path in files:
        violations.extend(_scan_source(path.read_text(), str(path.relative_to(root))))
    return violations, len(files)


def _self_test() -> int:
    cases = [
        ("from trueppm_api.apps.projects.services import x\n", True),
        ("def f():\n    from trueppm_api.apps.projects.services import x\n", True),
        ("from trueppm_api.apps.projects import services\n", True),
        ("import trueppm_api.apps.projects.services\n", True),
        ("from trueppm_api.apps.projects.bundled_templates import T\n", True),
        ("from trueppm_api.apps.projects.services.sub import x\n", True),
        ("from trueppm_api.apps.projects.backfill import x\n", False),
        ("from trueppm_api.apps.projects.backfill_bundled_templates import T\n", False),
        ("from trueppm_api.apps.sync.sequence import x\n", True),
        ("from trueppm_api.apps.sync import sequence\n", True),
        (
            "from trueppm_api.apps.sync.backfill import frozen_backfill_tombstone_floors\n",
            False,
        ),
        ("from . import services\n", False),
        (
            "from trueppm_api.apps.projects.services import x  # migration-import-ok: pure const\n",
            False,
        ),
    ]
    failures = 0
    for src, should_flag in cases:
        flagged = bool(_scan_source(src, "t.py"))
        if flagged != should_flag:
            failures += 1
            print(f"✗ self-test: expected flagged={should_flag} for {src!r}")
    # Tree-level: a planted file under a temp root must be found, a clean one not.
    with tempfile.TemporaryDirectory() as tmp:
        mig = Path(tmp) / "packages/api/src/trueppm_api/apps/demo/migrations"
        mig.mkdir(parents=True)
        (mig / "0001_bad.py").write_text(
            "from trueppm_api.apps.demo.services import f\n"
        )
        (mig / "0002_ok.py").write_text(
            "from trueppm_api.apps.demo.backfill import f\n"
        )
        found, scanned = _scan_tree(Path(tmp))
        if scanned != 2 or len(found) != 1 or "0001_bad.py" not in found[0]:
            failures += 1
            print(f"✗ self-test: tree scan gave {found!r} over {scanned} files")
    if failures:
        return 1
    print(f"✓ self-test: {len(cases) + 1} cases behave")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return _self_test()
    root = _REPO_ROOT
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1]).resolve()
    if not (root / "packages/api/src/trueppm_api/apps").exists():
        print("→ migration-imports: apps dir not found — run from the repo root.")
        return 1
    violations, scanned = _scan_tree(root)
    if not violations:
        print(
            f"✓ No migration imports live service code ({scanned} migrations scanned)."
        )
        return 0
    print("✗ Migrations must not import live application code (#4603):\n")
    for v in violations:
        print(f"  {v}")
    print(
        "\nCopy the callee into the app's `backfill` module and import that instead; or add "
        "`# migration-import-ok: <reason>` on the import line if it cannot drift."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
