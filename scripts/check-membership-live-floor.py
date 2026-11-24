#!/usr/bin/env python3
"""Fail when an API module READS ProjectMembership/ProgramMembership unfloored.

Why this exists (#3458). Revoking access **soft-deletes** the membership row; the
``uniq_(project|program)_membership_..._user`` constraint is unconditional, so the
tombstone keeps owning the slot and any lookup that omits ``is_deleted`` hands back a
departed member with their old role intact. That defect was fixed five separate times,
as five separate issues, in five separate places:

    #3386 (!2315)  the write gates, on the facet and role axes
    #3410          re-adding a revoked project member 500s
    #3411 (!2345)  three read paths: retro visibility, USER custom fields, team services
    #3456          the weekly program-health digest emailed revoked members
    #3457          the seed exporter wrote revoked members into the export roster

Every one was found by a gate sweep on an unrelated MR. Nothing ran on a branch, so the
recurrence interval was set by luck.

## The rule

A **read** through ``ProjectMembership.objects`` / ``ProgramMembership.objects`` must be
floored — either by ``.live()`` or by an ``is_deleted`` term in a ``filter``/``exclude``/
``get`` (a ``Q()`` counts). Three things are exempt, by rule rather than by list:

  * **writes** — ``create`` / ``get_or_create`` / ``update_or_create`` / ``bulk_*`` /
    ``update`` / ``delete`` address rows the caller already named; a manager filter
    would be meaningless, and the importer's deliberate tombstone reset (#3457) lives
    here;
  * **lock acquisitions** — a chain carrying ``select_for_update`` is taking row locks
    before a write. It must cover the revoked row or the revive path races;
  * **migrations** — historical models, run once, against whatever rows exist.

Everything else is checked, and a module that genuinely must see revoked rows is named
in ALLOWLIST below with the reason.

## The project-axis rule (#4599)

The membership floor above says the *row* is live. It says nothing about the *project*:
trashing a project soft-deletes the ``Project`` and leaves every membership row intact,
so a membership read keyed on ``project_id`` still answers for a trashed project and a
notification, digest or @-group expansion fans out to its members. #4577 hand-swept the
axis; when this rule landed, most ProjectMembership reads still omitted it (see the totals
the gate prints and docs/harness/membership-live-floor.md for the measured counts). The second rule therefore requires a read through
``ProjectMembership`` to carry a ``project__is_deleted`` term in a ``filter``/``exclude``/
``get`` (``Q()`` counts; the term is ``project__is_deleted`` or ``project__is_deleted__<lookup>``,
never ``user__project__is_deleted``), unless the site carries a ``# project-axis-ok: <reason>``
comment on its own line or alone on the line above (the reason is required, one marker covers one
read, and there is no per-module exemption), or the site is counted in
``packages/api/membership-project-floor-baseline.txt``.

The baseline is a per-module ratchet with two checks. Against the source: a count that
rose, or a module not listed, fails, and a count that fell also fails until
``--update-baseline`` locks the fix in, so a fixed site cannot be silently reused by a new
violation. Against the merge-base copy of the file (``git show <merge-base>:<path>``): a
count that is higher than at the base, or a new module, fails unless a reasoned
``# raise-ok: <reason>`` sits on the line above the entry (honored only while new relative to
the base; a self-grant that a reviewer reads in the diff). Where the file does not exist at the
merge base (the change that creates it) or the run is on ``main``, there is nothing to compare
against and that check is skipped with a printed note. ``--update-baseline`` refuses to raise a
count or add a module, and refuses outright when the file is missing or empty. A baselined site
is *not* an audited-safe one: most sit behind a permission class or an already-floored project
fetch, which this AST cannot see. The gate checks that a ``project__is_deleted`` term is
present, not its value, so a trash-listing read written ``project__is_deleted=True`` satisfies it.
It reads only ``ProjectMembership``: ``ProgramMembership`` is not checked against
``program__is_deleted`` and ``TeamMembership`` is not checked on the project axis.

## Why AST and not grep, and why scope-inverted

Measured on ``main`` before this gate landed: **127** membership-manager chains in
``packages/api/src`` outside migrations, of which **12** are unfloored reads — and all
12 are correct by design. A bare ``*Membership.objects`` grep is therefore a **100%
false-positive** gate, and a gate that is wrong every time it fires is disabled within a
week. What makes the rule affordable is that those 12 sites sit in exactly **four**
modules, so inverting the scope — check everywhere, exempt a named few — costs a
four-line allowlist and fires zero false positives on the tree it shipped against.

AST rather than a line-oriented regex for two reasons the #3411 sweep hit by hand:
``is_deleted`` is a **column**, so it appears in ``.only("role", "is_deleted")`` (a
projection, not a filter) and in the SELECT list of every membership query — a substring
probe reports a false pass on a completely unfiltered read; and a chain spanning several
source lines is invisible to a per-line match.

## What this cannot do

  * It is blind to a defect **inside** an allowlisted module. That is the price of
    zero false positives, and the four are the RBAC-write core, which gets the most
    review attention.
  * It is blind to **join filters** (``memberships__is_deleted=False``) and to reverse
    traversals (``program.memberships.all()``). There are zero of the latter on the
    membership axis today — the only ``.memberships.filter()`` in the tree is ``Team``'s,
    a different model — but a new one would not be seen.
  * File **discovery** differs between the real run (``git ls-files``, so a gitignored
    file can never red the gate) and ``--self-test`` (explicit ``--files``). The
    detection logic is identical and is what the self-test exercises; a mis-scoped real
    run is caught by exiting **2** when discovery yields nothing, not by reading as green.

Usage:
  check-membership-live-floor.py [ROOT]          # ROOT defaults to packages/api/src
  check-membership-live-floor.py --files A B ...  # check exactly these files
  check-membership-live-floor.py --update-baseline  # lock in fixed project-axis sites
  check-membership-live-floor.py --self-test

Exit codes:
  0  every membership read is floored, exempt, or allowlisted
  1  at least one unfloored read
  2  invocation error (including: discovery found no files)
"""

