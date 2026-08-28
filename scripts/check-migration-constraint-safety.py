#!/usr/bin/env python3
"""Catch a Django constraint added to a table that may already hold violating rows.

Why this exists
---------------
``AddConstraint`` builds and VALIDATES its index against every existing row. On a
table that is already populated, any row violating the new constraint fails
``migrate`` — and migrations run on container start, so the result is an upgrade
crash-loop, not a failed deploy you can roll back at leisure. That is #3068:
``projects.0148`` added an ``ExclusionConstraint`` and every database already holding
two live tasks on one ``wbs_path`` refused to start.

No gate could have caught it. ``api:migration-check`` runs ``makemigrations --check
--dry-run``, which compares model state to migration files and never opens a database
— its own comment says so. ``api:migration-numbering`` is a numbering-collision guard
and is equally blind. The green ``api:migration-check`` on the offending MR read as
evidence about the migration when it was evidence about something else entirely: the
class had no gate at all.

This is that gate. It is a lint, not a database job — the classification is entirely
static, so it needs no Django, no database, and no dependency install.

The rule
--------
An ``AddConstraint`` whose ``model_name`` is not created in the same migration must
either be preceded by a data repair (``RunPython``) in the same migration, or carry an
explicit ``# safe-constraint: <reason>`` comment saying why existing rows cannot
violate it.

Four shapes are recognized as safe without a comment, because in each the constraint
provably cannot fail on data that is already there:

* the model is created by a ``CreateModel`` in the same migration — the table is empty;
* the migration declares ``replaces`` — a squash re-states constraints that were
  already applied and validated by the migrations it stands in for;
* the same migration runs ``AlterUniqueTogether`` for that model — a ``unique_together``
  being converted to a ``UniqueConstraint`` over the same columns is already enforced
  by the index it replaces;
* a ``RunPython`` appears earlier in the operations list — the repair-first pattern
  (``projects.0121``, and ``projects.0148`` after #3068).

Be honest about the ceiling
---------------------------
``# safe-constraint:`` is an opt-out comment, and an opt-out comment is a rubber
stamp — exactly like ``--update-baseline`` on the docs gate. It cannot stop a wrong
answer. What it removes is the *silence*: before this, adding a constraint to a
populated table produced no signal anywhere in the pipeline, and the author had no
prompt to think about existing rows at all.

Usage:
    python3 scripts/check-migration-constraint-safety.py [--list] [--root DIR]

``--root`` points the scan at another tree; it exists so the test suite can stage
throwaway migrations and prove the gate actually fails on them.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_API_SRC = _REPO_ROOT / "packages/api/src/trueppm_api/apps"
_MIGRATIONS_GLOB = "*/migrations/*.py"
_MARKER = "# safe-constraint:"


class _Operation:
    """One entry in a migration's ``operations`` list, reduced to what the rule needs."""

    def __init__(self, node: ast.Call) -> None:
        self.node = node
        self.name = _call_name(node)
        self.lineno = node.lineno
        self.end_lineno = node.end_lineno or node.lineno

    def kwarg(self, key: str) -> str | None:
        for kw in self.node.keywords:
            if kw.arg == key and isinstance(kw.value, ast.Constant):
                return str(kw.value.value)
        return None

    def first_arg(self) -> str | None:
        if self.node.args and isinstance(self.node.args[0], ast.Constant):
            return str(self.node.args[0].value)
        return None

    def model_name(self) -> str | None:
        """``model_name=`` for AddConstraint/AlterUniqueTogether, ``name=`` for CreateModel."""
        value = self.kwarg("model_name") or self.kwarg("name") or self.first_arg()
        return value.lower() if value else None


def _call_name(node: ast.Call) -> str:
    """``migrations.AddConstraint(...)`` → ``AddConstraint``."""
    func = node.func
    if isinstance(func, ast.Attribute):
        return func.attr
    if isinstance(func, ast.Name):
        return func.id
    return ""


def _migration_class(tree: ast.Module) -> ast.ClassDef | None:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Migration":
            return node
    return None


def _assigned_list(cls: ast.ClassDef, attr: str) -> ast.List | None:
    for node in cls.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == attr:
                    return node.value if isinstance(node.value, ast.List) else None
        elif isinstance(node, ast.AnnAssign):
            target = node.target
            if (
                isinstance(target, ast.Name)
                and target.id == attr
                and isinstance(node.value, ast.List)
            ):
                return node.value
    return None


