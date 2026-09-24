#!/usr/bin/env python3
"""Assert a PyPI OIDC-minted upload token is scoped to the package we mean to publish.

PyPI's mint-token exchange succeeds whenever *some* Trusted Publisher matches the
pipeline's OIDC claims, even one registered on a different project. The token it
returns carries a ProjectID caveat (`[2,["<project uuid>"]]`) listing the projects
it may upload to, and the upload is refused with a 403 when the target is not in
that list. So a successful mint proves nothing about the target project (#4045).

The caveat holds project UUIDs, not names, and PyPI has no public name-to-UUID
lookup, so the expected UUIDs are pinned in scripts/pypi-project-ids.json.

The token is read from the PYPI_TOKEN environment variable and is never printed.

Usage: PYPI_TOKEN=... check-pypi-token-project.py <package> [--pins FILE]
       check-pypi-token-project.py --self-test
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from pathlib import Path

_CAVEAT = re.compile(rb"\[2,\[([^\]]*)\]\]")
_UUID = re.compile(rb"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
DEFAULT_PINS = Path(__file__).with_name("pypi-project-ids.json")


def project_ids(token: str) -> list[str]:
    """Return the project UUIDs a pypi- macaroon is scoped to (empty if none found)."""
    body = token.removeprefix("pypi-")
    raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    ids: list[str] = []
    for match in _CAVEAT.finditer(raw):
        ids.extend(u.decode() for u in _UUID.findall(match.group(1)))
    return ids


def check(token: str, package: str, pins: dict[str, str]) -> tuple[bool, str]:
    try:
        ids = project_ids(token)
    except ValueError:
        return False, "could not decode the minted token"
    if not ids:
        return False, "the minted token carries no project scope caveat"
    expected = pins.get(package, "")
    shown = ", ".join(ids)
    if not expected:
        return False, (
            f"no pinned project id for {package} in scripts/pypi-project-ids.json.\n"
            f"The minted token is scoped to: {shown}\n"
            "If that is the project's id on pypi.org, pin it and re-run."
        )
    if expected not in ids:
        return False, (
            f"the minted token is scoped to [{shown}], not {package} ({expected}).\n"
            "A Trusted Publisher matched this pipeline, but not on this project. "
            "Fix the binding on pypi.org (Manage > Publishing) for this project."
        )
    extra = len(ids) - 1
    note = f" (+{extra} other project(s) on the same publisher)" if extra else ""
    return True, f"token is scoped to {package} ({expected}){note}"


def _self_test() -> int:
    def tok(ids: list[str]) -> str:
        caveats = b"loc\x00" + json.dumps([2, ids], separators=(",", ":")).encode()
        return "pypi-" + base64.urlsafe_b64encode(caveats).decode().rstrip("=")

    a = "11111111-1111-4111-8111-111111111111"
    b = "22222222-2222-4222-8222-222222222222"
    cases = [
        (check(tok([a]), "pkg", {"pkg": a})[0], True, "matching project"),
        (check(tok([b]), "pkg", {"pkg": a})[0], False, "other project"),
        (check(tok([b, a]), "pkg", {"pkg": a})[0], True, "shared publisher"),
        (check(tok([a]), "pkg", {})[0], False, "unpinned"),
        (check("pypi-" + "A" * 40, "pkg", {"pkg": a})[0], False, "no caveat"),
        (check("pypi-!!", "pkg", {"pkg": a})[0], False, "undecodable"),
    ]
    bad = [name for got, want, name in cases if got != want]
    if bad:
        print("self-test FAILED: " + ", ".join(bad), file=sys.stderr)
        return 1
    print("self-test OK")
    return 0


def main(argv: list[str]) -> int:
    if argv[1:] == ["--self-test"]:
        return _self_test()
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    pins_path = Path(argv[3]) if len(argv) > 3 and argv[2] == "--pins" else DEFAULT_PINS
    ok, message = check(
        os.environ.get("PYPI_TOKEN", ""), argv[1], json.loads(pins_path.read_text())
    )
    print(
        ("OK: " if ok else "ERROR: ") + message,
        file=sys.stderr if not ok else sys.stdout,
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
