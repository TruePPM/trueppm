"""Prove the built api image's installed dependency set matches packages/api/uv.lock.

Run from INSIDE the built image, against its own venv python:

    docker run --rm -i <api-image> /venv/bin/python - < scripts/check-api-image-lock.py

The Dockerfile bakes /app/requirements-locked.txt (a --no-hashes `uv export`
of packages/api/uv.lock, minus trueppm-api/trueppm-scheduler — see the
Dockerfile's own comments) into the image at build time. This script reads
that manifest and diffs it against what `importlib.metadata` actually finds
installed in the image's venv.

This closes the second half of #4078: the Dockerfile fix makes the image
install from the lock by construction, but nothing previously stopped a
*future* edit (a stray unpinned `pip install`, a dropped --no-deps, a
forgotten re-export) from silently reopening the gap. This script is that
regression gate, run by the `api:image-lock-check` CI job on every MR that
touches the Dockerfile, packages/api/{pyproject.toml,uv.lock}, or
packages/scheduler/pyproject.toml.

`trueppm-scheduler` and `trueppm-api` are expected to be present but are
excluded from the version comparison: both are built from this checkout's
local source (COPY + `pip install --no-deps`), not resolved from the lock,
so their installed version is whatever this commit's own pyproject.toml
declares — never a registry pin to compare against.

Usage (inside the built image):  python - [--self-test] < check-api-image-lock.py
"""

from __future__ import annotations

import importlib.metadata as metadata
import sys
from dataclasses import dataclass, field
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

LOCKED_REQUIREMENTS_PATH = Path("/app/requirements-locked.txt")
LOCAL_ONLY_PACKAGES = frozenset({"trueppm-scheduler", "trueppm-api"})


def parse_locked_requirements(text: str) -> dict[str, str]:
    """Return {canonical_name: pinned_version} for every applicable requirement.

    A line whose marker does not evaluate true under THIS interpreter (e.g.
    `async-timeout==5.0.1 ; python_full_version < '3.11.3'` on a 3.11.4+
    build) is skipped — it was never installed, so it must not be compared.
    """
    locked: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        req = Requirement(line)
        if req.marker is not None and not req.marker.evaluate():
            continue
        specifier = next(iter(req.specifier), None)
        if specifier is None:
            raise ValueError(f"unpinned requirement in locked export: {raw_line!r}")
        locked[canonicalize_name(req.name)] = specifier.version
    return locked


def installed_packages() -> dict[str, str]:
    installed: dict[str, str] = {}
    for dist in metadata.distributions():
        name = dist.metadata.get("Name")
        if not name:
            continue
        installed[canonicalize_name(name)] = dist.version
    return installed


@dataclass
class Diagnosis:
    missing: dict[str, str] = field(default_factory=dict)
    unlocked: dict[str, str] = field(default_factory=dict)
    mismatched: dict[str, tuple[str, str]] = field(default_factory=dict)
    absent_local: set[str] = field(default_factory=set)

    @property
    def ok(self) -> bool:
        return not (
            self.missing or self.unlocked or self.mismatched or self.absent_local
        )


def diagnose(
    locked: dict[str, str],
    installed: dict[str, str],
    local_only: frozenset[str] = LOCAL_ONLY_PACKAGES,
) -> Diagnosis:
    """Compare a lock-derived requirement set against an installed package set.

    Pure function (no filesystem/venv access) so it can be exercised directly
    by --self-test without a Docker build.
    """
    diagnosis = Diagnosis(
        missing={
            name: locked[name] for name in sorted(locked.keys() - installed.keys())
        },
        unlocked={
            name: installed[name]
            for name in sorted(installed.keys() - locked.keys() - local_only)
        },
        mismatched={
            name: (locked[name], installed[name])
            for name in sorted((locked.keys() & installed.keys()) - local_only)
            if locked[name] != installed[name]
        },
        absent_local={name for name in local_only if name not in installed},
    )
    return diagnosis


def report(diagnosis: Diagnosis, locked_count: int, local_only: frozenset[str]) -> None:
    if diagnosis.missing:
        print("MISSING — declared in packages/api/uv.lock, not installed in the image:")
        for name, version in diagnosis.missing.items():
            print(f"  {name}=={version}")
    if diagnosis.unlocked:
        print(
            "UNLOCKED — installed in the image, not in packages/api/uv.lock, "
            "and not a locally-built package:"
        )
        for name, version in diagnosis.unlocked.items():
            print(f"  {name}=={version}")
    if diagnosis.mismatched:
        print("VERSION MISMATCH — installed version differs from the lock:")
        for name, (locked_version, installed_version) in diagnosis.mismatched.items():
            print(f"  {name}: locked={locked_version} installed={installed_version}")
    for name in sorted(diagnosis.absent_local):
        print(f"FAIL: expected locally-built package {name!r} is not installed")

    if diagnosis.ok:
        print(
            f"OK: {locked_count} locked packages match the image exactly "
            f"({len(local_only)} locally-built packages excluded from comparison)."
        )


