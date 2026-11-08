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

The count-based ratchet is honest about one limit. A new *edge* always fails, but within
an edge a site that was fixed and not locked in (``--update-baseline``) leaves slack
that a new violation on the same edge can reuse and pass. Failing on slack would make two
MRs that each fix a violation conflict, so instead every run prints the slack loudly with
the command that locks it in. For the same reason two MRs can each pass alone and red
the merged tree (A removes baselined site X; B, forked earlier, removes X and adds Y on
the same edge): the failure text says to rebase onto origin/main and re-run.

Nothing in the file format stops a person editing a count *up* by hand, so the gate also
compares the committed baseline with the copy at the merge base (the MR diff base in CI,
``git merge-base HEAD origin/main`` locally) and fails if an edge was added or a count
rose. A deliberate re-layering puts ``# raise-ok: <reason>`` on the line directly above
the edge in the baseline file, where a reviewer sees it in the diff (an env var cannot
work: push pipelines carry no variables). The marker is honored only while it is NEW
relative to the base copy -- one already present at the base was spent by the MR that
added it -- and ``--update-baseline`` drops a marker whose edge is no longer above the
base count. It is still a self-grant written in the file it guards, a rubber stamp like
``# layering-ok:``: it removes the silence, not the possibility of a wrong answer. The check fails closed -- if the CI diff base
or an explicit ``TRUEPPM_LAYERING_BASE_REF`` cannot be resolved the run fails, so the
job needs ``GIT_DEPTH: 0``. It is skipped, with a printed note, only when there is no
CI variable and no ``origin/main`` merge base (a local clone with no remote, or a
pipeline on ``main``); it passes when the base genuinely has no baseline file (the MR
that introduced it).

Which files are read
--------------------
Tracked ``.py`` files only (``git ls-files``), so gitignored residue -- a deleted app's
leftover ``migrations/`` and ``__pycache__/``, a scratch file -- cannot fail a checkout
whose tracked tree is clean. Outside a git repository (the self-test fixtures) every
``.py`` is read. A git failure inside a work tree (e.g. ``safe.directory``) is an error,
not a fallback. An app is a directory containing ``__init__.py``; tracked ``.py`` files in
an ``apps/<x>/`` without one are an error; a ``.py`` module
directly under ``apps/`` belongs to no app and is reported as an error.

Opting out
----------
A deliberate exception carries ``# layering-ok: <reason>`` inside the import or in the
comment block directly above it (a blank line ends the block). The reason is required,
and a bare ``# layering-ok:`` fails the gate on any line of a scanned file, even away
from an import. The number of opted-out sites is printed on every run. Like ``# safe-bulk-create:``
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
* Imports of a composition root (``trueppm_api.celery``, ``settings``, ``urls``):
  roots wire everything together by design, so an app importing one is ignored.
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
    python3 scripts/check-app-layering.py --graph          # print the violating edges
    python3 scripts/check-app-layering.py --graph --all    # print EVERY cross-unit edge with site counts
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
from typing import NamedTuple
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


def _has_marker(lines: list[str], first: int, last: int) -> bool:
    """Is the import covered by ``# layering-ok: <reason>`` (reason non-empty)?

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
    return any(
        _MARKER in line and line.split(_MARKER, 1)[1].strip() for line in candidates
    )


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


class ScanResult(NamedTuple):
    counts: Counter[Edge]  # violating edges, opt-outs excluded
    sites: dict[Edge, list[str]]
    errors: list[str]
    all_edges: Counter[Edge]  # every cross-unit edge, violating or not
    opted: list[str]


def _in_git_repo(root: Path) -> bool:
    """Is ``root`` inside a git work tree? Raises on a git failure that is not "no repo".

    A failure such as ``safe.directory`` ("dubious ownership") must not read as "not a
    repository": that would silently re-admit gitignored residue.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    if out.returncode == 0:
        return out.stdout.strip() == "true"
    if "not a git repository" in out.stderr:
        return False
    raise SystemExit(f"ERROR: git cannot read {root}: {out.stderr.strip()}")


