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
    python3 scripts/check-migration-constraint-safety.py --self-test

``--root`` points the scan at another tree; it exists so the test suite can stage
throwaway migrations and prove the gate actually fails on them. ``--self-test``
does that from inside this script, over the fixture shapes in ``_self_test_cases``
— see that function for why the proof has to run here and not only in
``scripts/tests/check-migration-constraint-safety.test.sh`` (#3194, #3195).
"""

from __future__ import annotations

import ast
import contextlib
import io
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

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


def _names_attr(target: ast.expr, attr: str) -> bool:
    """Does this assignment target bind the bare name ``attr``?"""
    return isinstance(target, ast.Name) and target.id == attr


def _assigned_list(cls: ast.ClassDef, attr: str) -> ast.List | None:
    for node in cls.body:
        if isinstance(node, ast.Assign):
            if any(_names_attr(t, attr) for t in node.targets):
                # A plain assignment settles it: a non-list value means there is
                # no list to scan, and we stop rather than look for a later
                # rebinding of the same name.
                return node.value if isinstance(node.value, ast.List) else None
        elif isinstance(node, ast.AnnAssign) and _names_attr(node.target, attr):
            # An ANNOTATED assignment whose value is not a list falls through to
            # the next statement instead of stopping. That asymmetry with the
            # branch above is pre-existing and preserved deliberately — this
            # refactor is shape-preserving, and `make pre-push` runs this gate on
            # every push, so changing its answers is not in scope here.
            if isinstance(node.value, ast.List):
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


class _Case(NamedTuple):
    """One fixture tree: a single migration, and the verdict the gate must reach."""

    name: str
    expect: int  # the exit code the gate must return: 0 accepted, 1 rejected
    operations: str  # the body of the migration's `operations` list, indented 8
    prelude: str = ""  # module-level defs the operations reference
    replaces: str = ""  # a `replaces = [...]` class attribute, if the case needs one
    mentions: tuple[str, ...] = ()  # substrings a rejection must name


def _fixture(case: _Case) -> str:
    """Assemble a throwaway migration file around ``case.operations``.

    Only the wrapper is generated. The ``operations`` list is written out
    literally in each case, because that list *is* the shape the rule reads —
    generating it would put a second description of the rule in this file, which
    is the thing a self-test must not do.
    """
    return (
        "from django.db import migrations, models\n\n\n"
        f"{case.prelude}"
        "class Migration(migrations.Migration):\n"
        f"{case.replaces}"
        '    dependencies = [("projects", "0001_initial")]\n'
        "    operations = [\n"
        f"{case.operations}"
        "    ]\n"
    )


_REPAIR_DEF = "def _repair(apps, schema_editor):\n    pass\n\n\n"


def _self_test_cases() -> list[_Case]:
    """The fixture shapes, one per branch of the rule.

    These are the shapes already used by
    ``scripts/tests/check-migration-constraint-safety.test.sh``, on purpose. That
    suite stays and remains the fuller matrix — marker placement inside vs above
    the call, marker carry-over between adjacent constraints, the real tree's
    site count. This is the subset that has to run in the gate's OWN CI job.

    Same job is the only way to say "same image" in GitLab CI, and the image is
    what differed in #3172: ``check-enterprise-imports.test.sh`` passed on
    python:3.11-slim for the entire life of a gate that, on alpine, could not
    detect anything at all. A suite that runs elsewhere is evidence about
    elsewhere.

    Both directions are covered because only one of them is optional-looking. A
    gate that has only ever been watched passing on a clean tree is
    indistinguishable from one with a typo in its pattern; a gate that rejects
    the four legitimately-safe shapes gets papered over with blanket
    ``# safe-constraint:`` comments within a day, which takes the real
    protection with it.
    """
    return [
        # --- REJECT: the #3068 shape itself. ------------------------------
        _Case(
            name="an unguarded AddConstraint on a pre-existing table",
            expect=1,
            operations=(
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                "            constraint=models.UniqueConstraint(\n"
                '                fields=["project", "wbs_path"], name="uniq"\n'
                "            ),\n"
                "        ),\n"
            ),
            mentions=("0002_thing.py", "(task)"),
        ),
        # --- ACCEPT: safe shape 4, a RunPython repair precedes it. --------
        _Case(
            name="a preceding RunPython repair",
            expect=0,
            prelude=_REPAIR_DEF,
            operations=(
                "        migrations.RunPython(_repair, migrations.RunPython.noop),\n"
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                "            constraint=models.UniqueConstraint(\n"
                '                fields=["project", "wbs_path"], name="uniq"\n'
                "            ),\n"
                "        ),\n"
            ),
        ),
        # --- REJECT: the repair must come FIRST; order is the whole point. -
        _Case(
            name="a RunPython that runs AFTER the constraint",
            expect=1,
            prelude=_REPAIR_DEF,
            operations=(
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                '            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),\n'
                "        ),\n"
                "        migrations.RunPython(_repair, migrations.RunPython.noop),\n"
            ),
        ),
        # --- ACCEPT: safe shape 1, the table is created here and is empty. -
        _Case(
            name="the model created by CreateModel in the same migration",
            expect=0,
            operations=(
                '        migrations.CreateModel(name="Thing", fields=[]),\n'
                "        migrations.AddConstraint(\n"
                '            model_name="thing",\n'
                '            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),\n'
                "        ),\n"
            ),
        ),
        # --- REJECT: a CreateModel for ANOTHER model launders nothing. ----
        _Case(
            name="a CreateModel for a different model",
            expect=1,
            operations=(
                '        migrations.CreateModel(name="Unrelated", fields=[]),\n'
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                '            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),\n'
                "        ),\n"
            ),
        ),
        # --- ACCEPT: safe shape 3, unique_together → UniqueConstraint. ----
        _Case(
            name="an AlterUniqueTogether conversion for the same model",
            expect=0,
            operations=(
                "        migrations.AlterUniqueTogether(\n"
                '            name="taskresource", unique_together=set()\n'
                "        ),\n"
                "        migrations.AddConstraint(\n"
                '            model_name="taskresource",\n'
                "            constraint=models.UniqueConstraint(\n"
                '                fields=["task", "resource"], name="uniq"\n'
                "            ),\n"
                "        ),\n"
            ),
        ),
        # --- ACCEPT: safe shape 2, a squash re-states validated constraints.
        _Case(
            name="a replaces= squash migration",
            expect=0,
            replaces=(
                "    replaces = ["
                '("projects", "0001_initial"), ("projects", "0002_thing")]\n'
            ),
            operations=(
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                '            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),\n'
                "        ),\n"
            ),
        ),
        # --- ACCEPT: the explicit opt-out.
        #
        # Be honest about what this branch is. `# safe-constraint:` is a rubber
        # stamp, the same shape as `--update-baseline` on the docs gate: it
        # cannot stop a wrong answer, and nothing here or anywhere else reads
        # the reason the author typed. What it removes is the SILENCE — before
        # this gate, adding a constraint to a populated table produced no signal
        # in the pipeline at all, and the author was never prompted to think
        # about the rows already in the table. The case below proves the escape
        # hatch still opens; it does not, and cannot, prove any use of it right.
        _Case(
            name="an explicit # safe-constraint: opt-out",
            expect=0,
            operations=(
                "        # safe-constraint: both columns are added by this migration, so\n"
                "        # every existing row holds NULL and Postgres treats NULLs as distinct.\n"
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                "            constraint=models.UniqueConstraint(\n"
                '                fields=["a", "b"], name="uniq"\n'
                "            ),\n"
                "        ),\n"
            ),
        ),
        # --- REJECT: a comment that merely reads safe is not the marker. --
        _Case(
            name="a comment missing the marker's colon form",
            expect=1,
            operations=(
                "        # safe constraint, honest\n"
                "        migrations.AddConstraint(\n"
                '            model_name="task",\n'
                '            constraint=models.UniqueConstraint(fields=["a"], name="uniq"),\n'
                "        ),\n"
            ),
        ),
    ]


def _run_case(case: _Case, tree: Path) -> str | None:
    """Run the REAL gate over a one-migration tree. Returns a failure line, or None."""
    global _REPO_ROOT

    source = _fixture(case)
    try:
        # A fixture with a typo in it parses nowhere, and _scan reports that as a
        # violation — so every REJECT case would keep passing while proving
        # nothing about the rule. Fail on the broken fixture instead.
        ast.parse(source)
    except SyntaxError as exc:
        return f"{case.name}: fixture is not valid Python ({exc})"

    migrations_dir = tree / "packages/api/src/trueppm_api/apps/projects/migrations"
    migrations_dir.mkdir(parents=True)
    (migrations_dir / "0002_thing.py").write_text(source, encoding="utf-8")

    saved_root = _REPO_ROOT
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            code = main(["--root", str(tree)])
    finally:
        # main() rebinds the module-global root. Restore it, so that a real scan
        # later in the same process still points at this repo.
        _REPO_ROOT = saved_root

    if code != case.expect:
        got = "accepted" if code == 0 else "rejected"
        return f"{case.name}: gate {got} it (exit {code}), expected exit {case.expect}"
    output = captured.getvalue()
    for needle in case.mentions:
        if needle not in output:
            # A rejection that cannot say which file and which model is a
            # rejection an author cannot act on.
            return f"{case.name}: rejection never names {needle!r}"
    return None


def _self_test() -> int:
    """Prove this gate still rejects #3068's shape and still accepts the safe four.

    Every case runs the real ``main()`` against a fixture root, so there is no
    second copy of the rule in this file to drift away from the one above.
    """
    cases = _self_test_cases()
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, case in enumerate(cases):
            failure = _run_case(case, Path(tmp) / f"case{index:02d}")
            if failure is None:
                verdict = "accepted" if case.expect == 0 else "rejected"
                print(f"SELF-TEST OK: {case.name} — correctly {verdict}.")
            else:
                # Per-case lines all go to stdout: the two streams are buffered
                # independently in a CI log, and a FAIL printed out of order
                # next to the OK lines is harder to read than it is worth.
                failures.append(failure)
                print(f"SELF-TEST FAIL: {failure}")

    if failures:
        sys.stdout.flush()
        print(
            f"\nSELF-TEST: {len(failures)} of {len(cases)} cases failed — this gate "
            "is not detecting what it claims to.",
            file=sys.stderr,
        )
        return 1
    print(f"\nSELF-TEST: all {len(cases)} cases passed.")
    return 0


def main(argv: list[str]) -> int:
    global _REPO_ROOT
    if "--self-test" in argv:
        return _self_test()
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
