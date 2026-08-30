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
    python scripts/check-migration-numbering.py --self-test
    # prove the detection still works, then exit
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
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


def _scan_migration_dir(
    mig_dir: Path, base: str
) -> tuple[list[tuple[str, str, str, list[str]]], int]:
    """Find cross-branch numbering collisions in one app's migrations directory.

    Returns the collisions found (``(app, num, name, clashes)`` tuples) and the
    next free migration number for the app (used to suggest a renumber).
    """
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
    next_free = (max(all_nums) + 1) if all_nums else 1

    collisions: list[tuple[str, str, str, list[str]]] = []
    for name in sorted(tree_files):
        num = _number(name)
        if num is None or name in base_files:
            continue  # unchanged file, or not a numbered migration
        if _is_replacement(mig_dir / name):
            continue  # squash migration — reusing a replaced number is correct
        clashes = base_by_num.get(num, set()) - {name}
        if clashes:
            collisions.append((app, num, name, sorted(clashes)))
    return collisions, next_free


def _report_collisions(
    base: str,
    collisions: list[tuple[str, str, str, list[str]]],
    next_free: dict[str, int],
) -> None:
    """Print the human-readable collision report and remediation hint."""
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


# ---------------------------------------------------------------------------
# Self-test (#3195)
#
# A gate that cannot fail is indistinguishable from a gate that works. This one's
# detection was verified once, by hand, during the #3194 audit — a snapshot, not a
# guarantee. `--self-test` repeats that check in the gate's own CI job, on the same
# image, every run.
#
# Every case runs the REAL script end to end via subprocess — same argv parsing,
# same `git ls-tree` base read, same filesystem scan — against a throwaway fixture
# repo. There is no second copy of the numbering rule here to drift from the one
# above; the fixtures only decide what the real code is pointed at.
#
# Both directions are asserted. A clean sequential migration must be ACCEPTED and a
# duplicate number REJECTED: a happy-path-only self-test satisfies the parity gate
# while proving nothing, which is the exact failure this work removes. The two
# documented false-positive exemptions (a squash that re-occupies a replaced number,
# and a duplicate that already exists on the base) are asserted too — a gate noisy
# enough to get disabled loses the protection just as completely.
# ---------------------------------------------------------------------------

_ST_MIG_REL = "packages/api/src/trueppm_api/apps/projects/migrations"


def _st_migration(dep: str, *, replaces: bool = False) -> str:
    """A minimal but structurally real Django migration file body."""
    replaces_line = (
        '    replaces = [("projects", "0001_initial"), ("projects", "0002_add_owner")]\n'
        if replaces
        else ""
    )
    return (
        "from django.db import migrations\n"
        "\n"
        "\n"
        "class Migration(migrations.Migration):\n"
        f'    dependencies = [("projects", "{dep}")]\n'
        f"{replaces_line}"
        "    operations = []\n"
    )


def _st_env() -> dict[str, str]:
    """Environment for the fixture repo: no inherited git state.

    `make pre-push` runs this from a git hook, where GIT_DIR / GIT_WORK_TREE are
    exported and would point the fixture's `git init` at the real repository. The
    global/system config is dropped for the same reason — an operator's
    `commit.gpgsign` or `init.templateDir` must not decide whether the gate proves
    itself.
    """
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    return env


def _st_write(root: Path, name: str, body: str) -> None:
    path = root / _ST_MIG_REL / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)


def _st_base_repo(root: Path, base_files: dict[str, str], env: dict[str, str]) -> str:
    """Create a throwaway repo whose HEAD holds ``base_files``; return its sha.

    The sha is handed to the gate as its base ref, so the self-test depends on no
    remote, no network and no branch name existing.
    """

    def run(*args: str) -> subprocess.CompletedProcess[str]:
        proc = subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True, env=env
        )
        if proc.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
        return proc

    root.mkdir(parents=True)
    run("init", "-q")
    for name, body in base_files.items():
        _st_write(root, name, body)
    run("add", "-A")
    run(
        "-c",
        "user.email=self-test@trueppm.invalid",
        "-c",
        "user.name=migration-numbering self-test",
        "commit",
        "-q",
        "--no-gpg-sign",
        "-m",
        "base",
    )
    return run("rev-parse", "HEAD").stdout.strip()


