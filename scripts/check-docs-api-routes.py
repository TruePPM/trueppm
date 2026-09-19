#!/usr/bin/env python3
"""API route documentation gate (#3753).

The published API reference (packages/website/src/content/docs/api/reference.md)
is written by hand. docs/api/openapi.json is regenerated from the code and
drift-gated against it. Nothing compared the two, so an endpoint renamed or
removed in code updated the schema and left the docs describing a route that
404s — `api/idempotency.md` documented `PATCH /api/v1/notifications/{id}/` while
the route is `/api/v1/me/notifications/{id}/`.

Two directions:

  1. Forward, over every published page: each `METHOD /api/v1/…` mention must
     match an operation in openapi.json, or name a path declared as removed in
     scripts/schema-removal-allowlist.txt — which is how api/stability.md is
     allowed to record the endpoints a release took away.
  2. Reverse, over the API reference only: an operation the schema declares and
     the reference never mentions must appear in
     scripts/docs-api-reference-unlisted.txt. That list is a RATCHET — a new
     undocumented operation fails, and so does an entry that is now documented
     or no longer in the schema, so the list can only shrink. Regenerate it
     with --update-baseline; the diff of that file is the author saying, on the
     record, which operations they chose not to document.

Matching rules, so a readable mention is not a false failure:
  - any placeholder spelling matches any schema parameter: `{id}`,
    `{project_pk}`, `<token>`, `:id`;
  - a literal segment in the docs matches a schema parameter (a concrete
    example like `/programs/samples/atlas-platform-launch/download/`), but a
    placeholder in the docs never matches a literal schema segment;
  - `{projects,programs}` expands to both;
  - a path ending in `…` or `...` is a prefix, and matches when some operation
    under it has that method — it satisfies the forward check only, never the
    reverse one;
  - a method list such as `GET`/`POST`/`PATCH` checks each method.

Code fences are checked like prose: a `curl -X POST /api/v1/…` example that
names a route the schema no longer has is the same defect, and it is the one a
reader copies.

The reverse list is honest about what it is: a record of the current gap, not a
review of it. The API reference is also tracked for splitting by resource
(#3754), so the reference set is `api/reference.md` or anything under
`api/reference/`.

Exit codes:
  0  every mention resolves and the unlisted set equals the ratchet
  1  a mention names no operation, or the ratchet disagrees with the tree
  2  invocation / setup error, including "the scanner matched nothing"

Modes:
  python3 scripts/check-docs-api-routes.py
  python3 scripts/check-docs-api-routes.py --update-baseline
  python3 scripts/check-docs-api-routes.py --self-test
"""

from __future__ import annotations

import contextlib
import io
import json
import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

DOCS_REL = "packages/website/src/content/docs"
SCHEMA_REL = "docs/api/openapi.json"
REMOVED_REL = "scripts/schema-removal-allowlist.txt"
BASELINE_REL = "scripts/docs-api-reference-unlisted.txt"
METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")
PARAM = "{}"

_M = "|".join(METHODS)
MENTION = re.compile(
    rf"((?:`?\b(?:{_M})\b`?\s*/\s*)*)`?\b({_M})\b`?[ \t]*\|?[ \t]*`?"
    r"(/api/v1/(?:[A-Za-z0-9_.,:~{}/\-]|…|<[^>\s]*>)*)"
)
BASELINE_HEADER = """\
# Schema operations the API reference does not mention (#3753).
#
# A RATCHET, not a waiver list anyone reviewed: it records the gap between
# docs/api/openapi.json and packages/website/src/content/docs/api/reference.md
# as it stood when the gate was added. scripts/check-docs-api-routes.py fails on
# an operation missing from the reference that is NOT listed here, and on a line
# here whose operation is now documented or gone from the schema. So the list can
# only shrink. Document an operation, then delete its line.
#
# Regenerate with: python3 scripts/check-docs-api-routes.py --update-baseline
"""


@dataclass(frozen=True)
class Mention:
    file: str
    line: int
    methods: tuple[str, ...]
    raw: str
    variants: tuple[tuple[str, ...], ...]
    prefix: bool


