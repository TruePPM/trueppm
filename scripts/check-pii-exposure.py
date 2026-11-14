#!/usr/bin/env python3
"""Fail when a NEW account-PII exposure of either known class enters the API (#3640).

Two defect classes, ten hand-closures between them, no gate anywhere:

Class A -- a hand-rolled response dict emits an ``email``.
    ``ResourceSerializer.to_representation`` is where the #891 address-harvest control
    lives; a view that builds its rows by hand never sees it. Point-fixed seven times
    (#891 #892 #3569 #3599 #3625 #3627 #3639). RULE: a dict literal with an ``"email"``
    key under ``apps/**/views.py`` / ``program_views.py`` fails unless the line (or the
    line above) carries ``# pii-ok: <reason naming the gate that authorizes it>``.

Class B -- a write serializer exposes an unnarrowed ``User`` FK (an account oracle).
    A ``ModelSerializer`` over a model with an FK to ``AUTH_USER_MODEL`` auto-generates a
    ``PrimaryKeyRelatedField`` over ``User._default_manager`` -- every account, inactive
    ones included. Closed three times (#815 #3599 #3641). RULE: such a field, when it is
    exposed by ``Meta.fields`` and is neither ``read_only`` (``Meta.read_only_fields`` or
    ``extra_kwargs``), nor declared explicitly on the serializer class, nor given a
    ``queryset`` through ``extra_kwargs``, must appear in the baseline file.

What this cannot do (be honest, like the other gates in this family)
  * An opt-out / baseline entry is a rubber stamp; it removes the SILENCE, not the
    possibility of a wrong answer. The baseline is a grandfathered snapshot, not a review.
  * Class B is a syntactic heuristic. It reads model FKs by name across ``models.py``
    (class-name collisions union), looks only at directly declared FKs (not inherited
    from an abstract base in another file), and treats a ``Meta.fields`` it cannot
    evaluate as "every field". It cannot see a ``__init__`` / ``get_fields`` override
    that narrows the queryset at runtime -- those serializers are baselined with a reason.
  * It does not know whether a serializer is used on a write path; read-only serializers
    over a User FK are baselined or declared ``read_only`` rather than excluded.
  * Class A sees dict literals with a string-constant ``"email"`` key only, not
    ``dict(email=...)`` or a key built at runtime.

Baseline: scripts/pii-exposure-baseline.txt, lines ``<path>::<Class>.<field>  # reason``.
Stale entries (no longer a hit) fail, so the baseline only shrinks.

Usage:
  check-pii-exposure.py [ROOT]            # ROOT defaults to packages/api/src
  check-pii-exposure.py --files A B ...   # scan exactly these (Class A + B), no baseline
  check-pii-exposure.py --self-test
Exit: 0 clean · 1 violation or stale baseline entry · 2 invocation error
"""

from __future__ import annotations

import ast
import re
import subprocess
import sys
import tempfile
from pathlib import Path

DEFAULT_ROOT = "packages/api/src"
BASELINE = Path("scripts/pii-exposure-baseline.txt")
OPT_OUT = re.compile(r"#\s*pii-ok:\s*\S")
CLASS_A_FILES = ("views.py", "program_views.py")


def _is_user_fk(call: ast.Call) -> bool:
    """True for ForeignKey/OneToOneField(settings.AUTH_USER_MODEL | 'auth.User' | User)."""
    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
    if name not in ("ForeignKey", "OneToOneField") or not call.args:
        return False
    a = call.args[0]
    if isinstance(a, ast.Attribute) and a.attr == "AUTH_USER_MODEL":
        return True
    if isinstance(a, ast.Name) and a.id in ("User", "AUTH_USER_MODEL"):
        return True
    return isinstance(a, ast.Constant) and a.value in ("auth.User", "auth.user")


def collect_user_fks(trees: list[ast.Module]) -> dict[str, set[str]]:
    """model class name -> names of its direct FK/O2O fields to the User model."""
    out: dict[str, set[str]] = {}
    for tree in trees:
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            for st in cls.body:
                if (
                    isinstance(st, ast.Assign)
                    and isinstance(st.value, ast.Call)
                    and _is_user_fk(st.value)
                ):
                    for t in st.targets:
                        if isinstance(t, ast.Name):
                            out.setdefault(cls.name, set()).add(t.id)
    return out


def _str_seq(node: ast.AST | None) -> list[str] | None:
    """Literal list/tuple of strings -> list; anything unevaluable -> None."""
    if isinstance(node, (ast.List, ast.Tuple)) and all(
        isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts
    ):
        return [e.value for e in node.elts]  # type: ignore[attr-defined]
    return None


