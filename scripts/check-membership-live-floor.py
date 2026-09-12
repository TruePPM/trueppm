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
  check-membership-live-floor.py --self-test

Exit codes:
  0  every membership read is floored, or exempt, or allowlisted
  1  at least one unfloored read
  2  invocation error (including: discovery found no files)
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
import tempfile
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
    "trueppm_api/apps/sync/views.py": (
        "the sync delta ships TOMBSTONES by protocol so an offline client can learn the "
        "membership went away; a floored stream would leave the row on the device forever"
    ),
}


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

    findings: list[tuple[int, str, str]] = []
    seen: set[int] = set()
    for node in ast.walk(tree):
        model = _is_membership_root(node)
        if model is None:
            continue
        top = _outermost(parents, node)
        if id(top) in seen:
            continue
        seen.add(id(top))

        steps = _chain(top)
        methods = {name for name, _ in steps}
        if methods & WRITE_METHODS:
            continue  # a write, not a read
        if "select_for_update" in methods:
            continue  # a lock acquisition, must cover the revoked row
        if "live" in methods:
            continue  # floored by the shared helper
        if any(
            call is not None and name in FILTERING_METHODS and _mentions_floor(call)
            for name, call in steps
        ):
            continue  # floored inline

        src = " ".join(ast.unparse(top).split())
        if len(src) > 120:
            src = src[:117] + "..."
        findings.append((getattr(node, "lineno", 0), model, src))
    return findings


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


def run(pairs: list[tuple[Path, str]]) -> int:
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

    for line in violations:
        print(line)
    print(
        f"check-membership-live-floor: {len(pairs)} files scanned, "
        f"{allowed} allowlisted unfloored reads, {len(violations)} violations."
    )
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
            "    be WRONG there — not merely inconvenient. Four modules qualify today.\n"
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
        return run(pairs)

    repo_root = Path(__file__).resolve().parent.parent
    # Run from the repo root so `git ls-files` paths resolve and the reported paths are
    # repo-relative regardless of where the gate was invoked from (a worktree, a hook).
    os.chdir(repo_root)
    root = Path(argv[0]) if argv else repo_root / DEFAULT_ROOT
    pairs = discover(root)
    if not pairs:
        print(
            f"check-membership-live-floor: no tracked .py files under {root} — "
            "the scope is wrong, or this is not a git checkout. Refusing to report clean.",
            file=sys.stderr,
        )
        return 2
    return run(pairs)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