def _self_test() -> int:
    """Run the real gate against planted fixtures. 0 if every case behaves."""
    # (name, expect_pass, base-commit files, files added in the working tree,
    #  substring the output must contain)
    cases: list[tuple[str, bool, dict[str, str], dict[str, str], str]] = [
        (
            "sequential migration",
            True,
            {
                "0001_initial.py": _st_migration("0001_initial"),
                "0002_add_owner.py": _st_migration("0001_initial"),
            },
            {"0003_add_baseline.py": _st_migration("0002_add_owner")},
            "No migration-numbering collisions",
        ),
        (
            "duplicate migration number",
            False,
            {
                "0001_initial.py": _st_migration("0001_initial"),
                "0002_add_owner.py": _st_migration("0001_initial"),
            },
            {"0002_add_baseline.py": _st_migration("0001_initial")},
            "reuses number 0002",
        ),
        (
            "squash re-occupying a replaced number",
            True,
            {
                "0001_initial.py": _st_migration("0001_initial"),
                "0002_add_owner.py": _st_migration("0001_initial"),
            },
            {
                "0001_squashed_0002_add_owner.py": _st_migration(
                    "0001_initial", replaces=True
                )
            },
            "No migration-numbering collisions",
        ),
        (
            "duplicate already resolved on the base",
            True,
            {
                "0001_initial.py": _st_migration("0001_initial"),
                "0041_a_thing.py": _st_migration("0001_initial"),
                "0041_b_thing.py": _st_migration("0001_initial"),
                "0042_merge_0041_a_0041_b.py": _st_migration("0041_a_thing"),
            },
            {},
            "No migration-numbering collisions",
        ),
    ]

    gate = str(Path(__file__).resolve())
    env = _st_env()
    tmp = Path(tempfile.mkdtemp(prefix="migration-numbering-selftest-"))
    failures = 0
    try:
        for index, (
            name,
            expect_pass,
            base_files,
            tree_files,
            expect_text,
        ) in enumerate(cases):
            root = tmp / f"case{index}"
            base = _st_base_repo(root, base_files, env)
            for fname, body in tree_files.items():
                _st_write(root, fname, body)

            proc = subprocess.run(
                [sys.executable, gate, base],
                cwd=root,
                capture_output=True,
                text=True,
                env=env,
            )
            passed = proc.returncode == 0
            output = proc.stdout + proc.stderr

            if passed != expect_pass:
                verb = "accepted" if passed else "rejected"
                print(f"SELF-TEST FAILED: {name} was {verb} and must not be.")
                print(f"    exit {proc.returncode}; output:\n{output.rstrip()}")
                failures += 1
            elif expect_text not in output:
                # A crash also exits non-zero, so "it failed" is not evidence it
                # detected anything. The report has to name the collision.
                print(
                    f"SELF-TEST FAILED: {name} gave the right exit code for the "
                    f"wrong reason — {expect_text!r} missing from the output."
                )
                print(f"    output:\n{output.rstrip()}")
                failures += 1
            else:
                verb = "accepted" if expect_pass else "correctly rejected"
                print(f"SELF-TEST OK: {name} {verb}.")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if failures:
        print(f"\n✖ migration-numbering self-test: {failures} case(s) failed.")
        return 1
    print(f"\n✓ migration-numbering self-test: all {len(cases)} cases passed.")
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        return _self_test()

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
        dir_collisions, dir_next_free = _scan_migration_dir(mig_dir, base)
        collisions.extend(dir_collisions)
        next_free[mig_dir.parent.name] = dir_next_free

    if not collisions:
        print(f"✓ No migration-numbering collisions with {base}.")
        return 0

    _report_collisions(base, collisions, next_free)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
