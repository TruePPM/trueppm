#!/usr/bin/env python3
"""check-settings-contract.py -- three silent-regression checks on what operators and
clients are TOLD about the API (#3248, the gate #2861 row 9 named and nobody built).

  env-undocumented   an env var read under ``settings/`` that no page in the published docs
                     tree (``packages/website/src/content/docs``) names in backticks
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
  * ``unread-writable`` is a name-level approximation, not data flow. A READ is: in
    non-test, non-migration Python, an attribute load ``obj.field`` (not an assignment
    target), a keyword ``field=`` / ``field__x=`` on a lookup call (``filter``, ``get``,
    ``Q``...), or a lowercase string constant; in a serializer module, only an attribute
    load outside the write path (``validate*``, ``create`` / ``update`` / ``save`` /
    ``perform_*`` / ``to_internal_value``), i.e. a ``get_*`` / ``to_representation``
    computed from it. A write-path method NOT in that list (a ``_apply_x`` helper that
    does ``instance.x = validated_data.get("x", instance.x)``) still counts as a read. In
    ``packages/web/src`` / ``packages/mcp`` (minus ``api/types.ts``): ``.field`` that is
    not assigned, ``"field"`` that is not an object key, or a name bound by
    ``const { .. } =``. NOT a read: ``obj.field = v``, ``field=`` passed to ``create`` /
    ``update`` / ``save`` / ``update_or_create`` / a ``Model(..)`` constructor, the names
    in ``update_fields=`` / ``defaults=``, ``setattr(obj, "field", ..)``, a TS object key
    ``{ field: v }`` or JSX prop ``field={v}``. What still fools it: the unit is the NAME,
    so a common name (``status``, ``name``) is "read" by an unrelated model's use; a
    form that reads its own state back (``values.field``) to build the payload counts;
    ``register("field")``-style string bindings count; a field read only through
    ``getattr(obj, name_var)`` is falsely flagged; and a constant-False provider check
    (the ``*_override_policy`` fields, #3199) counts. It cannot see prose: a doc or
    docstring CLAIMING a consumer is not evidence.
  * The unit is the FIELD, not the choice: ``Task.governance_class == "hybrid"`` (a value
    nothing branches on) reports green because the field has one reader.
  * ``default-drift`` compares only literal scalars (bool/int/str) against a docs table
    row whose header has a ``Default`` column; a computed default, a default built by a
    helper, or a name in a table with no Default column is not compared. The OK line
    prints how many were compared.
  * ``env-undocumented`` sees ``env(..)``, ``env.<cast>(..)``, ``os.environ.get`` /
    ``os.getenv``, ``os.environ["X"]`` and ``env_with_legacy(env, NAME, LEGACY, default)``
    (NAME is compared with ``default``; the deprecated LEGACY alias must be named in the
    docs too). A name built at runtime (an f-string, a loop over a list) or read through
    any other helper is invisible.
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
COMPARED: set[str] = set()  # env names whose documented default was machine-compared


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


def _record(
    found: dict[str, tuple[bool, object]], name: str | None, default: ast.AST | None
) -> None:
    if name is None or not re.fullmatch(r"[A-Z][A-Z0-9_]+", name):
        return
    lit = isinstance(default, ast.Constant) and isinstance(
        default.value, (bool, int, str)
    )
    prev = found.get(name)
    # Keep the first literal default seen; a later non-literal read never erases it.
    if prev is None or (lit and not prev[0]):
        found[name] = (lit, default.value if lit else None)  # type: ignore[union-attr]


def _is_os_environ(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "environ"


def scan_env(root: Path) -> dict[str, tuple[bool, object]]:
    """Return ``{NAME: (has_literal_default, default)}`` for every env read in settings/.

    Recognized reads: ``env(NAME, default=...)``, ``env.<cast>(NAME, ...)``,
    ``os.environ.get(NAME, ...)``, ``os.getenv(NAME, ...)``, ``os.environ[NAME]`` (no
    default), and ``env_with_legacy(env, NAME, LEGACY, default, cast)`` -- NAME is
    compared with ``default``; the deprecated LEGACY alias is checked for documentation
    only (it has no default of its own).
    """
    found: dict[str, tuple[bool, object]] = {}
    for path in sorted((root / API_SRC / "settings").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Subscript) and _is_os_environ(node.value):
                _record(found, _str(node.slice), None)
                continue
            if not isinstance(node, ast.Call):
                continue
            fn = node.func
            fname = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", "")
            if fname == "env_with_legacy":
                args = list(node.args)
                kws = {kw.arg: kw.value for kw in node.keywords}
                name = _str(args[1]) if len(args) > 1 else _str(kws.get("prefixed"))
                legacy = _str(args[2]) if len(args) > 2 else _str(kws.get("legacy"))
                default = args[3] if len(args) > 3 else kws.get("default")
                _record(found, name, default)
                _record(found, legacy, None)
                continue
            if not _is_env_call(fn) or not node.args:
                continue
            default = None
            for kw in node.keywords:
                if kw.arg == "default":
                    default = kw.value
            if default is None and len(node.args) > 1:
                default = node.args[1]
            _record(found, _str(node.args[0]), default)
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
    COMPARED.clear()
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
            if doc is not None:
                COMPARED.add(name)
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
                    server_set = any(
                        kw.arg in ("auto_now", "auto_now_add", "editable")
                        and isinstance(kw.value, ast.Constant)
                        and kw.value.value is (kw.arg != "editable")
                        for kw in stmt.value.keywords
                    )  # server-set or non-editable: never client-writable
                    if (
                        _FIELD_CALL.match(fname)
                        and not server_set
                        and not stmt.targets[0].id.startswith("_")
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
            ro_node = meta.get("read_only_fields")
            if isinstance(ro_node, ast.Name) and ro_node.id == "fields":
                continue  # ``read_only_fields = fields``: every listed field is read-only
            if isinstance(ro_node, ast.Name):  # a same-class list assigned by name
                ro_node = next(
                    (
                        st.value
                        for st in cls.body
                        if isinstance(st, ast.Assign)
                        and any(
                            isinstance(t, ast.Name) and t.id == ro_node.id
                            for t in st.targets
                        )
                    ),
                    None,
                )
            ro = set(_names(ro_node))
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


# Calls whose keyword arguments WRITE a field rather than read it (``Model(x=..)``,
# ``qs.update(x=..)``, ``serializer.save(x=..)``). Lookup calls (``filter``, ``get``,
# ``exclude``, ``Q``) keep counting as reads.
_WRITE_METHODS = frozenset(
    {
        "create",
        "update",
        "bulk_create",
        "bulk_update",
        "save",
        "update_or_create",
        "get_or_create",
        "aupdate",
        "acreate",
        "asave",
    }
)
_LOOKUP_CTORS = frozenset({"Q", "F", "Prefetch", "OuterRef", "Value"})
# Keywords whose value is a list/dict of field NAMES being written.
_WRITE_NAME_KWARGS = frozenset({"update_fields", "defaults", "create_defaults"})


_SERIALIZER_WRITE_METHODS = frozenset(
    {"create", "update", "save", "bulk_create", "bulk_update", "to_internal_value"}
)


class _PyReads(ast.NodeVisitor):
    """Collect field names a Python module READS: attribute loads, lookup kwargs,
    string constants -- minus assignment targets, write-call kwargs, ``update_fields``
    / ``defaults`` name lists and ``setattr(obj, "name", ..)``."""

    def __init__(self) -> None:
        self.reads: set[str] = set()
        self._skip_strings: set[int] = set()
        # In a serializer module only attribute loads count (``obj.x`` in a
        # ``get_*`` method): its strings are ``Meta.fields`` and input-dict keys.
        self.strings = True
        self.kwargs = True

    def _add(self, name: str) -> None:
        for part in name.split("__"):
            if part:
                self.reads.add(part)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        # In a serializer module, ``validate*`` reads the value only to check it on the
        # way in, and ``create``/``update``/``save``/``perform_*``/``to_internal_value``
        # are the WRITE path: ``instance.x = validated_data.get("x", instance.x)`` is
        # the field's only writer, not a consumer.
        if not self.strings and (
            node.name.startswith(("validate", "perform_"))
            or node.name in _SERIALIZER_WRITE_METHODS
        ):
            return
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Load):
            self.reads.add(node.attr)
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if isinstance(node.target, ast.Attribute):  # ``obj.x += 1`` reads x too
            self.reads.add(node.target.attr)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        fn = node.func
        fname = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
        is_write = fname in _WRITE_METHODS or (
            isinstance(fn, ast.Name)
            and fname[:1].isupper()
            and fname not in _LOOKUP_CTORS
        )
        for kw in node.keywords:
            if kw.arg is None:
                continue
            if kw.arg in _WRITE_NAME_KWARGS:
                for sub in ast.walk(kw.value):
                    if isinstance(sub, ast.Dict):
                        self._skip_strings.update(
                            id(k) for k in sub.keys if k is not None
                        )
                    elif isinstance(sub, (ast.List, ast.Tuple, ast.Set)):
                        self._skip_strings.update(id(e) for e in sub.elts)
            elif not is_write and self.kwargs:
                self._add(kw.arg)
        if fname == "setattr" and len(node.args) > 1:
            self._skip_strings.add(id(node.args[1]))
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if (
            self.strings
            and isinstance(node.value, str)
            and id(node) not in self._skip_strings
            and re.fullmatch(r"-?[a-z_][a-z0-9_]*", node.value)
        ):
            self._add(node.value.lstrip("-"))


def _web_reads(text: str) -> set[str]:
    """Names TypeScript READS: ``.x`` / ``?.x``, ``["x"]``, a quoted ``"x"`` that is not
    an object key, and names bound by a destructuring ``const {..} =``. An object-literal
    key (``{ x: value }``, the payload a form sends) and a JSX prop ``x=`` are writes."""
    reads = set(re.findall(r"\.([A-Za-z_]\w*)\b(?!\s*=(?![=>]))", text))
    reads |= set(re.findall(r"""["']([a-z_][a-z0-9_]*)["'](?!\s*:)""", text))
    for body in re.findall(r"(?:const|let|var)\s*\{([^{}=]*)\}\s*=(?![=>])", text):
        reads |= set(
            re.findall(r"(?:^|[,\s])([A-Za-z_]\w*)(?=\s*(?:[,:]|$))", body.strip())
        )
    return reads


def reader_corpus(root: Path) -> tuple[set[str], set[str]]:
    py = _PyReads()
    for p in _py_files(root, skip_serializers=False):
        py.strings = py.kwargs = not p.name.startswith("serializers")
        try:
            py.visit(ast.parse(p.read_text(encoding="utf-8", errors="replace")))
        except SyntaxError:
            continue
    web: set[str] = set()
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
            text = p.read_text(encoding="utf-8", errors="replace")
            if p.suffix == ".py":  # packages/mcp is Python: same AST rules
                try:
                    v = _PyReads()
                    v.visit(ast.parse(text))
                    web |= v.reads
                except SyntaxError:
                    pass
            else:
                web |= _web_reads(text)
    return py.reads, web


def has_reader(field: str, py: set[str], web: set[str]) -> bool:
    return field in py or field in web


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
def load_baseline(text: str) -> dict[tuple[str, str], tuple[str, str]]:
    """``{(kind, key): (line, marker)}``; marker is the ``# raise-ok:`` line directly
    above the entry (stripped), or ``""``."""
    out: dict[tuple[str, str], tuple[str, str]] = {}
    prev = ""
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            parts = [p.strip() for p in s.split("|")]
            if len(parts) >= 2:
                out[(parts[0], parts[1])] = (
                    s,
                    prev if prev.startswith("# raise-ok:") else "",
                )
        prev = s
    return out


def _git(root: Path, *args: str) -> tuple[int, str]:
    try:
        r = subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
        )
    except OSError:
        return -1, ""
    return r.returncode, r.stdout