def main() -> int:
    if not LOCKED_REQUIREMENTS_PATH.exists():
        print(
            f"FAIL: {LOCKED_REQUIREMENTS_PATH} not found in this image", file=sys.stderr
        )
        return 1

    locked = parse_locked_requirements(LOCKED_REQUIREMENTS_PATH.read_text())
    installed = installed_packages()
    diagnosis = diagnose(locked, installed)
    report(diagnosis, len(locked), LOCAL_ONLY_PACKAGES)
    return 0 if diagnosis.ok else 1


def self_test() -> int:
    """Plant each violation class in a fixture and assert diagnose() catches it.

    No Docker, no filesystem — pure in-memory fixtures, so this runs in
    seconds inside the SAME job that runs the real check (#3194: a gate
    proves it can fail in the environment it actually runs in, not in a
    separate test suite that may run somewhere else).
    """
    failures: list[str] = []

    def check(label: str, condition: bool) -> None:
        if condition:
            print(f"SELF-TEST OK: {label}")
        else:
            failures.append(label)
            print(f"SELF-TEST FAIL: {label}")

    clean_locked = {"django": "5.2.17", "requests": "2.34.2"}
    clean_installed = {
        **clean_locked,
        "trueppm-api": "0.4.0b4",
        "trueppm-scheduler": "0.4.0b4",
    }
    check(
        "a clean image (locked == installed + local-only) passes",
        diagnose(clean_locked, clean_installed).ok,
    )

    missing_installed = {k: v for k, v in clean_installed.items() if k != "requests"}
    d = diagnose(clean_locked, missing_installed)
    check(
        "a locked package absent from the image is caught as MISSING",
        not d.ok and "requests" in d.missing,
    )

    unlocked_installed = {**clean_installed, "some-stray-package": "1.0.0"}
    d = diagnose(clean_locked, unlocked_installed)
    check(
        "an installed package absent from the lock is caught as UNLOCKED",
        not d.ok and "some-stray-package" in d.unlocked,
    )

    mismatched_installed = {**clean_installed, "django": "5.2.99"}
    d = diagnose(clean_locked, mismatched_installed)
    check(
        "an installed version that differs from the lock is caught as a MISMATCH",
        not d.ok and d.mismatched.get("django") == ("5.2.17", "5.2.99"),
    )

    missing_local = {
        k: v for k, v in clean_installed.items() if k != "trueppm-scheduler"
    }
    d = diagnose(clean_locked, missing_local)
    check(
        "a missing locally-built package (trueppm-scheduler) is caught even though it's excluded from version comparison",
        not d.ok and "trueppm-scheduler" in d.absent_local,
    )

    # A local-only package's OWN version is never compared, even when it
    # disagrees with something that merely shares its name in `locked` (it
    # never does in practice — trueppm-scheduler is excluded from the export
    # — but the exclusion must hold structurally, not by the export happening
    # to omit it).
    locked_with_local_name = {**clean_locked, "trueppm-scheduler": "0.1.0"}
    installed_with_different_local_version = {
        **clean_installed,
        "trueppm-scheduler": "0.4.0b4",
    }
    d = diagnose(
        locked_with_local_name,
        installed_with_different_local_version,
        local_only=LOCAL_ONLY_PACKAGES,
    )
    check(
        "a locally-built package's version is never compared against a same-named lock entry",
        "trueppm-scheduler" not in d.mismatched,
    )

    # An inapplicable environment marker (e.g. a python_full_version bound
    # that this interpreter fails) must not be treated as a pinned version.
    text = "django==5.2.17\nasync-timeout==5.0.1 ; python_full_version < '3.5'\n"
    parsed = parse_locked_requirements(text)
    check(
        "a requirement whose marker evaluates false under this interpreter is skipped",
        "async-timeout" not in parsed and parsed.get("django") == "5.2.17",
    )

    if failures:
        print(f"SELF-TEST: {len(failures)} case(s) failed.")
        return 1
    print("SELF-TEST: all cases passed.")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(self_test())
    raise SystemExit(main())