def _segments(path: str) -> tuple[str, ...]:
    segs = []
    for seg in path.strip("/").split("/"):
        if not seg:
            continue
        if re.fullmatch(r"\{[^}]*\}|<[^>]*>|:[A-Za-z_]+", seg):
            segs.append(PARAM)
        else:
            segs.append(seg)
    return tuple(segs)


def _expand(path: str) -> list[str]:
    # A single `[^{}]*` group (SonarCloud python:S8786): two adjacent `*`
    # quantifiers straddling a literal `,` let the backtracker try every split
    # point when the tail fails to match, which is super-linear on pathological
    # input. Finding the brace span first and checking for a comma in plain
    # Python keeps the same "first brace block containing a comma" semantics
    # without the ambiguous split.
    alt = next(
        (m for m in re.finditer(r"\{([^{}]*)\}", path) if "," in m.group(1)), None
    )
    if not alt:
        return [path]
    out: list[str] = []
    for choice in alt.group(1).split(","):
        out.extend(_expand(path[: alt.start()] + choice.strip() + path[alt.end() :]))
    return out


def parse_mention(
    file: str, line: int, method_list: str, method: str, raw: str
) -> Mention:
    path = raw.rstrip(".,;:)")
    prefix = False
    for suffix in ("…", "..."):
        if path.endswith(suffix):
            path, prefix = path[: -len(suffix)], True
    methods = tuple(dict.fromkeys(re.findall(rf"\b(?:{_M})\b", method_list) + [method]))
    variants = tuple(_segments(p) for p in _expand(path.split("?", 1)[0]))
    return Mention(file, line, methods, raw, variants, prefix)


def _seg_match(doc: tuple[str, ...], schema: tuple[str, ...], prefix: bool) -> bool:
    if len(schema) < len(doc) or (not prefix and len(schema) != len(doc)):
        return False
    return all(
        d == s or (s == PARAM and d != PARAM) or (d == PARAM and s == PARAM)
        for d, s in zip(doc, schema)
    )


def scan_mentions(
    docs: Path, root: Path, only: list[Path] | None = None
) -> list[Mention]:
    files = (
        only
        if only is not None
        else sorted(f for f in docs.rglob("*") if f.suffix in (".md", ".mdx"))
    )
    found: list[Mention] = []
    for f in files:
        for lineno, line in enumerate(
            f.read_text(encoding="utf-8").splitlines(), start=1
        ):
            for method_list, method, raw in MENTION.findall(line):
                found.append(
                    parse_mention(
                        f.relative_to(root).as_posix(), lineno, method_list, method, raw
                    )
                )
    return found


def load_schema(path: Path) -> dict[tuple[str, ...], set[str]]:
    spec = json.loads(path.read_text(encoding="utf-8"))
    ops: dict[tuple[str, ...], set[str]] = {}
    for p, item in spec.get("paths", {}).items():
        methods = {m.upper() for m in item if m.upper() in METHODS}
        if methods:
            ops.setdefault(_segments(p), set()).update(methods)
    return ops


def load_removed(path: Path) -> list[tuple[str, ...]]:
    if not path.is_file():
        return []
    return [
        _segments(line.strip())
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("/api/")
    ]


def schema_path_strings(path: Path) -> dict[tuple[str, str], str]:
    spec = json.loads(path.read_text(encoding="utf-8"))
    return {
        (m.upper(), p): f"{m.upper()} {p}"
        for p, item in spec.get("paths", {}).items()
        for m in item
        if m.upper() in METHODS
    }


def reference_files(docs: Path) -> list[Path]:
    files = [docs / "api/reference.md"] if (docs / "api/reference.md").is_file() else []
    ref_dir = docs / "api/reference"
    if ref_dir.is_dir():
        files += sorted(f for f in ref_dir.rglob("*") if f.suffix in (".md", ".mdx"))
    return files


def unlisted_operations(root: Path) -> list[str]:
    docs = root / DOCS_REL
    mentions = [
        m for m in scan_mentions(docs, root, reference_files(docs)) if not m.prefix
    ]
    missing = []
    for (method, path), label in sorted(
        schema_path_strings(root / SCHEMA_REL).items(),
        key=lambda kv: (kv[0][1], kv[0][0]),
    ):
        segs = _segments(path)
        documented = any(
            method in m.methods and any(_seg_match(v, segs, False) for v in m.variants)
            for m in mentions
        )
        if not documented:
            missing.append(label)
    return missing