from __future__ import annotations

import ast
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import tokenize
from pathlib import Path

DEFAULT_ROOT = "packages/api/src"

MODELS = ("ProjectMembership", "ProgramMembership")

# Manager methods that WRITE. A chain containing one is not a read.
WRITE_METHODS = frozenset(
    {
        "create",
        "get_or_create",
        "update_or_create",
        "bulk_create",
        "bulk_update",
        "update",
        "delete",
        "acreate",
    }
)

# Calls whose keywords express a WHERE term. `.only()` / `.values()` / `.defer()` are
# deliberately absent: they are projections. `access/signals.py` reads
# `.only("role", "is_deleted")` on a completely unfiltered manager — the line that
# defeated the #3411 line-oriented sweep.
FILTERING_METHODS = frozenset({"filter", "exclude", "get", "aget"})

FLOOR_FIELD = "is_deleted"

# Modules whose membership reads MUST see revoked rows. Path is relative to ROOT.
# One entry per module, with the reason a floor would be wrong there. Adding an entry is
# a reviewable act; that is the whole mechanism.
ALLOWLIST: dict[str, str] = {
    "trueppm_api/apps/access/views.py": (
        "the add-member path must FIND a revoked row in order to revive it against the "
        "unconditional (scope, user) constraint, and must probe for one to narrow its "
        "IntegrityError to the uniqueness race (#3410)"
    ),
    "trueppm_api/apps/access/signals.py": (
        "the pre_save receiver reads the PRIOR row precisely to detect the revocation "
        "transition — flooring it would delete the signal it exists to emit"
    ),
    "trueppm_api/apps/access/serializers.py": (
        "the reachable-target subqueries must include revoked peers, or a revoked member "
        "could never be re-added: the write serializer's `user` field is its own IDOR "
        "gate and bounds the choices (#3410)"
    ),
    "trueppm_api/apps/access/minter_role.py": (
        "a project-scoped API token's minter is floored on their LAST RECORDED role, "
        "live or revoked: flooring the read made removal an unconditional pass, so a "
        "minter demoted to Viewer could self-remove and regain write authority (#4334). "
        "The module holds that one read and nothing else"
    ),
    "trueppm_api/apps/sync/views.py": (
        "the sync delta ships TOMBSTONES by protocol so an offline client can learn the "
        "membership went away; a floored stream would leave the row on the device forever"
    ),
}


BASELINE_PATH = "packages/api/membership-project-floor-baseline.txt"
PROJECT_FLOOR_FIELD = "project__is_deleted"

# Per-site opt-out for the project-axis rule: a real comment `# project-axis-ok: <reason>`
# on the read's own line, or alone on the line directly above it. The reason is required
# (a bare marker is ignored) and one marker covers one read. There is no per-module
# exemption: a future read in a module that holds a reviewed one still has to floor or mark.
PROJECT_AXIS_OK = "# project-axis-ok:"
RAISE_OK = "# raise-ok:"


def _chain(node: ast.AST) -> list[tuple[str, ast.Call | None]]:
    """Decompose an attribute/call chain into [(name, call_or_None), ...], outermost last."""
    steps: list[tuple[str, ast.Call | None]] = []
    cur: ast.AST = node
    while True:
        if isinstance(cur, ast.Call) and isinstance(cur.func, ast.Attribute):
            steps.append((cur.func.attr, cur))
            cur = cur.func.value
        elif isinstance(cur, ast.Attribute):
            steps.append((cur.attr, None))
            cur = cur.value
        else:
            break
    steps.reverse()
    return steps


def _mentions_floor(call: ast.Call) -> bool:
    """True if this call carries an `is_deleted` WHERE term, kwarg or inside a Q()."""
    for kw in call.keywords:
        if kw.arg and kw.arg.split("__")[-1] == FLOOR_FIELD:
            return True
    # Q(is_deleted=False) / Q(...) | Q(...) — walk the positional args for the keyword.
    for arg in call.args:
        for sub in ast.walk(arg):
            if (
                isinstance(sub, ast.keyword)
                and sub.arg
                and sub.arg.split("__")[-1] == FLOOR_FIELD
            ):
                return True
    return False


def _is_project_floor_kwarg(name: str | None) -> bool:
    """True for ``project__is_deleted`` or ``project__is_deleted__<lookup>`` exactly.

    A prefix such as ``user__project__is_deleted`` floors some OTHER model's project, not
    the membership's own, so a suffix match would read it as a floor it is not.
    """
    return bool(name) and (
        name == PROJECT_FLOOR_FIELD or name.startswith(PROJECT_FLOOR_FIELD + "__")  # type: ignore[union-attr]
    )


def _mentions_project_floor(call: ast.Call) -> bool:
    """True if this call carries a ``project__is_deleted`` WHERE term, kwarg or in a Q()."""
    for kw in call.keywords:
        if _is_project_floor_kwarg(kw.arg):
            return True
    for arg in call.args:
        for sub in ast.walk(arg):
            if isinstance(sub, ast.keyword) and _is_project_floor_kwarg(sub.arg):
                return True
    return False


def _outermost(parents: dict[int, ast.AST], node: ast.AST) -> ast.AST:
    """Climb to the end of the attribute/call chain this node starts."""
    cur: ast.AST = node
    while True:
        parent = parents.get(id(cur))
        if isinstance(parent, ast.Attribute) and parent.value is cur:
            cur = parent
        elif isinstance(parent, ast.Call) and parent.func is cur:
            cur = parent
        else:
            return cur