def _source_files(root: Path, pkg_dir: Path) -> tuple[list[Path], bool]:
    """Return ``(python files, tracked_mode)``.

    In a git checkout only tracked ``.py`` files are read: walking the filesystem would
    pick up gitignored residue (a deleted app's leftover ``migrations/`` and
    ``__pycache__/``, a scratch ``.py``) and fail a tree whose tracked content is clean.
    A git failure inside a work tree is an error, never a silent fallback to a walk.
    Outside git (the self-test fixtures) every ``.py`` is read.
    """
    if _in_git_repo(root):
        rel = pkg_dir.relative_to(root).as_posix()
        rc, out = _git(root, "ls-files", "-z", "--", rel)
        if rc != 0:
            raise SystemExit(f"ERROR: git ls-files failed in {root} (rc {rc})")
        if out:
            files = [root / f for f in out.split("\0") if f.endswith(".py") and f]
            return sorted(files), True
    return sorted(pkg_dir.rglob("*.py")), False


def scan(root: Path, cfg: Config) -> ScanResult:
    """Scan the package; see the module docstring for what is counted."""
    pkg_dir = root / _PKG_REL
    errors: list[str] = []
    if not pkg_dir.is_dir():
        raise SystemExit(f"ERROR: {pkg_dir} is not a directory")

    paths, tracked_mode = _source_files(root, pkg_dir)
    files = [
        (path, path.relative_to(pkg_dir).parts)
        for path in paths
        if "migrations" not in path.parts
    ]
    # An app is a directory with an __init__.py among the files read; a directory with
    # only __pycache__/ or migrations/ left behind is not one.
    on_disk = {
        r[1]
        for _, r in files
        if r[0] == "apps" and len(r) == 3 and r[2] == "__init__.py"
    }
    for app in sorted(on_disk - set(cfg.app_layer)):
        errors.append(
            f"app {app!r} exists but is not assigned a layer in {_CONFIG_REL}"
        )
    for app in sorted(set(cfg.app_layer) - on_disk):
        errors.append(
            f"{_CONFIG_REL} assigns a layer to {app!r}, which is not an app directory "
            "(a new app not yet `git add`ed? the gate reads tracked files)"
        )
    if tracked_mode:
        # Tracked code with no __init__.py would be silently unscanned. Untracked residue
        # never reaches here, so it stays ignored.
        has_py = {r[1] for _, r in files if r[0] == "apps" and len(r) >= 3}
        for app in sorted(has_py - on_disk):
            errors.append(
                f"apps/{app}/ has tracked .py files but no __init__.py, so the gate "
                "would not scan it"
            )
    tops = {r[0].removesuffix(".py") for _, r in files if r[0] != "apps"} - {"__init__"}
    for name in sorted(tops - cfg.platform - cfg.roots):
        errors.append(
            f"top-level module {name!r} is neither platform nor a composition root"
        )
    for _, r in files:
        if r[0] == "apps" and len(r) == 2 and r[1] != "__init__.py":
            errors.append(
                f"apps/{r[1]} is a module directly under apps/, outside any app; "
                "the gate would not scan it"
            )

    counts: Counter[Edge] = Counter()
    all_edges: Counter[Edge] = Counter()
    sites: dict[Edge, list[str]] = {}
    opted: list[str] = []
    for path, rel in files:
        src = _file_unit(rel, cfg)
        if src is None or (src != _PLATFORM and src not in cfg.app_layer):
            continue
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        shown = "/".join((_PKG_REL, *rel))
        # A reasonless marker is an error wherever it sits, so a half-written opt-out
        # cannot lurk until someone moves an import under it.
        for i, line in enumerate(lines, 1):
            if _MARKER in line and not line.split(_MARKER, 1)[1].strip():
                errors.append(f"{shown}:{i}: {_MARKER} needs a reason")
        pkg = ["trueppm_api", *rel[:-1]]
        for lineno, end, parts in _imports(ast.parse(text), pkg):
            dst = _unit_of_module(parts, cfg)
            if (
                dst is None
                or dst == src
                or (dst != _PLATFORM and dst not in cfg.app_layer)
            ):
                continue
            all_edges[(src, dst)] += 1
            if not cfg.violates(src, dst):
                continue
            if _has_marker(lines, lineno, end):
                opted.append(f"{shown}:{lineno}")
                continue
            counts[(src, dst)] += 1
            sites.setdefault((src, dst), []).append(f"{shown}:{lineno}")
    return ScanResult(counts, sites, errors, all_edges, opted)


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
# A deliberate raise is a hand edit with `# raise-ok: <reason>` on the line above the edge.
"""
_RAISE_OK = "# raise-ok:"


def _raise_marks(text: str, name: str) -> tuple[dict[Edge, str], list[str]]:
    """Edges carrying ``# raise-ok: <reason>`` on the line above, plus reasonless markers."""
    marks: dict[Edge, str] = {}
    errors: list[str] = []
    prev = ""
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if line.startswith(_RAISE_OK) and not line[len(_RAISE_OK) :].strip():
            errors.append(f"{name}:{n}: {_RAISE_OK} needs a reason")
        m = _BASELINE_LINE.match(line)
        if m and prev.startswith(_RAISE_OK) and prev[len(_RAISE_OK) :].strip():
            marks[(m[1], m[2])] = prev
        prev = line
    return marks, errors


