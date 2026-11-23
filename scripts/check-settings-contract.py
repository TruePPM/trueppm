#!/usr/bin/env python3
"""check-settings-contract.py -- three silent-regression checks on what operators and
clients are TOLD about the API (#3248, the gate #2861 row 9 named and nobody built).

  env-undocumented   an env var read under ``settings/`` that no administration doc names
  default-drift      a documented default that disagrees with the literal default in code
  unread-writable    a model field a serializer accepts on write that nothing else reads

The first two protect what #3190 achieved (159/159 env vars documented, 135 defaults
machine-compared, 0 mismatches) -- nothing checked it, so it could regress unseen. The
third is the "a control that saves must have a reader" class: four of five independent
audits on 2026-08-30 found it (``Workspace.work_week`` and friends).

RATCHET. Findings that exist today are recorded in ``packages/api/settings-contract-baseline.txt``
(``kind | key | issue | reason``). The gate fails on a finding that is NOT in the baseline,
and on a baseline entry that no longer reproduces (fix it, then drop the line:
``--update-baseline`` only ever removes). A line may not be ADDED against the merge base
unless the line above it is ``# raise-ok: <reason>`` -- that is a self-grant in the file it
guards, a rubber stamp a reviewer must read in the diff, exactly like
``app-layering-baseline.txt``. What it removes is the silence, not the wrong answer.

BLIND SPOTS -- read before trusting a green run.
  * ``unread-writable`` is textual. A reader is any ``.field`` / ``"field"`` / ``field=``
    / ``field__`` token in non-test, non-migration, non-serializer Python, or any
    ``\\bfield\\b`` in ``packages/web/src`` / ``packages/mcp`` outside ``api/types.ts``.
    So a common name (``status``, ``name``) is always "read" by an unrelated use, a field
    read only through ``getattr(obj, name_var)`` or a dynamic ``fields = "__all__"``
    walk is falsely flagged, and a reader that is a constant-False provider check (the
    ``*_override_policy`` fields, #3199) counts as a reader. It cannot see prose: a doc
    or docstring CLAIMING a consumer is not evidence, and the gate does not read it.
  * The unit is the FIELD, not the choice: ``Task.governance_class == "hybrid"`` (a value
    nothing branches on) reports green because the field has one reader.
  * ``default-drift`` compares only literal scalars (bool/int/str) against a docs table
    row whose header has a ``Default`` column; a computed default, a default built by a
    helper, or a name in a table with no Default column is not compared.
  * ``env-undocumented`` matches the backticked variable name anywhere in the docs tree,
    and ``TRUEPPM_X`` that code reads as a fallback of a bare name is checked under the
    name literally passed to ``env(...)``.
  * Names read outside ``settings/`` (``os.environ`` in apps, the Helm chart) are out of
    scope; the Helm half of #3190 is not gated here.

Modes:
  python3 scripts/check-settings-contract.py                  # check
  python3 scripts/check-settings-contract.py --self-test      # prove it can fail
  python3 scripts/check-settings-contract.py --update-baseline  # drop fixed entries only
  python3 scripts/check-settings-contract.py --print-findings   # raw findings, for seeding
"""

from __future__ import annotations

import ast
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API_SRC = "packages/api/src/trueppm_api"
BASELINE = "packages/api/settings-contract-baseline.txt"
DOC_DIRS = ("packages/website/src/content/docs",)
WEB_DIRS = ("packages/web/src", "packages/mcp")
WEB_EXCLUDE_SUFFIX = ("api/types.ts",)
SEED_ISSUE = "#3248"


# ---------------------------------------------------------------------------
# Env scan
# ---------------------------------------------------------------------------
def _str(node: ast.AST | None) -> str | None:
    return (
        node.value
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        else None
    )


def _is_env_call(func: ast.AST) -> bool:
    if isinstance(func, ast.Name):
        return func.id == "env"
    if isinstance(func, ast.Attribute):
        if isinstance(func.value, ast.Name) and func.value.id == "env":
            return True
        # os.environ.get / os.getenv
        if func.attr == "get" and isinstance(func.value, ast.Attribute):
            return func.value.attr == "environ"
        if func.attr == "getenv":
            return True
    return False