def _is_membership_root(node: ast.AST) -> str | None:
    """Return the model name if `node` is `<Model>.objects` / `<Model>.live`."""
    if not isinstance(node, ast.Attribute) or node.attr not in ("objects", "live"):
        return None
    base = node.value
    name = (
        base.id
        if isinstance(base, ast.Name)
        else base.attr
        if isinstance(base, ast.Attribute)
        else None
    )
    return name if name in MODELS else None


def _finding_for_node(
    node: ast.AST, parents: dict[int, ast.AST], seen: set[int]
) -> tuple[int, str, str] | None:
    """The finding tuple for `node` if it roots an unfloored membership read, else None.

    Mutates `seen` with the outermost chain's id so a chain spanning several
    membership-root attribute nodes (rare, but possible via chained managers) is
    only ever reported once.
    """
    model = _is_membership_root(node)
    if model is None:
        return None
    top = _outermost(parents, node)
    if id(top) in seen:
        return None
    seen.add(id(top))

    steps = _chain(top)
    methods = {name for name, _ in steps}
    if methods & WRITE_METHODS:
        return None  # a write, not a read
    if "select_for_update" in methods:
        return None  # a lock acquisition, must cover the revoked row
    if "live" in methods:
        return None  # floored by the shared helper
    if any(
        call is not None and name in FILTERING_METHODS and _mentions_floor(call)
        for name, call in steps
    ):
        return None  # floored inline

    src = " ".join(ast.unparse(top).split())
    if len(src) > 120:
        src = src[:117] + "..."
    return (getattr(node, "lineno", 0), model, src)


def scan_file(path: Path) -> list[tuple[int, str, str]]:
    """Return [(lineno, model, source)] for every unfloored read in this file."""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return []

    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent

    seen: set[int] = set()
    return [
        finding
        for node in ast.walk(tree)
        if (finding := _finding_for_node(node, parents, seen)) is not None
    ]


def _is_project_membership_root(node: ast.AST) -> bool:
    """True for ``ProjectMembership.objects`` / ``.live`` (attribute) roots."""
    if not isinstance(node, ast.Attribute) or node.attr not in ("objects", "live"):
        return False
    base = node.value
    name = (
        base.id
        if isinstance(base, ast.Name)
        else base.attr
        if isinstance(base, ast.Attribute)
        else None
    )
    return name == "ProjectMembership"


def _markers(source: str) -> dict[int, bool]:
    """``{line: comment_only}`` for each real ``# project-axis-ok: <reason>`` comment.

    Read with ``tokenize`` so the marker text inside a string literal, or in code, is not a
    marker. ``comment_only`` is True when nothing but whitespace precedes the comment.
    """
    found: dict[int, bool] = {}
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type != tokenize.COMMENT:
                continue
            text = tok.string.strip()
            if (
                text.startswith(PROJECT_AXIS_OK)
                and text[len(PROJECT_AXIS_OK) :].strip()
            ):
                found[tok.start[0]] = not tok.line[: tok.start[1]].strip()
    except (tokenize.TokenError, IndentationError):
        return {}
    return found


def _opted_out(markers: dict[int, bool], lineno: int, used: set[int]) -> bool:
    """True if the read at ``lineno`` carries an unspent, reasoned ``# project-axis-ok:``.

    The marker is on the read's own line, or on the line above only when that line is a
    comment-only line (a marker trailing read A's code never reaches read B below it).
    Each marker covers one read: it is spent once used. A marker with no reason is not in
    ``markers``, so the read still counts and the gate still fails on it.
    """
    for line, need_comment_only in ((lineno, False), (lineno - 1, True)):
        if (
            line in markers
            and line not in used
            and (markers[line] or not need_comment_only)
        ):
            used.add(line)
            return True
    return False


def scan_project_axis_detail(path: Path) -> tuple[list[tuple[int, str]], int, int]:
    """``(hits, opted_out, floored)`` for every ProjectMembership read in the file.

    ``hits`` are reads lacking a project floor and lacking an opt-out. The gate checks that
    a ``project__is_deleted`` TERM is present, not what it asks for: a trash-listing read
    written ``project__is_deleted=True`` satisfies it, which is intended there.
    """
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (SyntaxError, UnicodeDecodeError):
        return [], 0, 0
    markers = _markers(source)
    used: set[int] = set()
    parents: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
    seen: set[int] = set()
    hits: list[tuple[int, str]] = []
    opted_out = floored = 0
    for node in ast.walk(tree):
        if not _is_project_membership_root(node):
            continue
        top = _outermost(parents, node)
        if id(top) in seen:
            continue
        seen.add(id(top))
        steps = _chain(top)
        methods = {name for name, _ in steps}
        if methods & WRITE_METHODS or "select_for_update" in methods:
            continue
        if any(
            call is not None
            and name in FILTERING_METHODS
            and _mentions_project_floor(call)
            for name, call in steps
        ):
            floored += 1
            continue
        lineno = getattr(node, "lineno", 0)
        if _opted_out(markers, lineno, used):
            opted_out += 1
            continue
        src = " ".join(ast.unparse(top).split())
        hits.append((lineno, src[:117] + "..." if len(src) > 120 else src))
    # A marker that bound no unfloored read is stale (its read was deleted or floored):
    # left alone it would silently opt out whatever unfloored read lands on the line below.
    for line in sorted(set(markers) - used):
        hits.append((line, f"project-axis-ok marker at {line} binds no unfloored read"))
    return hits, opted_out, floored


