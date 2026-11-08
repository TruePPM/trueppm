#!/usr/bin/env python3
"""Gate imports between the Django domain apps against a declared layering.

Why this exists
---------------
The OSS-to-Enterprise edge is gated (``scripts/check-enterprise-imports.sh``), but
nothing gated the edges *between* the ~22 domain apps under
``packages/api/src/trueppm_api/apps/``. Cross-domain coupling therefore accumulated
unnoticed: at the time this gate was written the apps shared 162 distinct directed
edges (app to app, app to platform, platform to app) across several hundred import
sites. This gate declares the intended layering in one
file, records today's violations in a baseline that can only shrink, and fails any
import that is not in the baseline.

The rule
--------
``packages/api/app-layering.toml`` assigns every app to a numbered layer. An import
from app ``A`` to app ``B`` is allowed when ``B`` is in a lower layer than ``A``, or
in the same layer if that layer sets ``lateral = true``. Anything else (an *upward*
import, or a lateral one in a non-lateral layer) is a violation. Apps may always
import the ``platform`` modules (``core``, ``fields``, ``permissions``, ...); a
platform module importing an app is itself a violation. Composition roots
(``settings``, ``urls``, ``asgi``, ``routing``, ``celery``) wire everything together
by design and are not scanned.

Every app directory must be assigned a layer, so adding an app fails the gate until
its place in the layering is declared.

What counts as an import
------------------------
Any ``import`` / ``from ... import`` anywhere in a file (including function-local
and ``TYPE_CHECKING`` imports -- a lazy import is still coupling), plus a string
constant that is wholly a dotted ``trueppm_api.*`` path (``include("...urls")``,
``import_module("...")``, Celery task names). Migrations are skipped: a migration's
cross-app ``dependencies`` are how Django orders the schema, not runtime coupling.

The ratchet
-----------
``packages/api/app-layering-baseline.txt`` holds one ``<src> -> <dst> <count>`` line
per violating edge. A violating edge fails when it is absent from the baseline or its
site count exceeds the baseline. Counts below the baseline are reported as slack
(``--update-baseline`` locks them in) and never fail, so two MRs that each fix a
violation do not conflict. ``--update-baseline`` only ever lowers or removes entries;
it refuses to add or raise one (once the file exists), so the baseline cannot be used to launder a new
violation. The baseline total is printed on every run so shrinkage is visible.

Nothing in the file format stops a person editing a count *up* by hand, so the gate
also compares the committed baseline with the copy at the merge base (the MR diff base
in CI, ``git merge-base HEAD origin/main`` locally) and fails if an edge was added or a
count rose. Override with ``TRUEPPM_ALLOW_LAYERING_RAISE=1`` for a deliberate
re-layering (say so in the MR). When no base ref is reachable -- a shallow clone, a
pipeline on ``main`` itself -- the check prints a note and is skipped; when the base
has no baseline file (the MR that introduced it) it passes.

Opting out
----------
A deliberate exception carries ``# layering-ok: <reason>`` inside the import or in the
comment block directly above it (a blank line ends the block). The reason is required,
and a bare ``# layering-ok:`` fails the gate wherever it appears, even on a legal
import. The number of opted-out sites is printed on every run. Like ``# safe-bulk-create:``
this is a rubber stamp: it removes the silence, not the possibility of a wrong answer.

What this gate cannot see
-------------------------
* ``apps.get_model("projects.Task")`` and ``ForeignKey("projects.Task")`` string
  references -- model coupling by label, not by module path.
* Module paths built at runtime: f-strings, concatenation, and
  ``importlib.import_module(variable)``. Only a string constant that is *wholly* a dotted
  ``trueppm_api.*`` path is counted; a path embedded in a longer string is not.
* ``from trueppm_api import apps`` followed by ``apps.projects.models`` attribute access:
  the import names ``apps``, not the app, so the edge is invisible.
* Imports through a re-export (``from trueppm_api.core import something_that_is_an_app_thing``).
* Which names are imported: importing a constant counts the same as a model.
* Test code (``packages/api/tests``) -- tests legitimately cross domains.

Why a custom script rather than ``import-linter``
-------------------------------------------------
It adds no dependency (so the ``dependency`` gate does not apply and the CI job needs
nothing beyond ``python3``), it keeps per-edge *site counts*, which the ratchet needs
(import-linter's ignore list is per import chain, not a ceiling that tolerates a count
shrinking), and it ships a ``--self-test`` and a shell test like its sibling gates
(``check-bulk-create-server-version.py``), so the gate proves it can still fail.

Usage:
    python3 scripts/check-app-layering.py [--root DIR] [--config FILE] [--baseline FILE]
    python3 scripts/check-app-layering.py --graph          # print the measured graph
    python3 scripts/check-app-layering.py --update-baseline
    python3 scripts/check-app-layering.py --self-test
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from collections import Counter
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PKG_REL = "packages/api/src/trueppm_api"
_CONFIG_REL = "packages/api/app-layering.toml"
_BASELINE_REL = "packages/api/app-layering-baseline.txt"
_MARKER = "# layering-ok:"
_PLATFORM = "platform"
_DOTTED = re.compile(r"trueppm_api(\.\w+)+")
_BASELINE_LINE = re.compile(r"^(\S+) -> (\S+) (\d+)$")

Edge = tuple[str, str]


class Config:
    """The parsed layering declaration."""

    def __init__(self, data: dict) -> None:
        self.layers: list[dict] = data.get("layer", [])
        self.platform: set[str] = set(data.get("platform", {}).get("modules", []))
        self.roots: set[str] = set(data.get("composition_roots", {}).get("modules", []))
        self.app_layer: dict[str, int] = {}
        self.lateral: dict[int, bool] = {}
        for idx, layer in enumerate(self.layers):
            self.lateral[idx] = bool(layer.get("lateral", False))
            for app in layer.get("apps", []):
                if app in self.app_layer:
                    raise SystemExit(f"config error: app {app!r} is in two layers")
                self.app_layer[app] = idx

    def violates(self, src: str, dst: str) -> bool:
        """Is an import from unit ``src`` to unit ``dst`` outside the layering?"""
        if dst == _PLATFORM:
            return False
        if src == _PLATFORM:
            return True
        s, d = self.app_layer[src], self.app_layer[dst]
        if d < s:
            return False
        return not (d == s and self.lateral[s])


def _unit_of_module(parts: list[str], cfg: Config) -> str | None:
    """Map a dotted ``trueppm_api.*`` module (split) to a unit; ``None`` = ignore."""
    if len(parts) < 2 or parts[0] != "trueppm_api":
        return None
    if parts[1] == "apps":
        return parts[2] if len(parts) > 2 else None
    if parts[1] in cfg.platform:
        return _PLATFORM
    return None


def _file_unit(rel: tuple[str, ...], cfg: Config) -> str | None:
    """Unit a source file belongs to, or ``None`` if it is not scanned."""
    if rel[0] == "apps":
        return rel[1] if len(rel) > 2 else None
    top = rel[0].removesuffix(".py")
    if top in cfg.platform:
        return _PLATFORM
    return None


def _has_marker(lines: list[str], first: int, last: int) -> bool | str:
    """Return True if a ``# layering-ok: <reason>`` covers the import, 'empty' if no reason.

    The comment block directly above the import counts; a blank line ends it, so a
    stale marker separated from its import by white space cannot silently apply.
    """
    candidates = list(lines[first - 1 : last])
    i = first - 2
    while i >= 0:
        stripped = lines[i].strip()
        if not stripped.startswith("#"):
            break
        candidates.append(stripped)
        i -= 1
    for line in candidates:
        if _MARKER in line:
            reason = line.split(_MARKER, 1)[1].strip()
            return True if reason else "empty"
    return False


def _imports(tree: ast.Module, pkg: list[str]):
    """Yield ``(lineno, end_lineno, [dotted module parts])`` for every cross-reference."""
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom):
            if n.level:
                base = pkg[: len(pkg) - (n.level - 1)] if n.level > 1 else list(pkg)
                mod = base + (n.module.split(".") if n.module else [])
            else:
                mod = n.module.split(".") if n.module else []
            targets = [mod]
            # `from trueppm_api.apps import projects` imports a submodule, not a name.
            if mod in (["trueppm_api", "apps"], ["trueppm_api"]):
                targets = [mod + [a.name] for a in n.names]
            for t in targets:
                yield n.lineno, n.end_lineno or n.lineno, t
        elif isinstance(n, ast.Import):
            for a in n.names:
                yield n.lineno, n.end_lineno or n.lineno, a.name.split(".")
        elif (
            isinstance(n, ast.Constant)
            and isinstance(n.value, str)
            and _DOTTED.fullmatch(n.value)
        ):
            yield n.lineno, n.end_lineno or n.lineno, n.value.split(".")


def scan(
    root: Path, cfg: Config
) -> tuple[Counter[Edge], dict[Edge, list[str]], list[str], int, list[str]]:
    """Return (violation counts, sites per edge, config/marker errors, total edges seen)."""
    pkg_dir = root / _PKG_REL
    errors: list[str] = []
    if not pkg_dir.is_dir():
        raise SystemExit(f"ERROR: {pkg_dir} is not a directory")

    apps_dir = pkg_dir / "apps"
    on_disk = {
        p.name for p in apps_dir.iterdir() if p.is_dir() and not p.name.startswith("_")
    }
    for app in sorted(on_disk - set(cfg.app_layer)):
        errors.append(
            f"app {app!r} exists but is not assigned a layer in {_CONFIG_REL}"
        )
    for app in sorted(set(cfg.app_layer) - on_disk):
        errors.append(
            f"{_CONFIG_REL} assigns a layer to {app!r}, which is not an app directory"
        )
    for top in sorted(
        p for p in pkg_dir.iterdir() if p.name not in {"apps", "__pycache__"}
    ):
        name = top.name.removesuffix(".py")
        if top.suffix not in ("", ".py") or name in {"__init__", "py"}:
            continue
        if name not in cfg.platform and name not in cfg.roots:
            errors.append(
                f"top-level module {name!r} is neither platform nor a composition root"
            )

    counts: Counter[Edge] = Counter()
    sites: dict[Edge, list[str]] = {}
    seen: set[Edge] = set()
    opted: list[str] = []
    for path in sorted(pkg_dir.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        rel = path.relative_to(pkg_dir).parts
        src = _file_unit(rel, cfg)
        if src is None or (src != _PLATFORM and src not in cfg.app_layer):
            continue
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        pkg = ["trueppm_api", *rel[:-1]]
        for lineno, end, parts in _imports(ast.parse(text), pkg):
            dst = _unit_of_module(parts, cfg)
            if (
                dst is None
                or dst == src
                or (dst != _PLATFORM and dst not in cfg.app_layer)
            ):
                continue
            seen.add((src, dst))
            where = f"{'/'.join((_PKG_REL, *rel))}:{lineno}"
            marker = _has_marker(lines, lineno, end)
            if marker == "empty":
                errors.append(f"{where}: {_MARKER} needs a reason")
                continue
            if not cfg.violates(src, dst):
                continue
            if marker:
                opted.append(where)
                continue
            counts[(src, dst)] += 1
            sites.setdefault((src, dst), []).append(where)
    return counts, sites, errors, len(seen), opted


def read_baseline(path: Path) -> Counter[Edge]:
    base: Counter[Edge] = Counter()
    if not path.exists():
        return base
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _BASELINE_LINE.match(line)
        if not m:
            raise SystemExit(f"ERROR: malformed baseline line: {raw!r}")
        base[(m[1], m[2])] = int(m[3])
    return base


_BASELINE_HEADER = """\
# Recorded layering violations -- a ceiling that can only shrink (scripts/check-app-layering.py).
# One `<src> -> <dst> <import-site count>` line per violating edge. Fix a violation, then
# lock it in with `python3 scripts/check-app-layering.py --update-baseline`; that command
# refuses to add or raise an entry. `platform` is core/fields/permissions/workflows.
"""


def write_baseline(path: Path, counts: Counter[Edge]) -> None:
    body = "".join(f"{s} -> {d} {n}\n" for (s, d), n in sorted(counts.items()))
    path.write_text(_BASELINE_HEADER + body, encoding="utf-8")


def _git(root: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout


def _baseline_raised(root: Path, baseline: Path) -> list[str]:
    """Edges whose count rose (or that appeared) versus the merge-base baseline."""
    if os.environ.get("TRUEPPM_ALLOW_LAYERING_RAISE") == "1":
        print("  note: TRUEPPM_ALLOW_LAYERING_RAISE=1 -- baseline-raise check skipped")
        return []
    ref = os.environ.get("TRUEPPM_LAYERING_BASE_REF") or os.environ.get(
        "CI_MERGE_REQUEST_DIFF_BASE_SHA"
    )
    if not ref:
        mb = _git(root, "merge-base", "HEAD", "origin/main")
        head = _git(root, "rev-parse", "HEAD")
        ref = mb.strip() if mb and mb != head else None
    if not ref or _git(root, "cat-file", "-e", f"{ref}^{{commit}}") is None:
        print(
            "  note: no merge-base ref available (shallow clone or main) -- baseline-raise check skipped"
        )
        return []
    try:
        rel = baseline.resolve().relative_to(root.resolve())
    except ValueError:
        return []
    old_text = _git(root, "show", f"{ref}:{rel.as_posix()}")
    if old_text is None:
        return []  # base has no baseline: this change introduces it
    old: Counter[Edge] = Counter()
    for line in old_text.splitlines():
        m = _BASELINE_LINE.match(line.strip())
        if m:
            old[(m[1], m[2])] = int(m[3])
    now = read_baseline(baseline)
    return [
        f"{s} -> {d}: {old.get((s, d), 0)} -> {n}"
        for (s, d), n in sorted(now.items())
        if n > old.get((s, d), 0)
    ]


def run(
    root: Path,
    config: Path,
    baseline: Path,
    *,
    update: bool = False,
    graph: bool = False,
    check_base: bool = False,
) -> int:
    cfg = Config(tomllib.loads(config.read_text(encoding="utf-8")))
    counts, sites, errors, seen, opted = scan(root, cfg)
    base = read_baseline(baseline)

    if graph:
        for (s, d), n in sorted(counts.items()):
            print(f"{s} -> {d} {n}")
        print(
            f"{len(counts)} violating edges, {sum(counts.values())} sites ({seen} edges total)"
        )
        return 0

    if errors:
        print("\nLAYERING CONFIG/MARKER ERRORS:\n", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1

    new = {e: n for e, n in counts.items() if n > base.get(e, 0)}
    slack = {e: base[e] - counts.get(e, 0) for e in base if counts.get(e, 0) < base[e]}

    if update:
        # A missing baseline is the one-time bootstrap; after that it only shrinks.
        if new and baseline.exists():
            print(
                "refusing to --update-baseline: it would add or raise entries:",
                file=sys.stderr,
            )
            for (s, d), n in sorted(new.items()):
                print(f"  {s} -> {d}: {base.get((s, d), 0)} -> {n}", file=sys.stderr)
            return 1
        write_baseline(baseline, counts)
        print(f"baseline updated: {sum(counts.values())} sites on {len(counts)} edges")
        return 0

    cur_total, base_total = sum(counts.values()), sum(base.values())
    print(
        f"app layering: {cur_total} violating import sites on {len(counts)} edges "
        f"(baseline {base_total} on {len(base)} edges); {len(opted)} opted out via {_MARKER}"
    )
    raised = _baseline_raised(root, baseline) if check_base else []
    if raised:
        print("\nLAYERING BASELINE RAISED against the merge base:\n")
        for line in raised:
            print(f"  {line}")
        print(
            "\nThe baseline is a ceiling that only shrinks. Fix the violation instead, or, for a "
            "deliberate re-layering, set TRUEPPM_ALLOW_LAYERING_RAISE=1 and say so in the MR."
        )
        return 1
    if slack:
        n = sum(slack.values())
        print(
            f"  {n} site(s) fixed since the baseline was recorded -- lock them in with "
            "`python3 scripts/check-app-layering.py --update-baseline`"
        )
    if new:
        print(
            "\nLAYERING VIOLATION: new cross-app imports outside the declared layering:\n"
        )
        for edge, n in sorted(new.items()):
            s, d = edge
            print(f"  {s} -> {d}: {n} site(s), baseline allows {base.get(edge, 0)}")
            for site in sites[edge]:
                print(f"      {site}")
        print(
            f"""