def base_baseline(root: Path) -> tuple[str | None, list[str]]:
    """The baseline at the merge base, or why it cannot be read.

    Fails CLOSED (same contract as ``check-app-layering.py``): when
    ``CI_MERGE_REQUEST_DIFF_BASE_SHA`` (or ``TRUEPPM_SETTINGS_CONTRACT_BASE_REF``) names a
    base that cannot be read, that is an error, not a skip. Skipped with a note only
    when no variable is set and there is no ``origin/main`` merge base (a local clone
    with no remote, or a pipeline on ``main``). A baseline file absent at the base is
    being introduced by this change, so there is nothing to compare: ``(None, [])``.
    """
    ref = os.environ.get("TRUEPPM_SETTINGS_CONTRACT_BASE_REF") or os.environ.get(
        "CI_MERGE_REQUEST_DIFF_BASE_SHA"
    )
    if ref:
        if _git(root, "cat-file", "-e", f"{ref}^{{commit}}")[0] != 0:
            return None, [
                f"base ref {ref!r} is not reachable, so the baseline cannot be compared "
                "against it (shallow clone? the job needs GIT_DEPTH: 0)"
            ]
    else:
        rc, mb = _git(root, "merge-base", "HEAD", "origin/main")
        _, head = _git(root, "rev-parse", "HEAD")
        if rc != 0 or not mb.strip() or mb == head:
            print(
                "  note: no merge base available (no origin/main, or on main) -- "
                "baseline-raise check skipped"
            )
            return None, []
        ref = mb.strip()
    rc, listing = _git(root, "ls-tree", ref, "--", BASELINE)
    if rc != 0:
        return None, [
            f"git ls-tree {ref} -- {BASELINE} failed; cannot read the base baseline"
        ]
    if not listing.strip():
        return None, []  # genuinely absent at the base: this change introduces it
    rc, text = _git(root, "show", f"{ref}:{BASELINE}")
    if rc != 0:
        return None, [
            f"git show {ref}:{BASELINE} failed; cannot read the base baseline"
        ]
    return text, []