def scan_project_axis(path: Path) -> list[tuple[int, str]]:
    """Return [(lineno, source)] for every ProjectMembership read lacking a project floor."""
    return scan_project_axis_detail(path)[0]


def parse_baseline(text: str) -> dict[str, int]:
    """Parse ``<module> <count>`` lines; blank and ``#`` lines are ignored."""
    out: dict[str, int] = {}
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        rel, _, count = line.rpartition(" ")
        out[rel.strip()] = int(count)
    return out


def read_baseline(path: Path) -> dict[str, int]:
    return parse_baseline(path.read_text(encoding="utf-8")) if path.is_file() else {}


def raise_marks(text: str) -> dict[str, str]:
    """``{module: reason}`` for entries with a reasoned ``# raise-ok:`` directly above them."""
    marks: dict[str, str] = {}
    prev = ""
    for raw in text.splitlines():
        line = raw.strip()
        if (
            line
            and not line.startswith("#")
            and prev.startswith(RAISE_OK)
            and prev[len(RAISE_OK) :].strip()
        ):
            marks[line.rpartition(" ")[0].strip()] = prev[len(RAISE_OK) :].strip()
        prev = line
    return marks


def baseline_raised(now_text: str, base_text: str | None) -> list[str]:
    """Errors for entries raised (count up, or new module) versus the merge-base copy.

    ``None`` means there is no base copy to ratchet against. A ``# raise-ok: <reason>``
    marker is honored only while new relative to the base copy: one already at the base was
    spent by the change that added it. It is a self-grant in the file it guards, so a
    reviewer has to read it in the diff.
    """
    if base_text is None:
        return []
    now, base = parse_baseline(now_text), parse_baseline(base_text)
    marks, base_marks = raise_marks(now_text), raise_marks(base_text)
    errors = []
    for rel, count in sorted(now.items()):
        was = base.get(rel, 0)
        if count > was and (rel not in marks or rel in base_marks):
            errors.append(
                f"baseline raised: {rel} {was} -> {count} versus the merge base. The baseline "
                f"can only shrink; a deliberate raise needs a new '{RAISE_OK} <reason>' on the "
                "line above the entry (reviewed in the diff). Otherwise floor the read."
            )
    return errors


def _git(*args: str) -> tuple[int, str]:
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    return r.returncode, r.stdout


def base_baseline_text(path: str) -> tuple[str | None, str, list[str]]:
    """``(text, note, errors)``: the baseline as committed at the merge base.

    Resolution order matches ``check-app-layering.py``: the CI diff base
    (``CI_MERGE_REQUEST_DIFF_BASE_SHA``), then the merge base with ``origin/main``. Only two
    skips are legitimate, and both set a printed ``note``: the file is absent at the
    resolved base (this change introduces it), or the run is on the default branch. Anything
    else that stops the base being read (an unreachable SHA, a failed ``ls-tree`` or
    ``show``, or in CI no resolvable merge base) lands in ``errors``, so it fails the run
    instead of passing it unratcheted. A local clone with no ``origin/main`` at all is the one
    other skip, as in app-layering.
    """
    _, head = _git("rev-parse", "HEAD")
    ref = os.environ.get("CI_MERGE_REQUEST_DIFF_BASE_SHA", "").strip()
    if ref:
        if _git("cat-file", "-e", f"{ref}^{{commit}}")[0] != 0:
            return (
                None,
                "",
                [
                    f"base ref {ref!r} is not reachable, so the baseline cannot be compared "
                    "against it (shallow clone? the job needs GIT_DEPTH: 0)"
                ],
            )
    else:
        default = os.environ.get("CI_DEFAULT_BRANCH", "main")
        if os.environ.get("CI_COMMIT_BRANCH") == default:
            return None, "on the default branch: baseline-raise check skipped", []
        rc, mb = _git("merge-base", "HEAD", "origin/main")
        if rc == 0 and mb.strip() and mb.strip() == head.strip():
            return (
                None,
                "HEAD is the merge base (on main): baseline-raise check skipped",
                [],
            )
        if rc != 0 or not mb.strip():
            if os.environ.get("CI"):
                return (
                    None,
                    "",
                    [
                        "no merge base with origin/main in CI, so the baseline cannot be ratcheted"
                    ],
                )
            return (
                None,
                "no origin/main (local clone): baseline-raise check skipped",
                [],
            )
        ref = mb.strip()
    rc, listing = _git("ls-tree", ref, "--", path)
    if rc != 0:
        return (
            None,
            "",
            [f"git ls-tree {ref} -- {path} failed; cannot read the base baseline"],
        )
    if not listing.strip():
        return (
            None,
            "baseline absent at the base (this change introduces it): no ratchet yet",
            [],
        )
    rc, text = _git("show", f"{ref}:{path}")
    if rc != 0:
        return (
            None,
            "",
            [f"git show {ref}:{path} failed; cannot read the base baseline"],
        )
    return text, "", []


def evaluate_project_axis(
    counts: dict[str, int], baseline: dict[str, int]
) -> list[str]:
    """Ratchet verdicts: one message per module whose count disagrees with its baseline.

    A count that fell fails too, so the fix is locked in
    with ``--update-baseline`` and the freed slot cannot be reused by a new violation.
    """
    problems: list[str] = []
    for rel in sorted(set(counts) | set(baseline)):
        have, allowed = counts.get(rel, 0), baseline.get(rel, 0)
        if have > allowed:
            problems.append(
                f"{rel}: {have} ProjectMembership reads without project__is_deleted "
                f"(baseline {allowed})"
            )
        elif have < allowed:
            problems.append(
                f"{rel}: baseline {allowed} but only {have} remain; run --update-baseline "
                "to lock the fix in"
            )
    return problems


