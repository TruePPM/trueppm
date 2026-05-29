#!/usr/bin/env python3
"""Check that a candidate OpenAPI schema does not remove paths or schemas present on main.

Usage:
    python scripts/check-schema-regression.py <candidate.json> <baseline.json>

Exits 0 if no regression; exits 1 and prints removed paths/schemas otherwise.
Intended for use in CI after export-openapi.sh --check passes, to guard
against branches that are behind main silently dropping endpoints.

Intentional removals (e.g. dropping a dead/ghost route) are declared in
``scripts/schema-removal-allowlist.txt`` — one path or ``schema:<Name>`` entry
per line, ``#`` comments allowed — so a deliberate, reviewed removal does not
trip the accidental-drop guard. Entries go stale (harmlessly) once the branch
merges and the baseline no longer contains them.
"""

import json
import os
import sys

_ALLOWLIST_FILE = os.path.join(
    os.path.dirname(__file__), "schema-removal-allowlist.txt"
)


def load(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def load_allowlist() -> tuple[set[str], set[str]]:
    """Return (allowed_paths, allowed_schemas) from the allowlist file, if present."""
    paths: set[str] = set()
    schemas: set[str] = set()
    if not os.path.exists(_ALLOWLIST_FILE):
        return paths, schemas
    with open(_ALLOWLIST_FILE) as f:
        for raw in f:
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line.startswith("schema:"):
                schemas.add(line[len("schema:") :].strip())
            else:
                paths.add(line)
    return paths, schemas


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <candidate.json> <baseline.json>", file=sys.stderr)
        return 2

    candidate = load(sys.argv[1])
    baseline = load(sys.argv[2])
    allowed_paths, allowed_schemas = load_allowlist()

    removed_paths = sorted(
        (set(baseline.get("paths", {})) - set(candidate.get("paths", {})))
        - allowed_paths
    )
    removed_schemas = sorted(
        (
            set(baseline.get("components", {}).get("schemas", {}))
            - set(candidate.get("components", {}).get("schemas", {}))
        )
        - allowed_schemas
    )

    if removed_paths or removed_schemas:
        print("ERROR: OpenAPI schema regression detected vs main.", file=sys.stderr)
        print(
            "The branch is likely behind main. Merge main first, then re-run",
            file=sys.stderr,
        )
        print("scripts/export-openapi.sh and commit the result.", file=sys.stderr)
        if removed_paths:
            print(f"\nRemoved paths ({len(removed_paths)}):", file=sys.stderr)
            for p in removed_paths:
                print(f"  - {p}", file=sys.stderr)
        if removed_schemas:
            print(f"\nRemoved schemas ({len(removed_schemas)}):", file=sys.stderr)
            for s in removed_schemas:
                print(f"  - {s}", file=sys.stderr)
        return 1

    print(
        f"No regression: {len(candidate['paths'])} paths, "
        f"{len(candidate.get('components', {}).get('schemas', {}))} schemas "
        f"(baseline had {len(baseline['paths'])} paths, "
        f"{len(baseline.get('components', {}).get('schemas', {}))} schemas)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