def raised_errors(current: str, old: str) -> list[str]:
    """Entries new against the base copy that lack a NEW ``# raise-ok:`` marker.

    A marker already present in the base text was spent by the change that added it;
    re-pointing it at a different entry grants nothing.
    """
    before = load_baseline(old)
    spent = {
        ln.strip() for ln in old.splitlines() if ln.strip().startswith("# raise-ok:")
    }
    errors: list[str] = []
    for key, (line, marker) in sorted(load_baseline(current).items()):
        if key in before:
            continue
        if marker and marker not in spent:
            continue
        why = (
            " (its `# raise-ok:` marker is already in the base copy)" if marker else ""
        )
        errors.append(
            f"RAISED  {line!r} is new against the merge base{why}; a baseline can only "
            "shrink. A deliberate addition needs a new `# raise-ok: <reason>` on the line above."
        )
    return errors


def run_check(root: Path, *, compare_base: bool = True) -> list[str]:
    findings = {**env_findings(root), **reader_findings(root)}
    path = root / BASELINE
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    base = load_baseline(text)
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
        old, base_errors = base_baseline(root)
        errors.extend(base_errors)
        if old is not None:
            errors.extend(raised_errors(text, old))
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
            "C = env_with_legacy(env, 'TRUEPPM_PLANT_B', 'PLANT_B', 5, int)\n"
            "D = os.environ['TRUEPPM_PLANT_E']\n"
            "E = env_with_legacy(env, 'TRUEPPM_LEG_DRIFT', 'LEG_DRIFT', 5, int)\n"
        )
        (docs / "cfg.md").write_text(
            "| Variable | Default | Effect |\n|---|---|---|\n"
            "| `TRUEPPM_DOCUMENTED` | `5` | ok |\n"
            "| `TRUEPPM_DRIFTED` | `true` | wrong |\n"
            "| `TRUEPPM_LEG_DRIFT` | `7` | wrong; legacy `LEG_DRIFT` |\n"
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
        (app / "serializers.py").write_text(
            (app / "serializers.py").read_text()
            + "\nclass ThingRoSerializer(serializers.ModelSerializer):\n"
            "    class Meta:\n"
            "        model = Thing\n"
            "        fields = ('ro_only',)\n"
            "        read_only_fields = fields\n"
        )
        (app / "models.py").write_text(
            (app / "models.py").read_text()
            + "    ro_only = models.CharField(max_length=5)\n"
            "    stamped = models.DateTimeField(auto_now_add=True)\n"
        )
        (app / "models.py").write_text(
            (app / "models.py").read_text()
            + "    written_only = models.IntegerField()\n"
            "    web_written = models.IntegerField()\n"
            "    filtered = models.IntegerField()\n"
            "    validated_only = models.IntegerField()\n"
            "    computed_from = models.IntegerField()\n"
            "    update_only = models.IntegerField()\n"
        )
        (app / "serializers.py").write_text(
            (app / "serializers.py").read_text()
            + "\nclass WSerializer(serializers.ModelSerializer):\n"
            "    def validate(self, attrs):\n"
            "        return self.instance.validated_only\n"
            "    def get_x(self, obj):\n"
            "        return obj.computed_from\n"
            "    def update(self, instance, validated_data):\n"
            "        instance.update_only = validated_data.get("
            "'update_only', instance.update_only)\n"
            "        return instance\n"
            "    class Meta:\n"
            "        model = Thing\n"
            "        fields = ['written_only', 'web_written', 'filtered',"
            " 'validated_only', 'computed_from', 'update_only']\n"
        )
        (app / "services.py").write_text(
            "def use(t):\n    return t.read_me\n"
            "def write(t):\n"
            "    t.written_only = 1\n"
            "    t.save(update_fields=['written_only'])\n"
            "    Thing.objects.create(written_only=2, web_written=2)\n"
            "    Thing.objects.filter(pk=1).update(written_only=3)\n"
            "    Thing.objects.update_or_create(pk=1, defaults={'written_only': 4})\n"
            "    setattr(t, 'written_only', 5)\n"
            "    Thing(written_only=6)\n"
            "    return Thing.objects.filter(filtered=1)\n"
        )
        (root / "packages/web/src/form.tsx").write_text(
            "mutate({ web_written: v });\nbody.web_written = v;\n"
            "const el = <Field web_written={v} />;\n"
        )
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
        check(
            ("env-undocumented", "TRUEPPM_PLANT_B") in env
            and ("env-undocumented", "PLANT_B") in env,
            "env_with_legacy name / legacy alias not scanned",
        )
        check(
            ("env-undocumented", "TRUEPPM_PLANT_E") in env,
            "os.environ[...] subscript not scanned",
        )
        check(
            ("default-drift", "TRUEPPM_LEG_DRIFT") in env
            and ("env-undocumented", "LEG_DRIFT") not in env,
            "env_with_legacy default (args[3]) not compared",
        )
        rd = reader_findings(root)
        check(
            ("unread-writable", "Thing.ghost") in rd,
            "writable field with no reader not flagged",
        )
        check(("unread-writable", "Thing.read_me") not in rd, "read field flagged")
        check(("unread-writable", "Thing.derived") not in rd, "read-only field flagged")
        check(
            ("unread-writable", "Thing.ro_only") not in rd,
            "read_only_fields = fields idiom flagged",
        )
        check(
            ("unread-writable", "Thing.stamped") not in rd,
            "auto_now_add field flagged",
        )
        check(
            ("unread-writable", "Thing.written_only") in rd,
            "a field only ASSIGNED / passed to a write call counts as read",
        )
        check(
            ("unread-writable", "Thing.web_written") in rd,
            "a web object-literal key / assignment / JSX prop counts as read",
        )
        check(
            ("unread-writable", "Thing.filtered") not in rd,
            "filter() lookup not a read",
        )
        check(
            ("unread-writable", "Thing.validated_only") in rd,
            "a serializer validate*() read counts as a consumer",
        )
        check(
            ("unread-writable", "Thing.update_only") in rd,
            "a serializer update() read-back-and-assign counts as a consumer",
        )
        check(
            ("unread-writable", "Thing.computed_from") not in rd,
            "a serializer get_*() read is not counted",
        )
        (root / "packages/web/src/form.tsx").unlink()
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
            all(e.startswith("NEW") for e in errs)
            and len(errs) == len({**env_findings(root), **reader_findings(root)}) >= 9,
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
            bool(bl[("env-undocumented", "X")][1])
            and not bl[("env-undocumented", "Y")][1],
            "raise-ok parse",
        )
        # Ratchet: an unmarked addition is RAISED; a new marker grants it; a marker
        # already in the base copy (re-pointed at a different entry) does not.
        old_bl = "# raise-ok: spent\nenv-undocumented | A | #1 | r\n"
        check(
            any(
                "RAISED" in e
                for e in raised_errors(
                    old_bl + "env-undocumented | B | #1 | r\n", old_bl
                )
            ),
            "unmarked addition not RAISED",
        )
        check(
            raised_errors(
                old_bl + "# raise-ok: fresh\nenv-undocumented | B | #1 | r\n", old_bl
            )
            == [],
            "new raise-ok marker not honored",
        )
        check(
            any(
                "already in the base" in e
                for e in raised_errors(
                    "# raise-ok: spent\nenv-undocumented | B | #1 | r\n", old_bl
                )
            ),
            "a raise-ok marker present in the base copy was honored",
        )
        # Fail closed: a named base ref that is unreachable is an error, not a skip.
        saved = os.environ.get("TRUEPPM_SETTINGS_CONTRACT_BASE_REF")
        os.environ["TRUEPPM_SETTINGS_CONTRACT_BASE_REF"] = "0" * 40
        try:
            text_b, errs_b = base_baseline(root)  # root is not even a git repo
            check(
                text_b is None and any("not reachable" in e for e in errs_b),
                f"unreachable base failed open: {errs_b}",
            )
            check(
                any("not reachable" in e for e in run_check(root)),
                "run_check skipped an unreachable base",
            )
        finally:
            if saved is None:
                os.environ.pop("TRUEPPM_SETTINGS_CONTRACT_BASE_REF", None)
            else:
                os.environ["TRUEPPM_SETTINGS_CONTRACT_BASE_REF"] = saved
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
    print(
        f"settings-contract: OK (no finding beyond the ratcheted baseline; "
        f"{len(COMPARED)} documented defaults compared)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
