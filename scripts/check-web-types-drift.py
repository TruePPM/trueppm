#!/usr/bin/env python3
"""check-web-types-drift.py — hand-maintained web API types agree with the schema.

Why this exists (#2633). ``packages/web/src/api/types.ts`` is written by hand, not
generated, and nothing compared it to ``docs/api/openapi.json``. ``tsc --strict``
passing over it proved only that the interfaces agreed with their own consumers
and with fixtures written from the same assumption. Six user-id fields
(``Program.lead`` / ``created_by`` / ``closed_by``, ``Risk.owner`` /
``created_by``, ``AgentAction.principal``) sat typed ``string`` against integer
``AutoField`` PKs, and every consumer built on them compared a number to a string
— ``risk.owner === currentUserId`` could never be true.

What it checks. For every ``export interface`` in types.ts that maps to an OpenAPI
component schema, each field the two sides SHARE must resolve to the same
primitive kind set — ``number`` / ``string`` / ``boolean`` / ``array`` /
``object`` — with ``null`` ignored. Inline object literals (``lead_detail: { id:
number; ... }``) are compared field-by-field against the ``$ref`` they mirror.

What it deliberately does NOT check — read this before citing a green run:

* **Missing or extra fields.** Only shared names are compared. A field the server
  added and the interface never declared is invisible here (so a branch adding a
  serializer field is never blocked by an interface it did not touch).
* **Nullability, optionality, enum membership, string formats.** ``string | null``
  vs a non-null ``string`` passes; ``'a' | 'b'`` vs an enum of ``'a' | 'c'``
  passes. Kind only.
* **Fields whose TS type names another interface** (``foo: Bar``) — skipped, not
  followed. An inline literal is followed; a named reference is not.
* **Unmapped interfaces.** An interface whose name matches no component and has no
  entry in ``ALIASES`` is reported as unmapped and must be listed in ``UNMAPPED``
  with a reason, so coverage cannot shrink silently — but its fields are unchecked.
* **Anything outside types.ts.** Feature-local interfaces (``useCurrentUser.ts``'s
  ``CurrentUser``, hook-local response types) are not read.

Ratchets. ``WAIVERS`` records known drift the gate found but this change did not
fix. A waiver that no longer matches a mismatch FAILS (it must be deleted), so the
list can only shrink. Same for ``UNMAPPED``: an entry that now maps, or no longer
exists, fails.

Usage:  python3 scripts/check-web-types-drift.py [--self-test]
Exit:   0 no unwaived drift · 1 drift, stale waiver, or unmapped interface
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
TYPES_TS = Path(
    os.environ.get("TYPES_TS_OVERRIDE", REPO_ROOT / "packages/web/src/api/types.ts")
)
OPENAPI = Path(os.environ.get("OPENAPI_OVERRIDE", REPO_ROOT / "docs/api/openapi.json"))

# Interface name -> component schema name, where the two are not spelled the same.
# An interface whose name IS a component name maps implicitly.
ALIASES: dict[str, str] = {
    "UserSummary": "_UserSummary",
    "ProjectMembership": "ProjectMembershipRead",
    "ProgramMembership": "ProgramMembershipRead",
}

# Interfaces with no response schema to compare against, each with the reason.
UNMAPPED: dict[str, str] = {
    "PaginatedResponse": "generic DRF envelope; each concrete list has its own Paginated*List",
    "EffectiveCalendar": "nested in Project.effective_calendar, which the schema declares free-form",
    "PendingInvite": "client view model mapped from WorkspaceInvite (camelCase), not a wire shape",
    "WorkspaceGroup": "client view model mapped from the groups payload, not a wire shape",
    "WorkspaceGroupMember": "client view model nested in WorkspaceGroup, not a wire shape",
    "WorkspaceGroupProject": "client view model nested in WorkspaceGroup, not a wire shape",
}

# Known drift left for a follow-up. "Interface.path.to.field" -> reason (with issue).
# A waiver that stops matching fails the gate — delete it; never add one to get a
# change past review without naming the issue that will remove it.
WAIVERS: dict[str, str] = {}

# ---------------------------------------------------------------------------
# TypeScript side
# ---------------------------------------------------------------------------


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), src, flags=re.S)
    # Line comments, but not `//` inside a string literal (URLs in quoted types).
    out = []
    for line in src.split("\n"):
        in_str: str | None = None
        cut = len(line)
        for i, ch in enumerate(line):
            if in_str:
                if ch == in_str and line[i - 1] != "\\":
                    in_str = None
            elif ch in "'\"`":
                in_str = ch
            elif ch == "/" and line[i : i + 2] == "//":
                cut = i
                break
        out.append(line[:cut])
    return "\n".join(out)


def _split_top(s: str, sep: str) -> list[str]:
    """Split on ``sep`` at nesting depth 0 (``{}``, ``()``, ``<>``, ``[]``, strings)."""
    parts, depth, cur, in_str = [], 0, [], None
    for ch in s:
        if in_str:
            cur.append(ch)
            if ch == in_str:
                in_str = None
            continue
        if ch in "'\"`":
            in_str = ch
        elif ch in "{(<[":
            depth += 1
        elif ch in "})>]":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return parts


def _parse_members(body: str) -> dict[str, str]:
    """``{ a: T; b?: U }`` body -> ``{a: "T", b: "U"}``. Index signatures are skipped."""
    members: dict[str, str] = {}
    for raw in _split_top(body.replace(",\n", ";\n"), ";"):
        part = raw.strip()
        if not part or part.startswith("["):
            continue
        m = re.match(
            r"(?:readonly\s+)?['\"]?([A-Za-z_$][\w$]*)['\"]?\??\s*:(.+)$", part, re.S
        )
        if m:
            members[m.group(1)] = " ".join(m.group(2).split())
    return members


def parse_types_ts(src: str) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    """Return ``(interfaces, aliases)`` for every exported interface / type alias."""
    src = _strip_comments(src)
    interfaces: dict[str, dict[str, str]] = {}
    # Possessive quantifiers: a header with no ``{`` fails in one pass instead of
    # backtracking through every shorter length of the ``extends`` run (S8786).
    for m in re.finditer(
        r"export interface (\w+)(?:<[^>]*+>)?\s*+(?:extends[^{]*+)?\{", src
    ):
        depth, i = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(src[i], 0)
            i += 1
        interfaces[m.group(1)] = _parse_members(src[m.end() : i - 1])
    aliases = {
        m.group(1): " ".join(m.group(2).split())
        for m in re.finditer(r"export type (\w+)\s*=([^;]+);", src)
    }
    return interfaces, aliases


@dataclass
class TsKind:
    """The primitive kinds a TS type can take, plus the inline members if it is a literal."""

    kinds: set[str] | None  # None = unresolvable (named reference) -> skip
    members: dict[str, str] | None = None
    items: TsKind | None = None


def ts_kind(
    t: str, aliases: dict[str, str], _seen: frozenset[str] = frozenset()
) -> TsKind:
    t = t.strip()
    alts = [a.strip() for a in _split_top(t, "|") if a.strip()]
    if len(alts) > 1:
        kinds: set[str] = set()
        members = items = None
        for alt in alts:
            k = ts_kind(alt, aliases, _seen)
            if k.kinds is None:
                return TsKind(None)
            kinds |= k.kinds
            members = members or k.members
            items = items or k.items
        return TsKind(kinds, members, items)
    if t.startswith("(") and t.endswith(")"):
        return ts_kind(t[1:-1], aliases, _seen)
    if t in ("null", "undefined"):
        return TsKind(set())
    if t in ("number", "string", "boolean"):
        return TsKind({t})
    if re.fullmatch(r"-?\d+(\.\d+)?", t):
        return TsKind({"number"})
    if re.fullmatch(r"'[^']*'|\"[^\"]*\"|`[^`]*`", t):
        return TsKind({"string"})
    if t in ("true", "false"):
        return TsKind({"boolean"})
    if t.endswith("[]"):
        return TsKind({"array"}, items=ts_kind(t[:-2], aliases, _seen))
    m = re.fullmatch(r"(?:Readonly)?Array<(.+)>", t)
    if m:
        return TsKind({"array"}, items=ts_kind(m.group(1), aliases, _seen))
    if t.startswith("{") and t.endswith("}"):
        return TsKind({"object"}, members=_parse_members(t[1:-1]))
    if t.startswith("Record<"):
        return TsKind({"object"})
    if t in aliases and t not in _seen:
        return ts_kind(aliases[t], aliases, _seen | {t})
    return TsKind(None)


# ---------------------------------------------------------------------------
# OpenAPI side
# ---------------------------------------------------------------------------


@dataclass
class ApiKind:
    kinds: set[str] | None
    ref: str | None = None
    items: ApiKind | None = None


def api_kind(
    schema: dict[str, Any], components: dict[str, Any], _depth: int = 0
) -> ApiKind:
    if _depth > 8:
        return ApiKind(None)
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        target = components.get(name, {})
        k = api_kind(target, components, _depth + 1)
        if k.kinds == {"object"} and k.ref is None:
            k.ref = name
        return k
    for key in ("allOf", "oneOf", "anyOf"):
        if key in schema:
            kinds: set[str] = set()
            ref = items = None
            for sub in schema[key]:
                k = api_kind(sub, components, _depth + 1)
                if k.kinds is None:
                    return ApiKind(None)
                kinds |= k.kinds
                ref = ref or k.ref
                items = items or k.items
            return ApiKind(kinds, ref, items)
    typ = schema.get("type")
    types = typ if isinstance(typ, list) else [typ] if typ else []
    kinds = set()
    for t in types:
        if t in ("integer", "number"):
            kinds.add("number")
        elif t in ("string", "boolean", "array", "object"):
            kinds.add(t)
    if not types:
        if "enum" in schema:
            vals = [v for v in schema["enum"] if v is not None]
            if all(isinstance(v, str) for v in vals):
                return ApiKind({"string"} if vals else set())
            return ApiKind(None)
        if "properties" in schema:
            return ApiKind({"object"})
        return ApiKind(None)  # free-form / any
    items = (
        api_kind(schema["items"], components, _depth + 1) if "items" in schema else None
    )
    return ApiKind(kinds, None, items)


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def _compare(
    path: str,
    ts: TsKind,
    api: ApiKind,
    components: dict[str, Any],
    aliases: dict[str, str],
    out: dict[str, str],
) -> None:
    if ts.kinds is None or api.kinds is None:
        return
    if not ts.kinds or not api.kinds:
        return  # a bare null on either side says nothing about kind
    if ts.kinds != api.kinds:
        out[path] = (
            f"types.ts {'|'.join(sorted(ts.kinds))} vs schema {'|'.join(sorted(api.kinds))}"
        )
        return
    if ts.members is not None and api.ref:
        _compare_members(path, ts.members, api.ref, components, aliases, out)
    if ts.items is not None and api.items is not None:
        _compare(f"{path}[]", ts.items, api.items, components, aliases, out)


def _compare_members(
    prefix: str,
    members: dict[str, str],
    schema_name: str,
    components: dict[str, Any],
    aliases: dict[str, str],
    out: dict[str, str],
) -> None:
    props = components.get(schema_name, {}).get("properties", {})
    for name, t in members.items():
        if name in props:
            _compare(
                f"{prefix}.{name}",
                ts_kind(t, aliases),
                api_kind(props[name], components),
                components,
                aliases,
                out,
            )


def find_drift(
    types_src: str, openapi: dict[str, Any]
) -> tuple[dict[str, str], list[str], int]:
    """Return ``(mismatches, unmapped_interfaces, mapped_count)``."""
    components = openapi.get("components", {}).get("schemas", {})
    interfaces, aliases = parse_types_ts(types_src)
    mismatches: dict[str, str] = {}
    unmapped: list[str] = []
    mapped = 0
    for iface, members in interfaces.items():
        schema = ALIASES.get(iface, iface)
        if schema not in components:
            unmapped.append(iface)
            continue
        mapped += 1
        _compare_members(iface, members, schema, components, aliases, mismatches)
    return mismatches, unmapped, mapped


def run(types_path: Path, openapi_path: Path) -> list[str]:
    """All failures for the given inputs, empty when clean."""
    mismatches, unmapped, _ = find_drift(
        types_path.read_text(), json.loads(openapi_path.read_text())
    )
    interfaces, _aliases = parse_types_ts(types_path.read_text())
    errors: list[str] = []
    for path, why in sorted(mismatches.items()):
        if path not in WAIVERS:
            errors.append(f"DRIFT     {path}: {why}")
    for path in sorted(set(WAIVERS) - set(mismatches)):
        errors.append(
            f"STALE     waiver {path} no longer drifts — delete it from WAIVERS"
        )
    for iface in sorted(set(unmapped) - set(UNMAPPED)):
        errors.append(
            f"UNMAPPED  interface {iface} matches no component schema — add it to ALIASES "
            "or to UNMAPPED with a reason"
        )
    for iface in sorted(set(ALIASES) - set(interfaces)):
        errors.append(
            f"STALE     ALIASES entry {iface} names no interface in types.ts — delete it"
        )
    for iface in sorted(set(UNMAPPED) - set(unmapped)):
        state = "now maps" if iface in interfaces else "no longer exists"
        errors.append(f"STALE     UNMAPPED entry {iface} {state} — delete it")
    return errors


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

_FIXTURE_TS = """
export type Health = 'OK' | 'BAD';
export type HealthAlias = Health;
export interface Thing {
  id: string;
  /** a comment: with a colon */
  owner: %(owner)s;
  health: HealthAlias;
  tags: string[];
  lead_detail: { id: %(lead_id)s; name: string } | null;
  other: Unknown;
  ts_only: number;
}
"""

_FIXTURE_API: dict[str, Any] = {
    "components": {
        "schemas": {
            "Thing": {
                "properties": {
                    "id": {"type": "string", "format": "uuid"},
                    "owner": {"type": "integer", "nullable": True},
                    "health": {"$ref": "#/components/schemas/HealthEnum"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "lead_detail": {
                        "allOf": [{"$ref": "#/components/schemas/Summary"}],
                        "nullable": True,
                    },
                    "other": {"type": "string"},
                    "api_only": {"type": "integer"},
                }
            },
            "HealthEnum": {"enum": ["OK", "BAD"], "type": "string"},
            "Summary": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            },
        }
    }
}


def self_test() -> int:
    global WAIVERS, UNMAPPED, ALIASES
    saved = (WAIVERS, UNMAPPED, ALIASES)
    failures: list[str] = []

    def case(
        name: str, owner: str, lead_id: str, extra_ts: str, expect: list[str]
    ) -> None:
        with tempfile.TemporaryDirectory() as d:
            tp, ap = Path(d, "types.ts"), Path(d, "openapi.json")
            tp.write_text(_FIXTURE_TS % {"owner": owner, "lead_id": lead_id} + extra_ts)
            ap.write_text(json.dumps(_FIXTURE_API))
            got = run(tp, ap)
        # Normalize each failure to its first two tokens ("DRIFT Thing.owner").
        seen = sorted(" ".join(e.split()[:2]).rstrip(":") for e in got)
        if seen != sorted(expect):
            failures.append(f"{name}: expected {sorted(expect)}, got {got}")

    try:
        WAIVERS, UNMAPPED, ALIASES = {}, {}, {}
        case("clean", "number | null", "number", "", [])
        case("top-level drift", "string | null", "number", "", ["DRIFT Thing.owner"])
        case(
            "nested drift",
            "number | null",
            "string",
            "",
            ["DRIFT Thing.lead_detail.id"],
        )
        case(
            "unmapped interface",
            "number | null",
            "number",
            "export interface Orphan { a: string }\n",
            ["UNMAPPED interface"],
        )
        WAIVERS = {"Thing.owner": "fixture"}
        case("waiver silences drift", "string | null", "number", "", [])
        case("stale waiver fails", "number | null", "number", "", ["STALE waiver"])
        WAIVERS, UNMAPPED = {}, {"Orphan": "fixture"}
        case(
            "unmapped entry silences",
            "number | null",
            "number",
            "export interface Orphan { a: string }\n",
            [],
        )
        case("stale unmapped fails", "number | null", "number", "", ["STALE UNMAPPED"])
        WAIVERS, UNMAPPED, ALIASES = {}, {}, {"Gone": "Thing"}
        case("stale alias fails", "number | null", "number", "", ["STALE ALIASES"])
        ALIASES = {"Renamed": "Thing"}
        case(
            "alias maps a differently-named interface",
            "number | null",
            "number",
            "export interface Renamed { owner: string }\n",
            ["DRIFT Renamed.owner"],
        )
    finally:
        WAIVERS, UNMAPPED, ALIASES = saved

    if failures:
        print("check-web-types-drift self-test FAILED:", *failures, sep="\n  ")
        return 1
    print(
        "check-web-types-drift self-test: 10 cases OK (detects top-level + nested drift, ratchets)"
    )
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return self_test()
    errors = run(TYPES_TS, OPENAPI)
    _, _, mapped = find_drift(TYPES_TS.read_text(), json.loads(OPENAPI.read_text()))
    if errors:
        print(
            f"types.ts drift vs {OPENAPI.relative_to(REPO_ROOT) if OPENAPI.is_relative_to(REPO_ROOT) else OPENAPI}:"
        )
        for e in errors:
            print(f"  {e}")
        print(
            "\nFix the interface in packages/web/src/api/types.ts (and the consumers tsc then names)."
            "\nIf the SCHEMA is the wrong artifact, fix the serializer and regenerate it."
            "\nSee scripts/check-web-types-drift.py's docstring for what this gate does not check."
        )
        return 1
    print(
        f"types.ts drift: {mapped} interfaces compared against the schema on shared fields, "
        f"{len(WAIVERS)} waived field(s), {len(UNMAPPED)} unmapped interface(s) — OK"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