def read_baseline(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    return {
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }


def run_check(root: Path) -> int:
    docs, schema_file = root / DOCS_REL, root / SCHEMA_REL
    if not docs.is_dir() or not schema_file.is_file():
        print(f"ERROR: need {DOCS_REL}/ and {SCHEMA_REL}", file=sys.stderr)
        return 2
    ops = load_schema(schema_file)
    removed = load_removed(root / REMOVED_REL)
    mentions = scan_mentions(docs, root)
    refs = reference_files(docs)
    if not ops or not mentions or not refs:
        print(
            f"ERROR: scanner matched operations={len(ops)} mentions={len(mentions)} reference_files={len(refs)};"
            " refusing to pass a check that saw nothing",
            file=sys.stderr,
        )
        return 2

    violations: list[str] = []
    for m in mentions:
        for method in m.methods:
            hit = any(
                _seg_match(v, segs, m.prefix) and method in methods
                for v in m.variants
                for segs, methods in ops.items()
            )
            gone = any(
                _seg_match(v, segs, m.prefix) for v in m.variants for segs in removed
            )
            if not hit and not gone:
                violations.append(
                    f"{m.file}:{m.line} documents `{method} {m.raw}` — no such operation in {SCHEMA_REL}"
                )

    baseline_path = root / BASELINE_REL
    baseline = read_baseline(baseline_path)
    current = set(unlisted_operations(root))
    for label in sorted(current - baseline):
        violations.append(
            f"{label} is in the schema and not in the API reference — document it, or (on the record)"
            f" add it to {BASELINE_REL} with --update-baseline"
        )
    for label in sorted(baseline - current):
        violations.append(
            f"{BASELINE_REL} still lists `{label}`, which is now documented or no longer in the schema — delete the line"
        )

    for v in violations:
        print(f"VIOLATION: {v}")
    if violations:
        print(
            f"\nERROR: {len(violations)} API route documentation problem(s) (#3753).",
            file=sys.stderr,
        )
        return 1
    print(
        f"OK: {len(mentions)} route mention(s) resolve against {sum(len(v) for v in ops.values())} operation(s);"
        f" {len(current)} operation(s) unlisted in the API reference, matching the ratchet."
    )
    return 0


def update_baseline(root: Path) -> int:
    current = unlisted_operations(root)
    (root / BASELINE_REL).write_text(
        BASELINE_HEADER + "\n" + "\n".join(current) + "\n", encoding="utf-8"
    )
    print(f"Wrote {len(current)} unlisted operation(s) to {BASELINE_REL}")
    return 0


# --------------------------------------------------------------------- self-test


def _write(root: Path, rel: str, body: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _fixture(
    root: Path, page: str, reference: str, baseline: list[str] | None = None
) -> None:
    schema = {
        "paths": {
            "/api/v1/projects/{project_pk}/members/": {"get": {}, "post": {}},
            "/api/v1/programs/{program_pk}/webhooks/": {"post": {}},
            "/api/v1/projects/{project_pk}/webhooks/": {"post": {}},
            "/api/v1/me/notifications/{id}/": {"get": {}, "patch": {}},
            "/api/v1/share/schedule/{token}/": {"get": {}},
            "/api/v1/programs/samples/{key}/download/": {"get": {}},
            "/api/v1/dependencies/": {"post": {}},
        }
    }
    _write(root, SCHEMA_REL, json.dumps(schema))
    _write(root, REMOVED_REL, "# removed\n/api/v1/projects/{id}/workshop/start/\n")
    _write(root, f"{DOCS_REL}/features/page.md", page)
    _write(root, f"{DOCS_REL}/api/reference.md", reference)
    if baseline is not None:
        _write(root, BASELINE_REL, BASELINE_HEADER + "\n".join(baseline) + "\n")


def _run_quiet(fn, root: Path) -> int:
    with (
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        return fn(root)


def self_test() -> int:
    good_page = (
        "Call `GET /api/v1/projects/{id}/members/` or `POST /api/v1/{projects,programs}/{id}/webhooks/`.\n"
        "| `GET`/`POST` /api/v1/projects/:project_id/members/ |\n"
        "Try `GET /api/v1/share/schedule/<token>/` and GET /api/v1/programs/samples/atlas/download/.\n"
        "Anything under `GET /api/v1/me/notifications/…` works. POST /api/v1/dependencies/.\n"
        "Removed in 0.4: `POST /api/v1/projects/{id}/workshop/start/`.\n"
        "```bash\ncurl -X POST /api/v1/dependencies/\n```\n"
    )
    full_reference = (
        "GET /api/v1/projects/{id}/members/\nPOST /api/v1/projects/{id}/members/\n"
        "POST /api/v1/programs/{id}/webhooks/\nPOST /api/v1/projects/{id}/webhooks/\n"
        "GET /api/v1/me/notifications/{id}/\nPATCH /api/v1/me/notifications/{id}/\n"
        "GET /api/v1/share/schedule/{token}/\nGET /api/v1/programs/samples/{key}/download/\n"
    )
    cases = [
        (
            "placeholders, literal examples, alternation, prefixes, method lists, removals",
            good_page,
            0,
            None,
        ),
        (
            "the idempotency.md defect — a path the schema does not have",
            good_page + "PATCH /api/v1/notifications/{id}/\n",
            1,
            None,
        ),
        (
            "a real path documented with a method it does not accept",
            good_page + "DELETE /api/v1/dependencies/\n",
            1,
            None,
        ),
        (
            "a stale route inside a code fence",
            good_page + "```bash\ncurl -X PATCH /api/v1/notifications/{id}/\n```\n",
            1,
            None,
        ),
        (
            "a placeholder where the schema has a literal segment",
            good_page + "GET /api/v1/programs/{id}/download/\n",
            1,
            None,
        ),
        (
            "an operation missing from the reference and the ratchet",
            good_page,
            1,
            ["POST /api/v1/dependencies/", "__drop__"],
        ),
        (
            "a ratchet line whose operation is now documented",
            good_page,
            1,
            ["POST /api/v1/dependencies/", "GET /api/v1/share/schedule/{token}/"],
        ),
    ]
    ok = True
    for label, page, expected, baseline in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            reference = full_reference
            listed = ["POST /api/v1/dependencies/"]
            if baseline is not None:
                if "__drop__" in baseline:
                    reference = full_reference.replace(
                        "GET /api/v1/share/schedule/{token}/\n", ""
                    )
                    listed = ["POST /api/v1/dependencies/"]
                else:
                    listed = baseline
            _fixture(root, page, reference, listed)
            status = _run_quiet(run_check, root)
            if status != expected:
                print(
                    f"SELF-TEST FAIL: {label} — exit {status}, expected {expected}",
                    file=sys.stderr,
                )
                ok = False

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _fixture(root, "No routes here.\n", "Nor here.\n", [])
        status = _run_quiet(run_check, root)
        if status != 2:
            print(
                f"SELF-TEST FAIL: a docs tree with no route mentions exited {status}, expected 2",
                file=sys.stderr,
            )
            ok = False
        _fixture(
            root,
            good_page,
            full_reference.replace("GET /api/v1/share/schedule/{token}/\n", ""),
            [],
        )
        _run_quiet(update_baseline, root)
        status = _run_quiet(run_check, root)
        if status != 0 or "GET /api/v1/share/schedule/{token}/" not in read_baseline(
            root / BASELINE_REL
        ):
            print(
                "SELF-TEST FAIL: --update-baseline did not produce a ratchet the check accepts",
                file=sys.stderr,
            )
            ok = False

    if not ok:
        return 1
    print(
        f"SELF-TEST OK: {len(cases) + 2} cases — readable mentions accepted; a missing path, a wrong method, a"
        " placeholder over a literal, a new undocumented operation and a stale ratchet line caught;"
        " a vacuous tree refused; --update-baseline round-trips."
    )
    return 0


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent.parent
    if argv == ["--self-test"]:
        return self_test()
    if argv == ["--update-baseline"]:
        return update_baseline(root)
    if argv:
        print(
            f"usage: {Path(__file__).name} [--self-test | --update-baseline]",
            file=sys.stderr,
        )
        return 2
    return run_check(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