def _has_marker(lines: list[str], op: _Operation) -> bool:
    """Is ``# safe-constraint:`` attached to this operation?

    Accepted either inside the call's own span or in the contiguous comment block
    immediately above it — the two places a reader would naturally write it.
    """
    for i in range(op.lineno - 1, min(op.end_lineno, len(lines))):
        if _MARKER in lines[i]:
            return True
    i = op.lineno - 2
    while i >= 0:
        stripped = lines[i].strip()
        if not stripped:
            i -= 1
            continue
        if not stripped.startswith("#"):
            break
        if _MARKER in stripped:
            return True
        i -= 1
    return False


def _scan(path: Path) -> tuple[list[str], list[str]]:
    """Return (violations, safe-descriptions) for one migration file."""
    source = path.read_text(encoding="utf-8")
    if "AddConstraint" not in source:
        return [], []

    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:  # pragma: no cover - a broken migration fails elsewhere
        return [f"{_rel(path)}: could not parse ({exc})"], []

    cls = _migration_class(tree)
    if cls is None:
        return [], []

    rel = _rel(path)
    ops_list = _assigned_list(cls, "operations")
    if ops_list is None:
        return [], []
    ops = [_Operation(el) for el in ops_list.elts if isinstance(el, ast.Call)]

    if _assigned_list(cls, "replaces") is not None:
        # Counted per constraint rather than per file so the total this prints is
        # comparable to a hand sweep of `grep AddConstraint`.
        return [], [
            f"{rel}:{op.lineno} ({op.model_name()}): squash (replaces=), already applied upstream"
            for op in ops
            if op.name == "AddConstraint"
        ]

    created = {op.model_name() for op in ops if op.name == "CreateModel"}
    retired_unique_together = {
        op.model_name() for op in ops if op.name == "AlterUniqueTogether"
    }

    violations: list[str] = []
    safe: list[str] = []
    for index, op in enumerate(ops):
        if op.name != "AddConstraint":
            continue
        model = op.model_name() or "<unknown>"
        where = f"{rel}:{op.lineno} ({model})"
        if model in created:
            safe.append(f"{where}: table created in this migration")
        elif model in retired_unique_together:
            safe.append(
                f"{where}: unique_together → UniqueConstraint, already enforced"
            )
        elif any(o.name == "RunPython" for o in ops[:index]):
            safe.append(f"{where}: preceded by a RunPython repair")
        elif _has_marker(lines, op):
            safe.append(f"{where}: {_MARKER} asserted")
        else:
            violations.append(where)
    return violations, safe


def _rel(path: Path) -> str:
    return str(path.relative_to(_REPO_ROOT))


def main(argv: list[str]) -> int:
    global _REPO_ROOT
    if "--root" in argv:
        _REPO_ROOT = Path(argv[argv.index("--root") + 1]).resolve()
    api_src = _REPO_ROOT / "packages/api/src/trueppm_api/apps"
    if not api_src.exists():
        print(
            f"→ migration-constraint-safety: {api_src} not found — run from the repo root."
        )
        return 1

    violations: list[str] = []
    safe: list[str] = []
    for path in sorted(api_src.glob(_MIGRATIONS_GLOB)):
        file_violations, file_safe = _scan(path)
        violations.extend(file_violations)
        safe.extend(file_safe)

    if "--list" in argv:
        for line in safe:
            print(f"  safe   {line}")

    if not violations:
        print(f"✓ All AddConstraint operations accounted for ({len(safe)} checked).")
        return 0

    print("✗ AddConstraint on a table that may already hold violating rows:\n")
    for line in violations:
        print(f"  {line}")
    print(
        "\nAddConstraint VALIDATES the new index against every existing row, and"
        "\nmigrations run on container start — so a violating row is an upgrade"
        "\ncrash-loop, not a failed deploy (#3068).\n"
        "\nEither repair the data first:\n"
        "\n    migrations.RunPython(_repair, migrations.RunPython.noop),\n"
        "    migrations.AddConstraint(...),\n"
        "\nor, if existing rows provably cannot violate it, say why:\n"
        f"\n    {_MARKER} <reason>\n"
        "    migrations.AddConstraint(...),\n"
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