The layering lives in {_CONFIG_REL}: an app may import apps in a lower layer (and
`platform`), never a higher one. Remediation, in order of preference:
  - Move the shared code down into a lower-layer app (or platform) and import it from there.
  - Invert the dependency: have the higher layer register against a hook, signal or
    registry the lower layer owns.
  - If the import is a deliberate exception, add `{_MARKER} <reason>` inside the import
    or on the comment line directly above it.
Do NOT raise the baseline to make this pass. See CLAUDE.md § Domain-app layering."""
        )
        return 1
    print("OK: no layering violations beyond the baseline.")
    return 0


# --------------------------------------------------------------------------- self-test

_FIXTURE_CFG = """\
[platform]
modules = ["core", "fields"]
[composition_roots]
modules = ["settings"]
[[layer]]
name = "low"
apps = ["base"]
[[layer]]
name = "high"
apps = ["top", "other"]
"""


def _stage(tmp: Path, files: dict[str, str]) -> tuple[Path, Path, Path]:
    pkg = tmp / _PKG_REL
    for app in ("base", "top", "other"):
        (pkg / "apps" / app).mkdir(parents=True, exist_ok=True)
    (pkg / "core").mkdir(parents=True, exist_ok=True)
    (pkg / "settings").mkdir(exist_ok=True)
    for rel, body in files.items():
        (pkg / rel).parent.mkdir(parents=True, exist_ok=True)
        (pkg / rel).write_text(body, encoding="utf-8")
    cfg = tmp / "cfg.toml"
    cfg.write_text(_FIXTURE_CFG, encoding="utf-8")
    return tmp, cfg, tmp / "baseline.txt"


def self_test() -> int:
    failed = 0

    def case(name: str, expect: int, files: dict[str, str], baseline: str = "") -> None:
        nonlocal failed
        with tempfile.TemporaryDirectory() as d:
            root, cfg, bl = _stage(Path(d), files)
            bl.write_text(baseline, encoding="utf-8")
            import contextlib
            import io

            with (
                contextlib.redirect_stdout(io.StringIO()),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                rc = run(root, cfg, bl)
        ok = rc == expect
        print(
            f"SELF-TEST {'OK' if ok else 'FAILED'}: {name} (exit {rc}, expected {expect})"
        )
        failed += not ok

    up = {"apps/base/m.py": "from trueppm_api.apps.top import thing\n"}
    case("upward import is rejected", 1, up)
    case(
        "downward import is accepted",
        0,
        {"apps/top/m.py": "from trueppm_api.apps.base import x\n"},
    )
    case(
        "same-layer import in a non-lateral layer is rejected",
        1,
        {"apps/top/m.py": "import trueppm_api.apps.other.models\n"},
    )
    case(
        "lazy in-function import is still counted",
        1,
        {"apps/base/m.py": "def f():\n    from trueppm_api.apps.top import t\n"},
    )
    case(
        "quoted module path is counted",
        1,
        {"apps/base/m.py": 'X = "trueppm_api.apps.top.tasks.run"\n'},
    )
    case(
        "relative cross-app import is counted",
        1,
        {"apps/base/m.py": "from ..top import t\n"},
    )
    case(
        "platform module importing an app is rejected",
        1,
        {"core/m.py": "from trueppm_api.apps.base import x\n"},
    )
    case(
        "app importing platform is accepted",
        0,
        {"apps/base/m.py": "from trueppm_api.core import x\n"},
    )
    case(
        "`from trueppm_api.apps import x` names the app",
        1,
        {"apps/base/m.py": "from trueppm_api.apps import top\n"},
    )
    case(
        "migrations are skipped",
        0,
        {"apps/base/migrations/0001_x.py": "from trueppm_api.apps.top import t\n"},
    )
    case(
        "TYPE_CHECKING import is counted",
        1,
        {
            "apps/base/m.py": "from typing import TYPE_CHECKING\n"
            "if TYPE_CHECKING:\n    from trueppm_api.apps.top.models import T\n"
        },
    )
    case(
        "module-level dotted `import a.b.c` is counted",
        1,
        {"apps/base/m.py": "import trueppm_api.apps.top.models.sub\n"},
    )
    case(
        "top-level platform file importing an app is rejected",
        1,
        {"fields.py": "from trueppm_api.apps.base import x\n"},
    )
    case(
        "marker separated by a blank line does not apply",
        1,
        {
            "apps/base/m.py": "# layering-ok: stale\n\nfrom trueppm_api.apps.top import t\n"
        },
    )
    case(
        "bare marker on a legal import still fails",
        1,
        {"apps/top/m.py": "from trueppm_api.apps.base import x  # layering-ok:\n"},
    )
    case("baselined violation passes", 0, up, "base -> top 1\n")
    case(
        "count above baseline fails",
        1,
        {
            "apps/base/m.py": "from trueppm_api.apps.top import a\nfrom trueppm_api.apps.top import b\n"
        },
        "base -> top 1\n",
    )
    case(
        "opt-out with a reason passes",
        0,
        {
            "apps/base/m.py": "# layering-ok: bootstrap hook\nfrom trueppm_api.apps.top import t\n"
        },
    )
    case(
        "opt-out without a reason fails",
        1,
        {"apps/base/m.py": "from trueppm_api.apps.top import t  # layering-ok:\n"},
    )
    case("unassigned app directory fails", 1, {"apps/ghost/__init__.py": ""})
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", type=Path, default=_REPO_ROOT)
    ap.add_argument("--config", type=Path)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument(
        "--graph", action="store_true", help="print violating edges and exit"
    )
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        return self_test()
    config = args.config or args.root / _CONFIG_REL
    baseline = args.baseline or args.root / _BASELINE_REL
    return run(
        args.root,
        config,
        baseline,
        update=args.update_baseline,
        graph=args.graph,
        check_base=args.baseline is None,
    )


if __name__ == "__main__":
    sys.exit(main())