def scan_env(root: Path) -> dict[str, tuple[bool, object]]:
    """Return ``{NAME: (has_literal_default, default)}`` for every env read in settings/."""
    found: dict[str, tuple[bool, object]] = {}
    for path in sorted((root / API_SRC / "settings").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if (
                not isinstance(node, ast.Call)
                or not _is_env_call(node.func)
                or not node.args
            ):
                continue
            name = _str(node.args[0])
            if name is None or not re.fullmatch(r"[A-Z][A-Z0-9_]+", name):
                continue
            default: ast.AST | None = None
            for kw in node.keywords:
                if kw.arg == "default":
                    default = kw.value
            if default is None and len(node.args) > 1:
                default = node.args[1]
            lit = isinstance(default, ast.Constant) and isinstance(
                default.value, (bool, int, str)
            )
            prev = found.get(name)
            # Keep the first literal default seen; a later non-literal read never erases it.
            if prev is None or (lit and not prev[0]):
                found[name] = (
                    lit,
                    default.value if lit and default is not None else None,
                )  # type: ignore[union-attr]
    return found


def _norm(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().strip("`").strip("\"'").strip().lower()


def doc_tables(root: Path) -> tuple[set[str], dict[str, str]]:
    """Return (every backticked token in the docs, ``{VAR: documented default}``)."""
    names: set[str] = set()
    defaults: dict[str, str] = {}
    for d in DOC_DIRS:
        for md in sorted((root / d).rglob("*.md*")):
            text = md.read_text(encoding="utf-8", errors="replace")
            names.update(re.findall(r"`([A-Z][A-Z0-9_]{2,})`", text))
            # Bare KEY=value lines in code fences also name a variable.
            names.update(re.findall(r"^\s*([A-Z][A-Z0-9_]{2,})=", text, flags=re.M))
            col: int | None = None
            for line in text.splitlines():
                if not line.startswith("|"):
                    col = None
                    continue
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                if any(c.lower() == "default" for c in cells) and col is None:
                    col = [c.lower() for c in cells].index("default")
                    continue
                if col is None or col >= len(cells) or set(line) <= set("|-: "):
                    continue
                m = re.fullmatch(r"`([A-Z][A-Z0-9_]{2,})`", cells[0])
                if m:
                    defaults.setdefault(m.group(1), cells[col])
    return names, defaults


def _doc_default_norm(cell: str) -> str | None:
    cell = cell.strip()
    if cell.lower() in ("_(empty)_", "*(empty)*", "(empty)", "empty", '`""`', "``"):
        return ""
    m = re.fullmatch(r"`([^`]*)`", cell)
    if not m:
        return None  # prose, ranges, "unset": not machine-comparable
    return (
        _norm(m.group(1).replace(",", "").replace("_", ""))
        if re.fullmatch(r"[\d,_]+", m.group(1))
        else _norm(m.group(1))
    )


def env_findings(root: Path) -> dict[tuple[str, str], str]:
    env = scan_env(root)
    names, defaults = doc_tables(root)
    out: dict[tuple[str, str], str] = {}
    for name, (lit, code_default) in sorted(env.items()):
        if name not in names:
            out[("env-undocumented", name)] = (
                "read in settings/ but named in no docs page"
            )
            continue
        if lit and name in defaults:
            doc = _doc_default_norm(defaults[name])
            code = _norm(code_default)
            if (
                code_default is not None
                and isinstance(code_default, int)
                and not isinstance(code_default, bool)
            ):
                code = str(code_default)
            if doc is not None and doc != code:
                out[("default-drift", name)] = (
                    f"docs say {defaults[name]!r}, code says {code!r}"
                )
    return out


# ---------------------------------------------------------------------------
# Writable-field-has-reader
# ---------------------------------------------------------------------------
_FIELD_CALL = re.compile(
    r"^(models\.)?\w*(Field|ForeignKey|OneToOneField|ManyToManyField)$"
)


def _py_files(root: Path, *, skip_serializers: bool) -> list[Path]:
    out = []
    for p in (root / API_SRC).rglob("*.py"):
        parts = p.parts
        if "migrations" in parts or "tests" in parts or "__pycache__" in parts:
            continue
        if skip_serializers and p.name.startswith("serializers"):
            continue
        out.append(p)
    return out


def model_fields(root: Path) -> dict[str, dict[str, str]]:
    """``{ModelName: {field: 'app/models.py'}}`` for concrete assignments in models*.py."""
    models: dict[str, dict[str, str]] = {}
    for p in (root / API_SRC).rglob("models*.py"):
        if "migrations" in p.parts or "tests" in p.parts:
            continue
        tree = ast.parse(p.read_text(encoding="utf-8"))
        for cls in [n for n in tree.body if isinstance(n, ast.ClassDef)]:
            fields: dict[str, str] = {}
            for stmt in cls.body:
                if (
                    isinstance(stmt, ast.Assign)
                    and len(stmt.targets) == 1
                    and isinstance(stmt.targets[0], ast.Name)
                    and isinstance(stmt.value, ast.Call)
                ):
                    fn = stmt.value.func
                    fname = (
                        fn.attr
                        if isinstance(fn, ast.Attribute)
                        else getattr(fn, "id", "")
                    )
                    if _FIELD_CALL.match(fname) and not stmt.targets[0].id.startswith(
                        "_"
                    ):
                        fields[stmt.targets[0].id] = str(p.relative_to(root))
            if fields:
                models.setdefault(cls.name, {}).update(fields)
    return models


def _meta(cls: ast.ClassDef) -> dict[str, ast.AST]:
    for stmt in cls.body:
        if isinstance(stmt, ast.ClassDef) and stmt.name == "Meta":
            return {
                t.id: s.value
                for s in stmt.body
                if isinstance(s, ast.Assign)
                for t in s.targets
                if isinstance(t, ast.Name)
            }
    return {}


def _names(node: ast.AST | None) -> list[str]:
    if isinstance(node, (ast.List, ast.Tuple)):
        return [
            e.value
            for e in node.elts
            if isinstance(e, ast.Constant) and isinstance(e.value, str)
        ]
    return []


def writable_fields(
    root: Path, models: dict[str, dict[str, str]]
) -> set[tuple[str, str]]:
    """``{(Model, field)}`` a ModelSerializer lists in ``Meta.fields`` as writable."""
    out: set[tuple[str, str]] = set()
    for p in (root / API_SRC).rglob("serializers*.py"):
        if "tests" in p.parts:
            continue
        tree = ast.parse(p.read_text(encoding="utf-8"))
        for cls in [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]:
            meta = _meta(cls)
            model = meta.get("model")
            mname = (
                model.id
                if isinstance(model, ast.Name)
                else getattr(model, "attr", None)
            )
            if mname not in models:
                continue
            listed = _names(meta.get("fields"))
            ro = set(_names(meta.get("read_only_fields")))
            for stmt in (
                cls.body
            ):  # explicit declarations that are read_only / replace the model field
                if isinstance(stmt, ast.Assign) and isinstance(
                    stmt.targets[0], ast.Name
                ):
                    ro.add(stmt.targets[0].id)
            for f in listed:
                if f in models[mname] and f not in ro:
                    out.add((mname, f))
    return out


def reader_corpus(root: Path) -> tuple[str, str]:
    py = "\n".join(
        p.read_text(encoding="utf-8", errors="replace")
        for p in _py_files(root, skip_serializers=True)
    )
    web_parts: list[str] = []
    for d in WEB_DIRS:
        base = root / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.suffix not in (".ts", ".tsx", ".py") or {
                "node_modules",
                ".venv",
                "dist",
            } & set(p.parts):
                continue
            if (
                p.name.endswith((".test.ts", ".test.tsx", ".spec.ts"))
                or "tests" in p.parts
            ):
                continue
            if str(p).endswith(WEB_EXCLUDE_SUFFIX):
                continue
            web_parts.append(p.read_text(encoding="utf-8", errors="replace"))
    return py, "\n".join(web_parts)


def has_reader(field: str, py: str, web: str) -> bool:
    f = re.escape(field)
    py_pat = re.compile(
        rf"\.{f}\b|[\"']{f}[\"']|[(,]\s*{f}=|^\s+{f}=|\b{f}__|__{f}\b", re.M
    )
    return bool(py_pat.search(py) or re.search(rf"\b{f}\b", web))


def reader_findings(root: Path) -> dict[tuple[str, str], str]:
    models = model_fields(root)
    py, web = reader_corpus(root)
    out: dict[tuple[str, str], str] = {}
    for model, field in sorted(writable_fields(root, models)):
        if not has_reader(field, py, web):
            out[("unread-writable", f"{model}.{field}")] = (
                f"serializer-writable, no reader outside {models[model][field]}, serializers and migrations"
            )
    return out


# ---------------------------------------------------------------------------
# Baseline ratchet
# ---------------------------------------------------------------------------
def load_baseline(text: str) -> dict[tuple[str, str], tuple[str, bool]]:
    """``{(kind, key): (line, raise_ok)}``; raise_ok is the previous line's marker."""
    out: dict[tuple[str, str], tuple[str, bool]] = {}
    prev = ""
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            parts = [p.strip() for p in s.split("|")]
            if len(parts) >= 2:
                out[(parts[0], parts[1])] = (s, prev.startswith("# raise-ok:"))
        prev = s
    return out


def base_baseline(root: Path) -> str | None:
    ref = os.environ.get("CI_MERGE_REQUEST_DIFF_BASE_SHA") or "origin/main"
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "show", f"{ref}:{BASELINE}"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    return r.stdout if r.returncode == 0 else None


def run_check(root: Path, *, compare_base: bool = True) -> list[str]:
    findings = {**env_findings(root), **reader_findings(root)}
    path = root / BASELINE
    base = load_baseline(path.read_text(encoding="utf-8")) if path.exists() else {}
    errors: list[str] = []
    for key, why in sorted(findings.items()):
        if key not in base:
            errors.append(
                f"NEW  {key[0]} | {key[1]}  ({why}). Fix it; or, for a deliberately parked "
                f"one, add `{key[0]} | {key[1]} | #<issue> | <reason>` to {BASELINE}."
            )
    for key in sorted(set(base) - set(findings)):
        errors.append(
            f"STALE  {key[0]} | {key[1]} no longer reproduces -- delete it from {BASELINE} "
            "(python3 scripts/check-settings-contract.py --update-baseline)."
        )
    if compare_base:
        old = base_baseline(root)
        if old is not None:
            before = load_baseline(old)
            for key, (line, raise_ok) in sorted(base.items()):
                if key not in before and not raise_ok:
                    errors.append(
                        f"RAISED  {line!r} is new against the merge base; a baseline can only "
                        "shrink. A deliberate addition needs `# raise-ok: <reason>` on the line above."
                    )
    return errors


def update_baseline(root: Path) -> int:
    findings = {**env_findings(root), **reader_findings(root)}
    path = root / BASELINE
    kept, dropped = [], 0
    prev_marker = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            parts = [p.strip() for p in s.split("|")]
            if len(parts) >= 2 and (parts[0], parts[1]) not in findings:
                dropped += 1
                if kept and kept[-1].strip().startswith("# raise-ok:"):
                    kept.pop()
                continue
        kept.append(line)
        prev_marker = s
    del prev_marker
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    print(f"dropped {dropped} fixed entr{'y' if dropped == 1 else 'ies'}; never adds.")
    return 0


def print_findings(root: Path) -> int:
    for (kind, key), why in sorted(
        {**env_findings(root), **reader_findings(root)}.items()
    ):
        print(f"{kind} | {key} | {SEED_ISSUE} | seeded from main, unreviewed: {why}")
    return 0


# ---------------------------------------------------------------------------
# Self-test: build a tiny tree, require each rule to fire AND the clean shape to pass.
# ---------------------------------------------------------------------------
def self_test() -> int:
    ok = True

    def check(cond: bool, msg: str) -> None:
        nonlocal ok
        if not cond:
            print(f"SELF-TEST FAIL: {msg}")
            ok = False

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        app = root / API_SRC / "apps" / "demo"
        (root / API_SRC / "settings").mkdir(parents=True)
        app.mkdir(parents=True)
        docs = root / DOC_DIRS[0] / "administration"
        docs.mkdir(parents=True)
        (root / "packages/web/src").mkdir(parents=True)
        (root / "packages/api").mkdir(parents=True, exist_ok=True)
        (root / API_SRC / "settings" / "base.py").write_text(
            "SECRET = env('TRUEPPM_DOCUMENTED', default='5')\n"
            "A = env.bool('TRUEPPM_DRIFTED', default=False)\n"
            "B = env('TRUEPPM_UNDOCUMENTED', default='x')\n"
        )
        (docs / "cfg.md").write_text(
            "| Variable | Default | Effect |\n|---|---|---|\n"
            "| `TRUEPPM_DOCUMENTED` | `5` | ok |\n"
            "| `TRUEPPM_DRIFTED` | `true` | wrong |\n"
        )
        (app / "models.py").write_text(
            "class Thing(models.Model):\n"
            "    read_me = models.CharField(max_length=5)\n"
            "    ghost = models.CharField(max_length=5)\n"
            "    derived = models.CharField(max_length=5)\n"
        )
        (app / "serializers.py").write_text(
            "class ThingSerializer(serializers.ModelSerializer):\n"
            "    class Meta:\n"
            "        model = Thing\n"
            "        fields = ['read_me', 'ghost', 'derived']\n"
            "        read_only_fields = ['derived']\n"
        )
        (app / "services.py").write_text("def use(t):\n    return t.read_me\n")
        env = env_findings(root)
        check(
            ("env-undocumented", "TRUEPPM_UNDOCUMENTED") in env,
            "undocumented env not flagged",
        )
        check(
            ("default-drift", "TRUEPPM_DRIFTED") in env,
            "documented-default drift not flagged",
        )
        check(
            ("default-drift", "TRUEPPM_DOCUMENTED") not in env,
            "matching default flagged",
        )
        rd = reader_findings(root)
        check(
            ("unread-writable", "Thing.ghost") in rd,
            "writable field with no reader not flagged",
        )
        check(("unread-writable", "Thing.read_me") not in rd, "read field flagged")
        check(("unread-writable", "Thing.derived") not in rd, "read-only field flagged")
        # A web-only reader counts.
        (root / "packages/web/src/x.ts").write_text("const g = row.ghost;\n")
        check(
            ("unread-writable", "Thing.ghost") not in reader_findings(root),
            "web reader ignored",
        )
        (root / "packages/web/src/x.ts").unlink()
        # Ratchet: empty baseline -> NEW errors; full baseline -> clean; stale -> STALE.
        (root / BASELINE).write_text("")
        errs = run_check(root, compare_base=False)
        check(
            any(e.startswith("NEW") for e in errs) and len(errs) == 3,
            f"empty baseline: {errs}",
        )
        lines = "".join(
            f"{k} | {n} | #1 | t\n"
            for (k, n) in {**env_findings(root), **reader_findings(root)}
        )
        (root / BASELINE).write_text(lines)
        check(run_check(root, compare_base=False) == [], "full baseline not clean")
        (root / BASELINE).write_text(
            lines + "env-undocumented | TRUEPPM_GONE | #1 | t\n"
        )
        check(
            any(e.startswith("STALE") for e in run_check(root, compare_base=False)),
            "stale not flagged",
        )
        update_baseline(root)
        check(
            run_check(root, compare_base=False) == [],
            "update-baseline did not drop stale entry",
        )
        # raise-ok marker is parsed.
        bl = load_baseline(
            "# raise-ok: because\nenv-undocumented | X | #1 | r\nenv-undocumented | Y | #1 | r\n"
        )
        check(
            bl[("env-undocumented", "X")][1] and not bl[("env-undocumented", "Y")][1],
            "raise-ok parse",
        )
    print("self-test: OK" if ok else "self-test: FAILED")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if "--update-baseline" in argv:
        return update_baseline(REPO)
    if "--print-findings" in argv:
        return print_findings(REPO)
    errors = run_check(REPO)
    for e in errors:
        print(e, file=sys.stderr)
    if errors:
        print(
            f"\n{len(errors)} settings-contract problem(s); see scripts/check-settings-contract.py header.",
            file=sys.stderr,
        )
        return 1
    print("settings-contract: OK (no finding beyond the ratcheted baseline)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
