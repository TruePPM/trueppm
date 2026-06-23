#!/usr/bin/env python3
"""Catch cross-branch Django migration-numbering collisions before they break main.

Why this exists
---------------
`makemigrations --check` (the existing ``api:migration-check`` gate) only sees the
*current* tree, so it cannot detect the most common multi-agent failure: two
parallel branches each create ``projects/0080_*.py`` off the same base. Each
branch passes its own pipeline. The first merges fine. The second — still on a
stale base — also merges, and now ``main`` has two ``0080`` leaf migrations: a
conflict that has to be hand-resolved with a renumber or a ``--merge`` migration,
with ``main`` red in the meantime.

This guard closes the timing gap. It compares the working tree against a base ref
(default ``origin/main``) and fails if any *new* migration on this branch reuses a
number that the base already assigns to a *different* migration for the same app.
That is exactly the state that becomes a two-leaf conflict at merge — and it is
detectable on the second branch *before* it merges, even without rebasing first.

The fix it prints: renumber the branch's migration above the base's highest
number for that app (and repoint its ``dependencies``), or, if a merge migration
is the intended resolution, run ``makemigrations --merge``.

Note on already-resolved duplicates: ``main`` legitimately contains duplicate
*numbers* that were reconciled by ``_merge_`` migrations (e.g. ``0041_a`` +
``0041_b`` resolved by ``0042_merge_…``). Those files exist on the base, so they
are never flagged — only migrations that are *new on this branch* and collide are
reported. This keeps the false-positive rate at zero on a clean ``main``.

Note on squash migrations: a ``squashmigrations`` output declares ``replaces =
[...]`` and deliberately re-occupies a number it replaces (``0001_squashed_…``
stands in for ``0001_initial``). That is not a two-leaf conflict — Django's
``replaces`` graph requires the squash to keep that number — so files declaring
``replaces`` are skipped (see ``_is_replacement``).

Usage:
    python scripts/check-migration-numbering.py [base-ref]
    # base-ref defaults to origin/main
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

_NUM = re.compile(r"^(\d{4})_.*\.py$")
_API_SRC = Path("packages/api/src")
_MIGRATIONS_GLOB = "trueppm_api/apps/*/migrations"


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], capture_output=True, text=True)


def _base_basenames(base: str, path: Path) -> set[str]:
    """Migration basenames present under ``path`` at ``base`` (empty if absent)."""
    result = _git("ls-tree", "-r", "--name-only", base, "--", str(path))
    if result.returncode != 0:
        return set()
    return {Path(line).name for line in result.stdout.splitlines() if line.strip()}


def _number(name: str) -> str | None:
    match = _NUM.match(name)
    return match.group(1) if match else None


def _is_replacement(path: Path) -> bool:
    """True if the migration declares ``replaces = [...]`` (a squash migration).

    A squash legitimately re-occupies a number it replaces (``0001_squashed_…``
    sits alongside the ``0001_initial`` it stands in for) — it is not a second
    leaf, and Django's ``replaces`` graph requires it to keep that number. Such a
    file must not be reported as a cross-branch numbering collision.
    """
    try:
        return (
            re.search(r"^\s*replaces\s*=", path.read_text(), re.MULTILINE) is not None
        )
    except OSError:
        return False


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/main"

    if _git("rev-parse", "--verify", "--quiet", base).returncode != 0:
        # No base ref locally (e.g. a fresh clone that never fetched main, or an
        # offline pre-push). Skip rather than fail — the CI job fetches the base
        # explicitly, so the gate still runs where it matters.
        print(f"→ migration-numbering: base ref {base!r} not found — skipped.")
        return 0

    if not _API_SRC.exists():
        print(f"→ migration-numbering: {_API_SRC} not found — run from the repo root.")
        return 1

    collisions: list[tuple[str, str, str, list[str]]] = []
    next_free: dict[str, int] = {}

    for mig_dir in sorted(_API_SRC.glob(_MIGRATIONS_GLOB)):
        app = mig_dir.parent.name
        tree_files = {p.name for p in mig_dir.glob("[0-9]*.py")}
        base_files = _base_basenames(base, mig_dir)

        base_by_num: dict[str, set[str]] = defaultdict(set)
        for name in base_files:
            num = _number(name)
            if num:
                base_by_num[num].add(name)

        all_nums = [
            int(num)
            for name in tree_files | base_files
            if (num := _number(name)) is not None
        ]
        next_free[app] = (max(all_nums) + 1) if all_nums else 1

        for name in sorted(tree_files):
            num = _number(name)
            if num is None or name in base_files:
                continue  # unchanged file, or not a numbered migration
            if _is_replacement(mig_dir / name):
                continue  # squash migration — reusing a replaced number is correct
            clashes = base_by_num.get(num, set()) - {name}
            if clashes:
                collisions.append((app, num, name, sorted(clashes)))

    if not collisions:
        print(f"✓ No migration-numbering collisions with {base}.")
        return 0

    print(f"✖ Migration-numbering collision(s) with {base}:\n")
    for app, num, name, clashes in collisions:
        suggested = f"{next_free[app]:04d}"
        print(f"  apps/{app}/migrations/{name}")
        print(
            f"      reuses number {num}, already taken on {base} by: {', '.join(clashes)}"
        )
        print(f"      → renumber to {suggested}_… (and repoint its `dependencies`)")
    print(
        "\nTwo branches numbered a migration the same; the second to merge would leave\n"
        f"{base} with two leaf migrations. Renumber the branch's migration above the\n"
        "base's highest number for that app, or run `makemigrations --merge` if a merge\n"
        "migration is the intended resolution."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