def _file_marks(path: Path) -> tuple[dict[Edge, str], list[str]]:
    if not path.exists():
        return {}, []
    return _raise_marks(path.read_text(encoding="utf-8"), path.name)


def write_baseline(
    path: Path, counts: Counter[Edge], base: Counter[Edge] | None = None
) -> None:
    """Write the baseline, carrying a ``# raise-ok:`` forward only while it still raises.

    With a merge-base copy known, a marker whose edge is no longer above the base count
    is dropped: it has done its job, and leaving it would let a later MR raise the same
    edge with nothing new in its diff.
    """
    marks, _ = _file_marks(path)
    body = ""
    for (s, d), n in sorted(counts.items()):
        if (s, d) in marks and (base is None or n > base.get((s, d), 0)):
            body += f"{marks[(s, d)]}\n"
        body += f"{s} -> {d} {n}\n"
    path.write_text(_BASELINE_HEADER + body, encoding="utf-8")


def _git(root: Path, *args: str) -> tuple[int, str]:
    """Run git; returns ``(returncode, stdout)``, rc -1 when git cannot be run."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), *args], capture_output=True, text=True
        )
    except OSError:
        return -1, ""
    return out.returncode, out.stdout


class _Base(NamedTuple):
    counts: Counter[Edge] | None  # None: no base baseline to compare against
    marks: dict[Edge, str]
    errors: list[str]


def _base_baseline(root: Path, baseline: Path) -> _Base:
    """The baseline as it stood at the merge base, or why it cannot be read.

    Fails closed: if the CI diff base (or an explicit ref) is named but cannot be read,
    that is an error, not a skip. The check is skipped, with a note, only when there is
    no CI variable and no ``origin/main`` to take a merge base against -- a local clone
    with no remote -- or when HEAD is the merge base (a pipeline on ``main``).
    """
    ref = os.environ.get("TRUEPPM_LAYERING_BASE_REF") or os.environ.get(
        "CI_MERGE_REQUEST_DIFF_BASE_SHA"
    )
    if ref:
        if _git(root, "cat-file", "-e", f"{ref}^{{commit}}")[0] != 0:
            return _Base(
                None,
                {},
                [
                    f"base ref {ref!r} is not reachable, so the baseline cannot be compared "
                    "against it (shallow clone? the job needs GIT_DEPTH: 0)"
                ],
            )
    else:
        rc, mb = _git(root, "merge-base", "HEAD", "origin/main")
        _, head = _git(root, "rev-parse", "HEAD")
        if rc != 0 or not mb.strip() or mb == head:
            print(
                "  note: no merge base available (no origin/main, or on main) -- baseline-raise check skipped"
            )
            return _Base(None, {}, [])
        ref = mb.strip()
    try:
        rel = baseline.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return _Base(None, {}, [])
    rc, listing = _git(root, "ls-tree", ref, "--", rel)
    if rc != 0:
        return _Base(
            None,
            {},
            [f"git ls-tree {ref} -- {rel} failed; cannot read the base baseline"],
        )
    if not listing.strip():
        return _Base(
            None, {}, []
        )  # genuinely absent at the base: this change introduces it
    rc, old_text = _git(root, "show", f"{ref}:{rel}")
    if rc != 0:
        return _Base(
            None, {}, [f"git show {ref}:{rel} failed; cannot read the base baseline"]
        )
    old: Counter[Edge] = Counter()
    for line in old_text.splitlines():
        m = _BASELINE_LINE.match(line.strip())
        if m:
            old[(m[1], m[2])] = int(m[3])
    return _Base(old, _raise_marks(old_text, "base baseline")[0], [])


def _baseline_raised(root: Path, baseline: Path) -> tuple[list[str], list[str]]:
    """Return ``(raised edges, errors)`` for the baseline versus its merge-base copy.

    A ``# raise-ok:`` is honored only if it is NEW relative to the base copy: a marker
    already present at the base was spent by the MR that added it. It is still a
    self-grant written in the file it guards -- a reviewer reading the diff is the
    control, not the gate.
    """
    marks, errors = _file_marks(baseline)
    base = _base_baseline(root, baseline)
    errors = errors[:] + base.errors
    if base.counts is None:
        return [], errors
    now = read_baseline(baseline)
    raised = [
        f"{s} -> {d}: {base.counts.get((s, d), 0)} -> {n}"
        for (s, d), n in sorted(now.items())
        if n > base.counts.get((s, d), 0)
        and ((s, d) not in marks or (s, d) in base.marks)
    ]
    return raised, errors


def run(
    root: Path,
    config: Path,
    baseline: Path,
    *,
    update: bool = False,
    graph: bool = False,
    graph_all: bool = False,
    check_base: bool = False,
) -> int:
    cfg = Config(tomllib.loads(config.read_text(encoding="utf-8")))
    res = scan(root, cfg)
    counts, sites, errors, opted = res.counts, res.sites, list(res.errors), res.opted
    base = read_baseline(baseline)

    if graph:
        shown = res.all_edges if graph_all else counts
        for (s, d), n in sorted(shown.items()):
            print(f"{s} -> {d} {n}")
        what = "edges" if graph_all else "violating edges"
        print(f"{len(shown)} {what}, {sum(shown.values())} sites")
        return 0

    new = {e: n for e, n in counts.items() if n > base.get(e, 0)}
    slack = {e: base[e] - counts.get(e, 0) for e in base if counts.get(e, 0) < base[e]}

    if update:
        if errors:
            for e in errors:
                print(f"  {e}", file=sys.stderr)
            return 1
        # A missing baseline is the one-time bootstrap; after that it only shrinks.
        if new and baseline.exists():
            print(
                "refusing to --update-baseline: it would add or raise entries:",
                file=sys.stderr,
            )
            for (s, d), n in sorted(new.items()):
                print(f"  {s} -> {d}: {base.get((s, d), 0)} -> {n}", file=sys.stderr)
            return 1
        write_baseline(
            baseline,
            counts,
            _base_baseline(root, baseline).counts if check_base else None,
        )
        print(f"baseline updated: {sum(counts.values())} sites on {len(counts)} edges")
        return 0

    cur_total, base_total = sum(counts.values()), sum(base.values())
    print(
        f"app layering: {cur_total} violating import sites on {len(counts)} edges "
        f"(baseline {base_total} on {len(base)} edges); {len(opted)} opted out via {_MARKER}"
    )
    raised: list[str] = []
    if check_base:
        raised, base_errors = _baseline_raised(root, baseline)
        errors += base_errors
    if errors:
        print("\nLAYERING CONFIG/MARKER/BASELINE ERRORS:\n", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 1
    if slack:
        print(
            f"\n  !! {sum(slack.values())} baselined site(s) have been fixed but the baseline still "
            "allows them. Until it is lowered, a NEW violation on the same edge reuses that "
            "allowance and passes. Lock the improvement in now:\n"
            "       python3 scripts/check-app-layering.py --update-baseline"
        )
        for (s, d), n in sorted(slack.items()):
            print(f"       {s} -> {d}: {n} fixed")
    if raised:
        print("\nLAYERING BASELINE RAISED against the merge base:\n")
        for line in raised:
            print(f"  {line}")
        print(
            f"\nThe baseline is a ceiling that only shrinks. Fix the violation instead, or, for "
            f"a deliberate re-layering, put `{_RAISE_OK} <reason>` on the line above the edge "
            "in the baseline file so a reviewer sees it in the diff."
        )
        return 1
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
If this is a count that is only one over after a merge: another MR may have removed a
baselined site on this edge while this branch removed the same one, so each passes
alone. Rebase onto origin/main, re-run the gate, and run `--update-baseline`.
Do NOT raise the baseline to make this pass. See CLAUDE.md, Key Design Principles (4)."""
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
        (pkg / "apps" / app / "__init__.py").write_text("", encoding="utf-8")
    (pkg / "core").mkdir(parents=True, exist_ok=True)
    (pkg / "settings").mkdir(exist_ok=True)
    for rel, body in files.items():
        (pkg / rel).parent.mkdir(parents=True, exist_ok=True)
        (pkg / rel).write_text(body, encoding="utf-8")
    cfg = tmp / "cfg.toml"
    cfg.write_text(_FIXTURE_CFG, encoding="utf-8")
    return tmp, cfg, tmp / "baseline.txt"