_PACKAGE_ANCHOR = "trueppm_api"


def _allowlist_key(path: Path) -> str:
    """The ALLOWLIST key for a path, anchored on the package root, not on the cwd."""
    parts = path.as_posix().split("/")
    if _PACKAGE_ANCHOR in parts:
        return "/".join(parts[parts.index(_PACKAGE_ANCHOR) :])
    return path.as_posix()


def discover(root: Path) -> list[tuple[Path, str]]:
    """Tracked ``.py`` files under ``root``, excluding migrations.

    ``git ls-files``, never a bare walk: a gate that walks the tree reds on a gitignored
    file (a stray scratch script, a vendored copy), and the red then names a path the
    author cannot see in ``git status``.

    Returns ``(path, rel)`` where ``rel`` is relative to ``root`` — that is the key
    ALLOWLIST is written in, so it stays stable regardless of how ``root`` was spelled
    on the command line.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "-z", "--", str(root)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    root_abs = root.resolve()
    files: list[tuple[Path, str]] = []
    for entry in out.split("\0"):
        if not entry.endswith(".py") or "/migrations/" in entry:
            continue
        p = Path(entry)
        if not p.is_file():
            continue
        try:
            rel = p.resolve().relative_to(root_abs).as_posix()
        except ValueError:
            continue
        files.append((p, rel))
    return files


def project_axis_counts(
    pairs: list[tuple[Path, str]], totals: dict[str, int] | None = None
) -> dict[str, int]:
    """Unfloored project-axis read count per module (modules with none are omitted).

    ``totals``, if given, accumulates ``floored`` and ``opted_out`` across every module.
    """
    counts: dict[str, int] = {}
    for path, rel in pairs:
        hits, opted_out, floored = scan_project_axis_detail(path)
        if totals is not None:
            totals["floored"] = totals.get("floored", 0) + floored
            totals["opted_out"] = totals.get("opted_out", 0) + opted_out
        if hits:
            counts[rel] = len(hits)
    return counts


def update_baseline(pairs: list[tuple[Path, str]], path: Path) -> int:
    """Rewrite the baseline to the current counts; refuse to raise or add anything.

    "Raise" is measured against the committed file AND the merge-base copy, so deleting or
    emptying the file does not open a way around it: a missing or empty baseline refuses,
    because every count would then be a raise.
    """
    counts = {rel: n for rel, n in project_axis_counts(pairs).items()}
    old_text = path.read_text(encoding="utf-8") if path.is_file() else ""
    base_text, _, base_errors = base_baseline_text(BASELINE_PATH)
    if base_errors:
        for err in base_errors:
            print(
                f"check-membership-live-floor: FAIL (project axis)  {err}",
                file=sys.stderr,
            )
        return 1
    ceilings = [parse_baseline(old_text)]
    if base_text is not None:
        ceilings.append(parse_baseline(base_text))
    raised = sorted(
        {
            rel
            for ceiling in ceilings
            for rel, n in counts.items()
            if n > ceiling.get(rel, 0)
        }
    )
    if raised:
        print(
            "check-membership-live-floor: refusing to raise the project-axis baseline for: "
            + ", ".join(raised)
            + ". Floor the read, or add a reasoned `# raise-ok:` line above the entry by hand.",
            file=sys.stderr,
        )
        return 1
    keep = raise_marks(old_text)
    out_lines = [
        "# Project-axis floor ratchet (#4599): ProjectMembership reads in a module that omit",
        "# `project__is_deleted`, counted per module. The gate compares this file with its",
        "# merge-base copy: a higher count or a new module fails unless a reasoned",
        "# `# raise-ok: <reason>` sits on the line directly above the entry (honored only while",
        "# new relative to the base). `--update-baseline` refuses to raise a count and, with the",
        "# file missing or empty, refuses outright. Where the file does not yet exist at the merge",
        "# base there is no ratchet to compare against.",
        "# A baselined read is NOT audited safe; most sit behind a permission class or an",
        "# already-floored project fetch that the AST cannot see. Per-site exemptions live in",
        "# the source as `# project-axis-ok: <reason>`, not here. Format: <module> <count>",
        "",
    ]
    for rel, n in sorted(counts.items()):
        if rel in keep:
            out_lines.append(f"{RAISE_OK} {keep[rel]}")
        out_lines.append(f"{rel} {n}")
    path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    print(
        f"check-membership-live-floor: baseline written ({sum(counts.values())} reads)."
    )
    return 0


def run(pairs: list[tuple[Path, str]], partial: bool = False) -> int:
    violations: list[str] = []
    allowed = 0
    for path, rel in pairs:
        hits = scan_file(path)
        if not hits:
            continue
        if rel in ALLOWLIST:
            allowed += len(hits)
            continue
        for lineno, model, src in hits:
            violations.append(
                f"check-membership-live-floor: FAIL  {path}:{lineno}  {src}"
            )

    totals: dict[str, int] = {}
    counts = project_axis_counts(pairs, totals)
    baseline = read_baseline(Path(BASELINE_PATH))
    if partial:
        scanned = {rel for _, rel in pairs}
        baseline = {r: n for r, n in baseline.items() if r in scanned}
    project_problems = evaluate_project_axis(counts, baseline)
    # The ratchet proper: the file against its merge-base copy, so a hand edit that raises
    # a count cannot launder a new violation by raising the number to match.
    base_text, base_note, base_errors = base_baseline_text(BASELINE_PATH)
    project_problems += base_errors
    if base_note:
        print(f"check-membership-live-floor: note: {base_note}")
    if base_text is not None and Path(BASELINE_PATH).is_file():
        project_problems += baseline_raised(
            Path(BASELINE_PATH).read_text(encoding="utf-8"), base_text
        )
    for line in violations:
        print(line)
    for msg in project_problems:
        print(f"check-membership-live-floor: FAIL (project axis)  {msg}")
    print(
        f"check-membership-live-floor: {len(pairs)} files scanned, "
        f"{allowed} allowlisted unfloored reads, {len(violations)} violations; "
        f"project axis: {totals.get('floored', 0)} floored, "
        f"{totals.get('opted_out', 0)} opted out, "
        f"{sum(counts.values())} "
        f"unfloored/baselined, {len(project_problems)} ratchet failures."
    )
    if base_errors and not violations:
        print(
            "\nThe ratchet base could not be resolved, so the run fails closed. Fetch full\n"
            "history (`GIT_DEPTH: 0` in CI) or rebase onto the default branch, then re-run."
        )
        return 1
    if project_problems and not violations:
        print(
            "\nA ProjectMembership read that omits `project__is_deleted` still answers for a\n"
            "TRASHED project, so notifications, digests and @-group expansion fan out to its\n"
            "members (#4577, #4599). Add `project__is_deleted=False` to the read, or, if the\n"
            "read must see a trashed project, mark that site `# project-axis-ok: <reason>`.\n"
            "If the count FELL, run `scripts/check-membership-live-floor.py --update-baseline`."
        )
        return 1
    if violations:
        print(
            "\nA membership read that omits `is_deleted` resolves a REVOKED member as live:\n"
            "revoking soft-deletes the row and the (scope, user) uniqueness constraint is\n"
            "unconditional, so the tombstone still answers the lookup with its old role.\n"
            "Fixed five times as five separate issues (#3386 #3410 #3411 #3456 #3457).\n"
            "\nFix by either:\n"
            "  * reading through ProjectMembership.live() / ProgramMembership.live(), or an\n"
            "    inline is_deleted=False if the call site needs to compose differently; or\n"
            "  * adding the module to ALLOWLIST in this script with the reason a floor would\n"
            "    be WRONG there — not merely inconvenient. Five modules qualify today.\n"
            "\nWrites, `select_for_update` lock acquisitions and migrations are already exempt\n"
            "by rule; you should not need an allowlist entry for one."
        )
        return 1
    return 0


def self_test() -> int:
    """Prove the gate still catches an unfloored read, and still passes the legitimate
    shapes — in the job that runs it (#3195). Every case drives the REAL `run`, so there
    is no second copy of the detection logic to drift.

    Both bounds are pinned, per scripts/check-gate-selftest-parity.sh: a must-match case
    (the defect is caught) and must-not-match cases (each correct-by-design shape is
    not). A one-sided self-test is how a gate silently stops working.
    """
    rc = 0
    cases: list[tuple[str, bool, str, str]] = [
        # (name, expect_violation, relative path, source)
        (
            "unfloored program read (the #3456 digest shape)",
            True,
            "trueppm_api/apps/notifications/digests.py",
            "ProgramMembership.objects.filter(user=user).values_list('program_id', flat=True)\n",
        ),
        (
            "unfloored project read (the #3411 shape)",
            True,
            "trueppm_api/apps/teams/services.py",
            "ProjectMembership.objects.filter(project_id=p, user_id=u).exists()\n",
        ),
        (
            # THE BLIND SPOT THAT DEFEATED THE #3411 LINE SWEEP. `is_deleted` is a
            # column: naming it in a projection is not filtering on it. A substring
            # probe passes this; the gate must not.
            "is_deleted inside .only() is a projection, not a floor",
            True,
            "trueppm_api/apps/projects/views.py",
            "ProjectMembership.objects.filter(pk=pk).only('role', 'is_deleted').first()\n",
        ),
        (
            "a multi-line chain (invisible to a per-line regex)",
            True,
            "trueppm_api/apps/projects/serializers.py",
            "ProgramMembership.objects.filter(\n    program=program,\n    user=user,\n).exists()\n",
        ),
        (
            "floored inline with is_deleted=False",
            False,
            "trueppm_api/apps/notifications/digests.py",
            "ProgramMembership.objects.filter(user=user, is_deleted=False)\n",
        ),
        (
            "floored through the shared live() helper",
            False,
            "trueppm_api/apps/teams/services.py",
            "ProjectMembership.live().filter(project_id=p, user_id=u).exists()\n",
        ),
        (
            "floored through a Q() object",
            False,
            "trueppm_api/apps/projects/views.py",
            "ProjectMembership.objects.filter(Q(is_deleted=False) & Q(user=u))\n",
        ),
        (
            "a write is not a read (the #3457 importer tombstone reset)",
            False,
            "trueppm_api/apps/projects/seed/importer.py",
            "ProgramMembership.objects.update_or_create(program=p, user=u,"
            " defaults={'is_deleted': False})\n",
        ),
        (
            "a select_for_update lock acquisition must cover the revoked row",
            False,
            "trueppm_api/apps/workspace/services.py",
            "ProjectMembership.objects.select_for_update().filter(user_id__in=ids).order_by('pk')\n",
        ),
        (
            "an allowlisted module's unfloored read is accepted",
            False,
            "trueppm_api/apps/sync/views.py",
            "ProgramMembership.objects.filter(program_id__in=ids, sync_seq__gt=since)\n",
        ),
        (
            # The allowlist is keyed on the module, so the SAME source in a
            # non-allowlisted module must still fail. Without this, an allowlist typo
            # that matched everything would pass the suite above.
            "the same source outside the allowlist still fails",
            True,
            "trueppm_api/apps/projects/program_views.py",
            "ProgramMembership.objects.filter(program_id__in=ids, sync_seq__gt=since)\n",
        ),
        (
            "an unrelated model is not this gate's business",
            False,
            "trueppm_api/apps/teams/views.py",
            "TeamMembership.objects.filter(team_id=t)\n",
        ),
    ]

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for name, expect_violation, rel, source in cases:
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source, encoding="utf-8")
            # Drive the real scanner exactly as `run` does, silencing its report.
            hits = scan_file(target)
            caught = bool(hits) and rel not in ALLOWLIST
            target.unlink()
            if caught == expect_violation:
                verb = "rejected" if expect_violation else "accepted"
                print(f"SELF-TEST OK: {name} correctly {verb}.")
            else:
                verb = "was not rejected" if expect_violation else "was rejected"
                print(f"SELF-TEST FAILED: {name} {verb}.", file=sys.stderr)
                rc = 1

        # Project-axis rule (#4599): scanner cases, then the ratchet verdicts.
        project_cases: list[tuple[str, bool, str]] = [
            (
                "project-axis: unfloored read",
                True,
                "ProjectMembership.objects.filter(project_id=p, is_deleted=False)\n",
            ),
            (
                "project-axis: live() alone does not floor the project",
                True,
                "ProjectMembership.live().filter(project_id=p)\n",
            ),
            (
                "project-axis: floored with project__is_deleted",
                False,
                "ProjectMembership.objects.filter(project_id=p, is_deleted=False,"
                " project__is_deleted=False)\n",
            ),
            (
                "project-axis: floored through a Q()",
                False,
                "ProjectMembership.live().filter(Q(project__is_deleted=False), project_id=p)\n",
            ),
            (
                "project-axis: a write is not a read",
                False,
                "ProjectMembership.objects.update_or_create(project=p, user=u)\n",
            ),
            (
                "project-axis: opt-out with a reason on the line above passes",
                False,
                "# project-axis-ok: the Trash list must see trashed projects\n"
                "ProjectMembership.objects.filter(project_id=p)\n",
            ),
            (
                "project-axis: opt-out with a reason on the same line passes",
                False,
                "ProjectMembership.objects.filter(project_id=p)  # project-axis-ok: trash list\n",
            ),
            (
                "project-axis: opt-out WITHOUT a reason still fails",
                True,
                "# project-axis-ok:\nProjectMembership.objects.filter(project_id=p)\n",
            ),
            (
                # Gap 3: the marker must be a real comment, not text inside a string.
                "project-axis: a marker inside a string literal is not an opt-out",
                True,
                's = "# project-axis-ok: x"\n'
                "ProjectMembership.objects.filter(project_id=p)\n",
            ),
            (
                # Gap 3: one marker covers one read; read A's same-line marker must not
                # reach read B on the next line.
                "project-axis: a same-line marker does not cover the next line's read",
                True,
                "ProjectMembership.objects.filter(project_id=p)  # project-axis-ok: a\n"
                "ProjectMembership.objects.filter(project_id=q)\n",
            ),
            (
                "project-axis: one comment-only marker covers one read, not two",
                True,
                "# project-axis-ok: a\n"
                "x = [ProjectMembership.objects.filter(project_id=p),"
                " ProjectMembership.objects.filter(project_id=q)]\n",
            ),
            (
                # Gap 4: a floor on ANOTHER model's project is not this membership's floor.
                "project-axis: user__project__is_deleted does not floor the membership",
                True,
                "ProjectMembership.objects.filter(user__project__is_deleted=False)\n",
            ),
            (
                "project-axis: team__project__is_deleted does not floor the membership",
                True,
                "ProjectMembership.live().filter(Q(team__project__is_deleted=False))\n",
            ),
            (
                "project-axis: project__is_deleted__in floors the membership's project",
                False,
                "ProjectMembership.live().filter(project__is_deleted__in=[False])\n",
            ),
            (
                "project-axis: a stale marker above a floored read is reported",
                True,
                "# project-axis-ok: stale\n"
                "ProjectMembership.live().filter(project__is_deleted=False)\n",
            ),
            (
                "project-axis: an opt-out two lines away does not apply",
                True,
                "# project-axis-ok: stale\nx = 1\nProjectMembership.objects.filter(project_id=p)\n",
            ),
        ]
        for name, expect_violation, source in project_cases:
            target = root / "trueppm_api/apps/x/project_axis.py"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(source, encoding="utf-8")
            caught = bool(scan_project_axis(target))
            target.unlink()
            if caught == expect_violation:
                print(f"SELF-TEST OK: {name}.")
            else:
                print(f"SELF-TEST FAILED: {name}.", file=sys.stderr)
                rc = 1

        # Gap 2: no module is exempt wholesale. A second, unmarked unfloored read in a
        # module that used to be allowlisted must fail the run, with the baseline absent.
        for rel in (
            "trueppm_api/apps/sync/views.py",
            "trueppm_api/apps/webhooks/dispatch.py",
            "trueppm_api/apps/access/signals.py",
            "trueppm_api/apps/access/minter_role.py",
        ):
            target = root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                "# project-axis-ok: the one reviewed read\n"
                "ProjectMembership.objects.filter(project_id=p, is_deleted=False)\n"
                "ProjectMembership.objects.filter(project_id=q, is_deleted=False)\n",
                encoding="utf-8",
            )
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc_run = run([(target, rel)], partial=True)
            target.unlink()
            # Assert the read text, so a base-resolution error cannot pass this vacuously.
            if (
                rc_run == 1
                and "ProjectMembership reads without project__is_deleted"
                in out.getvalue()
            ):
                print(f"SELF-TEST OK: an unmarked read in {rel} fails.")
            else:
                print(
                    f"SELF-TEST FAILED: an unmarked read in {rel} passed.",
                    file=sys.stderr,
                )
                rc = 1

        # Gap 1: a base SHA that cannot be resolved must fail closed, not skip.
        clean = root / "trueppm_api/apps/x/clean.py"
        clean.parent.mkdir(parents=True, exist_ok=True)
        clean.write_text(
            "ProjectMembership.objects.filter(project__is_deleted=False)\n",
            encoding="utf-8",
        )
        saved_sha = os.environ.get("CI_MERGE_REQUEST_DIFF_BASE_SHA")
        os.environ["CI_MERGE_REQUEST_DIFF_BASE_SHA"] = "0" * 40
        try:
            err = io.StringIO()
            base_out = io.StringIO()
            with (
                contextlib.redirect_stdout(base_out),
                contextlib.redirect_stderr(err),
            ):
                rc_run = run([(clean, "trueppm_api/apps/x/clean.py")], partial=True)
        finally:
            if saved_sha is None:
                del os.environ["CI_MERGE_REQUEST_DIFF_BASE_SHA"]
            else:
                os.environ["CI_MERGE_REQUEST_DIFF_BASE_SHA"] = saved_sha
        clean.unlink()
        if rc_run != 0 and (
            "ratchet base could not be resolved" in base_out.getvalue()
            and "mark that site" not in base_out.getvalue()
        ):
            print(
                "SELF-TEST OK: an unreachable CI base SHA fails closed with the base hint."
            )
        else:
            print(
                "SELF-TEST FAILED: an unreachable CI base SHA was skipped.",
                file=sys.stderr,
            )
            rc = 1

        ratchet_cases: list[tuple[str, bool, dict[str, int], dict[str, int]]] = [
            ("ratchet: a module outside the baseline fails", True, {"a.py": 1}, {}),
            ("ratchet: a raised count fails", True, {"a.py": 3}, {"a.py": 2}),
            ("ratchet: a stale (fallen) count fails", True, {"a.py": 1}, {"a.py": 2}),
            ("ratchet: an equal count passes", False, {"a.py": 2}, {"a.py": 2}),
        ]
        for name, expect_violation, counts, baseline in ratchet_cases:
            caught = bool(evaluate_project_axis(counts, baseline))
            if caught == expect_violation:
                print(f"SELF-TEST OK: {name}.")
            else:
                print(f"SELF-TEST FAILED: {name}.", file=sys.stderr)
                rc = 1

        raise_cases: list[tuple[str, bool, str, str | None]] = [
            (
                "raise: a higher count versus the base fails",
                True,
                "a.py 2\n",
                "a.py 1\n",
            ),
            (
                "raise: a new module versus the base fails",
                True,
                "a.py 1\nb.py 1\n",
                "a.py 1\n",
            ),
            ("raise: a lower count passes", False, "a.py 1\n", "a.py 2\n"),
            ("raise: an equal count passes", False, "a.py 2\n", "a.py 2\n"),
            ("raise: no base copy means no ratchet", False, "a.py 9\n", None),
            (
                "raise: a new reasoned raise-ok is honored",
                False,
                "# raise-ok: audited\na.py 2\n",
                "a.py 1\n",
            ),
            (
                "raise: a reasonless raise-ok is not",
                True,
                "# raise-ok:\na.py 2\n",
                "a.py 1\n",
            ),
            (
                "raise: a raise-ok already at the base is spent",
                True,
                "# raise-ok: audited\na.py 3\n",
                "# raise-ok: audited\na.py 2\n",
            ),
        ]
        for name, expect_violation, now_text, base_text in raise_cases:
            caught = bool(baseline_raised(now_text, base_text))
            if caught == expect_violation:
                print(f"SELF-TEST OK: {name}.")
            else:
                print(f"SELF-TEST FAILED: {name}.", file=sys.stderr)
                rc = 1

        # Discovery must exit 2 — never 0 — when it finds nothing. A mis-scoped gate
        # that reads as green is the #3172 failure mode this repo already paid for.
        empty = root / "nothing-here"
        empty.mkdir()
        if discover(empty):
            print(
                "SELF-TEST FAILED: discovery returned files for an untracked dir.",
                file=sys.stderr,
            )
            rc = 1
        else:
            print(
                "SELF-TEST OK: discovery yields nothing for an untracked tree (caller exits 2)."
            )

    if rc == 0:
        print("SELF-TEST: all cases passed.")
    return rc


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--self-test":
        return self_test()

    if argv and argv[0] == "--files":
        # Derive the same ALLOWLIST key `discover` produces, by anchoring on the package
        # root rather than on however the caller spelled the path. Without this, an
        # explicit `--files packages/api/src/trueppm_api/apps/sync/views.py` would report
        # a violation the full scan does not — a gate disagreeing with itself.
        pairs = [(Path(a), _allowlist_key(Path(a))) for a in argv[1:]]
        if not pairs:
            print(
                "check-membership-live-floor: --files requires at least one path",
                file=sys.stderr,
            )
            return 2
        return run(pairs, partial=True)

    repo_root = Path(__file__).resolve().parent.parent
    # Run from the repo root so `git ls-files` paths resolve and the reported paths are
    # repo-relative regardless of where the gate was invoked from (a worktree, a hook).
    os.chdir(repo_root)
    update = bool(argv) and argv[0] == "--update-baseline"
    root = Path(argv[0]) if argv and not update else repo_root / DEFAULT_ROOT
    pairs = discover(root)
    if not pairs:
        print(
            f"check-membership-live-floor: no tracked .py files under {root} — "
            "the scope is wrong, or this is not a git checkout. Refusing to report clean.",
            file=sys.stderr,
        )
        return 2
    if update:
        return update_baseline(pairs, Path(BASELINE_PATH))
    return run(pairs)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