def _meta(cls: ast.ClassDef) -> ast.ClassDef | None:
    for st in cls.body:
        if isinstance(st, ast.ClassDef) and st.name == "Meta":
            return st
    return None


def _meta_assign(meta: ast.ClassDef, key: str) -> ast.AST | None:
    for st in meta.body:
        if isinstance(st, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == key for t in st.targets
        ):
            return st.value
    return None


def class_b_hits(
    tree: ast.Module, fks: dict[str, set[str]]
) -> list[tuple[int, str, str]]:
    """[(lineno, serializer class, field)] for unnarrowed, exposed, writable User FKs."""
    hits: list[tuple[int, str, str]] = []
    for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
        meta = _meta(cls)
        if meta is None:
            continue
        model = _meta_assign(meta, "model")
        mname = (
            model.id if isinstance(model, ast.Name) else getattr(model, "attr", None)
        )
        if mname not in fks:
            continue
        declared = {
            t.id
            for st in cls.body
            if isinstance(st, (ast.Assign, ast.AnnAssign))
            for t in (st.targets if isinstance(st, ast.Assign) else [st.target])
            if isinstance(t, ast.Name)
        }
        fields_node = _meta_assign(meta, "fields")
        fields = _str_seq(fields_node)  # None => "__all__" or unevaluable => all
        exclude = _str_seq(_meta_assign(meta, "exclude")) or []
        ro = set(_str_seq(_meta_assign(meta, "read_only_fields")) or [])
        extra = _meta_assign(meta, "extra_kwargs")
        if isinstance(extra, ast.Dict):
            for k, v in zip(extra.keys, extra.values, strict=False):
                if (
                    isinstance(k, ast.Constant)
                    and isinstance(v, ast.Dict)
                    and any(
                        isinstance(kk, ast.Constant)
                        and kk.value in ("read_only", "queryset")
                        for kk in v.keys
                    )
                ):
                    ro.add(str(k.value))
        for f in sorted(fks[mname]):
            if f in declared or f in ro or f in exclude:
                continue
            if fields is not None and f not in fields:
                continue
            hits.append((cls.lineno, cls.name, f))
    return hits


def class_a_hits(path: Path, source: str, tree: ast.Module) -> list[tuple[int, str]]:
    lines = source.splitlines()
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        for k, v in zip(node.keys, node.values, strict=False):
            if isinstance(k, ast.Constant) and k.value == "email":
                if isinstance(v, ast.Constant):
                    continue  # {"email": "<error message>"} -- a validation error, not a value
                ln = k.lineno
                near = lines[ln - 1] + "\n" + (lines[ln - 2] if ln >= 2 else "")
                if not OPT_OUT.search(near):
                    hits.append((ln, lines[ln - 1].strip()))
    return hits


def discover(root: Path) -> list[Path]:
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z", "--", str(root)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    return [
        Path(e)
        for e in out.split("\0")
        if e.endswith(".py") and "/migrations/" not in e and Path(e).is_file()
    ]


def parse(paths: list[Path]) -> dict[Path, tuple[str, ast.Module]]:
    parsed = {}
    for p in paths:
        try:
            src = p.read_text(encoding="utf-8")
            parsed[p] = (src, ast.parse(src))
        except (SyntaxError, UnicodeDecodeError):
            continue
    return parsed


def key_of(path: Path) -> str:
    parts = path.as_posix().split("/")
    return (
        "/".join(parts[parts.index("trueppm_api") :])
        if "trueppm_api" in parts
        else path.as_posix()
    )


def scan(paths: list[Path]) -> tuple[list[str], list[str]]:
    """Return (class A findings, class B keys with `file:line` display)."""
    parsed = parse(paths)
    fks = collect_user_fks(
        [
            t
            for p, (_, t) in parsed.items()
            if p.name == "models.py" or "models" in p.parts
        ]
    )
    a: list[str] = []
    b: list[str] = []
    for p, (src, tree) in sorted(parsed.items()):
        if p.name in CLASS_A_FILES:
            for ln, text in class_a_hits(p, src, tree):
                a.append(f"{p}:{ln}  {text}")
        if p.name.startswith("serializers") or "serializers" in p.parts:
            for ln, cname, f in class_b_hits(tree, fks):
                b.append(f"{key_of(p)}::{cname}.{f}\t{p}:{ln}")
    return a, b


def load_baseline() -> set[str]:
    if not BASELINE.is_file():
        return set()
    out = set()
    for line in BASELINE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            out.add(line)
    return out