def self_test() -> int:
    # Under a git hook (pre-push) git exports GIT_DIR / GIT_INDEX_FILE, which would make
    # every temp fixture look like part of the real repository. Fixtures run as if from
    # a clean shell.
    for var in (
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_COMMON_DIR",
    ):
        os.environ.pop(var, None)
    failed = 0

    def case(
        name: str,
        expect: int,
        files: dict[str, str],
        baseline: str = "",
        late: dict[str, str] | None = None,
    ) -> None:
        """Run one fixture. ``late`` files are written AFTER ``git add``: untracked residue."""
        nonlocal failed
        with tempfile.TemporaryDirectory() as d:
            root, cfg, bl = _stage(Path(d), files)
            bl.write_text(baseline, encoding="utf-8")
            if late is not None:
                subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
                subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
                for rel, body in late.items():
                    f = root / _PKG_REL / rel
                    f.parent.mkdir(parents=True, exist_ok=True)
                    f.write_text(body, encoding="utf-8")
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
    case(
        "a leftover dir with only migrations/ and no __init__.py is not an app",
        0,
        {
            "apps/residue/migrations/0001_x.py": "x = 1\n",
            "apps/residue/helper.py": "from trueppm_api.apps.top import t\n",
        },
    )
    case(
        "a module directly under apps/ is flagged",
        1,
        {"apps/stray.py": "x = 1\n"},
    )
    case(
        "a bare marker on a line with no import still fails",
        1,
        {"apps/base/m.py": "x = 1  # layering-ok:\n"},
    )
    case(
        "tracked .py in an apps/<x>/ with no __init__.py is an error",
        1,
        {"apps/noinit/helper.py": "x = 1\n"},
        late={},
    )
    case(
        "untracked residue (a dir with a violating .py, a stray .py) is ignored in git",
        0,
        {},
        late={
            "apps/residue/helper.py": "from trueppm_api.apps.top import t\n",
            "apps/base/scratch.py": "from trueppm_api.apps.top import t\n",
        },
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
    ap.add_argument(
        "--all",
        action="store_true",
        help="with --graph: every edge, not only violations",
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
        graph_all=args.all,
        check_base=args.baseline is None,
    )


if __name__ == "__main__":
    sys.exit(main())