def run(paths: list[Path], baseline: set[str]) -> int:
    a, b = scan(paths)
    bad = [x for x in b if x.split("\t")[0] not in baseline]
    stale = sorted(baseline - {x.split("\t")[0] for x in b})
    for x in a:
        print(f"check-pii-exposure: FAIL (class A, email in hand-rolled dict)  {x}")
    for x in bad:
        k, loc = x.split("\t")
        print(f"check-pii-exposure: FAIL (class B, unnarrowed User FK)  {k}  [{loc}]")
    for k in stale:
        print(f"check-pii-exposure: FAIL (stale baseline entry, remove it)  {k}")
    print(
        f"check-pii-exposure: {len(paths)} files, {len(a)} class A, {len(b) - len(bad)} "
        f"baselined class B, {len(bad)} new class B, {len(stale)} stale."
    )
    if a or bad or stale:
        print(
            "\nClass A: route the row through the serializer that owns the address policy, or\n"
            "  add `# pii-ok: <the gate that authorizes it>` on the line (or the line above).\n"
            "Class B: declare the field with an explicit narrowed `queryset=`, make it\n"
            "  read_only, or add `<key>  # reason` to scripts/pii-exposure-baseline.txt.\n"
            "Both are rubber stamps that remove the silence (#3640)."
        )
        return 1
    return 0


def self_test() -> int:
    models = (
        "from django.conf import settings\nfrom django.db import models\n"
        "class Note(models.Model):\n"
        "    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)\n"
    )
    ser = {
        "bare": "class S(ModelSerializer):\n    class Meta:\n        model = Note\n        fields = ['author', 'x']\n",
        "all": "class S(ModelSerializer):\n    class Meta:\n        model = Note\n        fields = '__all__'\n",
        "declared": "class S(ModelSerializer):\n    author = PrimaryKeyRelatedField(queryset=Q)\n    class Meta:\n        model = Note\n        fields = ['author']\n",
        "ro": "class S(ModelSerializer):\n    class Meta:\n        model = Note\n        fields = ['author']\n        read_only_fields = ['author']\n",
        "unexposed": "class S(ModelSerializer):\n    class Meta:\n        model = Note\n        fields = ['x']\n",
    }
    views = {
        "dict": "def f(u):\n    return {'email': u.email}\n",
        "okline": "def f(u):\n    return {'email': u.email}  # pii-ok: IsWorkspaceAdmin\n",
        "okabove": "def f(u):\n    return {\n        # pii-ok: IsWorkspaceAdmin\n        'email': u.email,\n    }\n",
        "err": "def f():\n    raise ValidationError({'email': 'x'})\n",
    }
    cases = [
        ("B bare FK in fields", ser["bare"], "B", 1),
        ("B __all__", ser["all"], "B", 1),
        ("B explicitly declared", ser["declared"], "B", 0),
        ("B read_only_fields", ser["ro"], "B", 0),
        ("B field not exposed", ser["unexposed"], "B", 0),
        ("A email dict", views["dict"], "A", 1),
        ("A same-line opt-out", views["okline"], "A", 0),
        ("A line-above opt-out", views["okabove"], "A", 0),
        ("A literal error-message value is not an address", views["err"], "A", 0),
    ]
    rc = 0
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d) / "trueppm_api" / "apps" / "x"
        dp.mkdir(parents=True)
        (dp / "models.py").write_text(models)
        for name, src, cls, want in cases:
            target = dp / ("serializers.py" if cls == "B" else "views.py")
            target.write_text(src)
            a, b = scan([dp / "models.py", target])
            got = len(b if cls == "B" else a)
            ok = got == want
            print(f"  [{'ok' if ok else 'FAIL'}] {name}: expected {want}, got {got}")
            rc |= 0 if ok else 1
        # baseline mechanics: a stale entry must fail, a matching one must pass
        (dp / "serializers.py").write_text(ser["bare"])
        paths = [dp / "models.py", dp / "serializers.py"]
        k = scan(paths)[1][0].split("\t")[0]
        for label, bl, want in (
            ("baselined hit passes", {k}, 0),
            ("stale entry fails", {k, "gone::S.f"}, 1),
            ("unbaselined hit fails", set(), 1),
        ):
            got = run(paths, bl)
            ok = got == want
            print(f"  [{'ok' if ok else 'FAIL'}] {label}")
            rc |= 0 if ok else 1
    print("check-pii-exposure --self-test:", "PASS" if rc == 0 else "FAIL")
    return rc


def main(argv: list[str]) -> int:
    if argv[:1] == ["--self-test"]:
        return self_test()
    if argv[:1] == ["--files"]:
        return run([Path(a) for a in argv[1:]], set())
    root = Path(argv[0] if argv else DEFAULT_ROOT)
    paths = discover(root)
    if not paths:
        print(f"check-pii-exposure: no files discovered under {root}", file=sys.stderr)
        return 2
    return run(paths, load_baseline())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
