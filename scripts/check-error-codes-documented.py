#!/usr/bin/env python3
"""check-error-codes-documented.py — every emitted `code` is on errors.md, or allowlisted (#4376).

Why this exists. ``packages/website/src/content/docs/api/errors.md`` presents
itself as the complete, stable set of machine-readable `code` values an
integrator can branch on. The page is hand-maintained, and nothing compared it
to the source — nine codes (`calendar_has_no_working_day`, `no_anchor_recorded`,
`not_a_sample`, `already_committed`, `wbs_path_occupied`,
`structure_role_contradicted`, `seed_slug_taken`, `seed_import_concurrency_limit`,
`assignment_not_unit_tracked`) were emitted on the wire and absent from the page
for an unknown length of time before the #4376 /pre-release audit found them by
hand.

What it collects (AST, under ``packages/api/src``), in three shapes:

1. Any dict literal with a ``"code"`` key — covers ``Response({"code": ..., ...})``
   and ``warnings.append({"code": ..., ...})`` with one pattern, since both are
   just a ``Dict`` node with that key.
2. Any call's ``code=`` keyword argument — covers ``raise SomeException(code=...)``
   and helper calls like ``protected_error_response(..., code=...)``.
3. Any ``default_code = ...`` assignment — the ``APIException`` class-attribute form.

A value that is itself a plain string constant is taken directly; a value that
is a bare ``Name`` is resolved against a per-file table of simple
``NAME = "literal"`` assignments (module *or* nested scope — collected with
``ast.walk``, not scope-correct, but this is a docs gate, not a type checker),
which is what ``core/demo_read_only.py``'s ``"code": DEMO_READ_ONLY_CODE`` and
``core/request_body.py``'s ``default_code = INVALID_BODY_CODE`` need. A value
that is neither (an attribute access, a function call, a plain ``Name`` with no
resolvable literal) is skipped — this is what keeps unrelated `code`-named
fields (a program's `code`, an OAuth authorization `code`, an SSO provider
`code`) out of the collected set; see the module docstring's partner, this
file's own self-test, for the concrete shapes that must stay excluded.

Two directions, both against the codes this scan finds **documented**: a
markdown table row whose first cell is a single backticked code
(`` | `foo_bar` | ... `` ``), or a ``code:``/``code=`` prefixed backtick span
anywhere in the page (`` `code: foo_bar` ``, `` `code=foo_bar` `` — the shape
the SSO admin-config subsection uses for a code named inline rather than in its
own table row). Deliberately **not** every backtick span on the page: errors.md
also uses inline code for Python identifiers (`` `exception_handler` ``,
`` `ValidationError` ``), JSON literals (`` `null` ``) and example field values
that happen to share the shape of a code (the nested ``"code": "atlas"`` in the
``seed_replace_required`` example is a program's own code, not an error code) —
treating every such span as a documented error code produced exactly these
false positives during development and is why the match is this narrow.

* **Forward** — a code the AST scan finds (``STRICT``) must be documented (as
  above) or in the allowlist (``scripts/error-code-internal-allowlist.txt``).
  Fails on a new emission site nothing has triaged yet.
* **Reverse** — a code the page documents must still be found by the AST scan,
  *or* appear anywhere as a bare string literal under ``packages/api/src``
  (``ANY_LITERAL`` — deliberately the loose superset, not ``STRICT``: a couple
  of already-shipped codes reach the wire through shapes the three structural
  patterns do not match, such as ``warning = "has_assignments"`` and
  ``payload["scope_pending_on_close"] = advisory``, and the reverse check's job
  is "is this code still alive anywhere", not "does it match one of the three
  canonical shapes" — that precision belongs to the forward check, which is the
  one that actually needs it to avoid flagging unrelated `code` fields).

The allowlist (``scripts/error-code-internal-allowlist.txt``) is for codes that
are real emission sites but never reach a response body — mostly the `code=`
keyword passed to a bare ``ValidationError``/``APIException`` raise, which DRF
collapses to a plain string (errors.md's "Codes that exist in code but not on
the wire" section, issue #2550). It is not a waiver for an integrator-facing
code; a new ``Response({"code": ..., "detail": ...})`` site belongs on
errors.md, not in the allowlist, and this script cannot tell the difference —
a human triaging the first failing run has to.

Usage:
    python3 scripts/check-error-codes-documented.py
    python3 scripts/check-error-codes-documented.py --self-test

Exit codes:
    0  every STRICT code is documented or allowlisted, and every documented
       code is still emitted somewhere
    1  at least one of the above is violated
    2  invocation / setup error, including "the scanner matched nothing"
"""

from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path

SRC_REL = "packages/api/src"
DOCS_REL = "packages/website/src/content/docs/api/errors.md"
ALLOWLIST_REL = "scripts/error-code-internal-allowlist.txt"

_CODE_SHAPE = re.compile(r"^[a-z][a-z0-9_]*$")

# A table row's own first cell: `| `foo_bar` | ...`. Anchored at the start of
# the (stripped) line so a code value mentioned mid-sentence, or a nested
# example field that happens to share the shape, never matches.
_TABLE_ROW_CODE = re.compile(r"^\|\s*`([a-z][a-z0-9_]*)`\s*\|")
# A `code: foo_bar` / `code=foo_bar` backtick span — the one documented code
# (`sso_removal_locks_out_members`) named inline rather than in its own table
# row's first cell.
_PREFIXED_CODE = re.compile(r"`code[:=]\s*([a-z][a-z0-9_]*)`")

ALLOWLIST_HEADER = """\
# Codes raised with a `code=` keyword that never reach the response body (#4376).
#
# DRF's exception_handler collapses `code` to a Python-side attribute on the
# ErrorDetail string subclass when `detail` is a plain string — the wire body is
# just {"detail": "..."}, with no sibling `code` key. errors.md's "Codes that
# exist in code but not on the wire" section (#2550) explains this at length and
# names a few by example; this file is the complete, checked list.
#
# One "<code>\\t<reason>" per line. This is NOT a waiver for an integrator-facing
# code — a new literal `{"code": "...", "detail": "..."}` dict belongs on
# errors.md, not here, and scripts/check-error-codes-documented.py cannot tell
# the difference. A human decides on each new failure.
"""


@dataclass(frozen=True)
class Hit:
    code: str
    file: str
    line: int
    kind: str


def _resolve_str(node: ast.expr, consts: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and node.id in consts:
        return consts[node.id]
    return None


def _module_constants(tree: ast.Module) -> dict[str, str]:
    """``NAME = "literal"`` assignments anywhere in the file (not scope-correct).

    Good enough for a docs gate: the two real cases this resolves
    (``DEMO_READ_ONLY_CODE``, ``INVALID_BODY_CODE``) are both a simple
    module-level ``NAME = "literal"`` referenced later in the same file.
    ``setdefault`` keeps the first binding on a name collision rather than
    picking arbitrarily — irrelevant to both real cases, which bind once.
    """
    consts: dict[str, str] = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            consts.setdefault(node.targets[0].id, node.value.value)
    return consts


class _Collector(ast.NodeVisitor):
    def __init__(self, filename: str, consts: dict[str, str]) -> None:
        self.filename = filename
        self.consts = consts
        self.hits: list[Hit] = []

    def _record(self, value: ast.expr, lineno: int, kind: str) -> None:
        val = _resolve_str(value, self.consts)
        if val and _CODE_SHAPE.match(val):
            self.hits.append(Hit(val, self.filename, lineno, kind))

    def visit_Dict(self, node: ast.Dict) -> None:
        for key, value in zip(node.keys, node.values):
            if isinstance(key, ast.Constant) and key.value == "code":
                self._record(value, node.lineno, "dict")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        for kw in node.keywords:
            if kw.arg == "code":
                self._record(kw.value, node.lineno, "keyword")
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> None:
        if (
            len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "default_code"
        ):
            self._record(node.value, node.lineno, "default_code")
        self.generic_visit(node)


def _all_string_literals(tree: ast.Module) -> set[str]:
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and _CODE_SHAPE.match(node.value)
    }


def scan_source(src_root: Path) -> tuple[list[Hit], set[str]]:
    """Return (strict hits, loose any-literal set) across every .py file under src_root."""
    strict: list[Hit] = []
    loose: set[str] = set()
    for path in sorted(src_root.rglob("*.py")):
        rel = str(path)
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        except (SyntaxError, UnicodeDecodeError):
            continue
        consts = _module_constants(tree)
        collector = _Collector(rel, consts)
        collector.visit(tree)
        strict.extend(collector.hits)
        loose |= _all_string_literals(tree)
    return strict, loose


def documented_codes(text: str) -> set[str]:
    codes = {
        m.group(1)
        for line in text.splitlines()
        if (m := _TABLE_ROW_CODE.match(line.strip()))
    }
    codes |= set(_PREFIXED_CODE.findall(text))
    return codes


def load_allowlist(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" not in line:
            continue
        code, reason = line.split("\t", 1)
        out[code.strip()] = reason.strip()
    return out


def run_check(root: Path) -> int:
    src_root = root / SRC_REL
    docs_path = root / DOCS_REL
    allowlist_path = root / ALLOWLIST_REL
    if not src_root.is_dir() or not docs_path.is_file():
        print(f"ERROR: need {SRC_REL}/ and {DOCS_REL}", file=sys.stderr)
        return 2

    strict, loose = scan_source(src_root)
    if not strict:
        print(
            f"ERROR: scanner matched 0 strict code sites under {SRC_REL};"
            " refusing to pass a check that saw nothing",
            file=sys.stderr,
        )
        return 2

    documented = documented_codes(docs_path.read_text(encoding="utf-8"))
    allowlist = load_allowlist(allowlist_path)

    strict_by_code: dict[str, list[Hit]] = {}
    for hit in strict:
        strict_by_code.setdefault(hit.code, []).append(hit)

    violations: list[str] = []

    for code, hits in sorted(strict_by_code.items()):
        if code in documented or code in allowlist:
            continue
        example = hits[0]
        violations.append(
            f"`{code}` is emitted ({example.file}:{example.line}, {example.kind}) but is not"
            f" on {DOCS_REL} and not in {ALLOWLIST_REL} — document it if integrator-facing,"
            " or allowlist it with a reason if internal"
        )

    for code in sorted(documented - loose):
        violations.append(
            f"`{code}` is documented on {DOCS_REL} but no longer appears anywhere under"
            f" {SRC_REL} — update or remove the row"
        )

    stale_allowlist = sorted(c for c in allowlist if c not in strict_by_code)
    for code in stale_allowlist:
        violations.append(
            f"`{code}` is in {ALLOWLIST_REL} but the scanner no longer finds it emitted"
            " via a `code` dict key, `code=` keyword, or `default_code` — delete the line"
        )

    for v in violations:
        print(f"VIOLATION: {v}")
    if violations:
        print(
            f"\nERROR: {len(violations)} error-code documentation problem(s) (#4376).",
            file=sys.stderr,
        )
        return 1
    print(
        f"OK: {len(strict_by_code)} emitted code(s) ("
        f"{sum(1 for c in strict_by_code if c in documented)} documented, "
        f"{sum(1 for c in strict_by_code if c in allowlist)} allowlisted);"
        f" {len(documented)} documented code(s) all still emitted."
    )
    return 0


# --------------------------------------------------------------------- self-test


def _write(root: Path, rel: str, body: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _fixture(root: Path, source: str, docs: str, allowlist: str | None = None) -> None:
    _write(root, f"{SRC_REL}/pkg/views.py", source)
    _write(root, DOCS_REL, docs)
    if allowlist is not None:
        _write(root, ALLOWLIST_REL, allowlist)


_GOOD_SOURCE = """
from rest_framework.exceptions import APIException
from rest_framework.response import Response

INTERNAL_CODE = "internal_only_literal"


def view(request):
    return Response({"detail": "nope", "code": "documented_code"}, status=400)


def warn(request):
    warnings = []
    warnings.append({"code": "documented_warning", "resource_id": "1"})
    return warnings


class SomeConflict(APIException):
    default_code = "documented_default_code"


def helper(request):
    raise SomeConflict(detail="x", code=INTERNAL_CODE)


def unrelated(program):
    # A `code` dict key that is NOT a string constant — a program's own code,
    # an OAuth authorization code, a Name with no resolvable literal. None of
    # these may be collected.
    return {"code": program.code, "other": "code"}
"""

_GOOD_DOCS = """---
title: Errors
---

| Code | Meaning |
|------|---------|
| `documented_code` | A thing happened |
| `documented_warning` | A warning happened |

`documented_default_code` is named inline rather than in its own table row, the
way the SSO admin-config subsection does it: `code=documented_default_code`.

Unrelated inline code that must NOT count as a documented error code:
`exception_handler`, `ValidationError`, `null`.
"""

_GOOD_ALLOWLIST = (
    ALLOWLIST_HEADER + "internal_only_literal\tNever reaches the wire (#2550 shape).\n"
)


def _run_quiet(root: Path) -> int:
    import contextlib
    import io

    with (
        contextlib.redirect_stdout(io.StringIO()),
        contextlib.redirect_stderr(io.StringIO()),
    ):
        return run_check(root)


def self_test() -> int:
    import tempfile

    ok = True

    def case(
        label: str, source: str, docs: str, allowlist: str | None, expected: int
    ) -> None:
        nonlocal ok
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _fixture(root, source, docs, allowlist)
            status = _run_quiet(root)
            if status != expected:
                print(
                    f"SELF-TEST FAIL: {label} — exit {status}, expected {expected}",
                    file=sys.stderr,
                )
                ok = False

    case(
        "fully documented/allowlisted tree passes",
        _GOOD_SOURCE,
        _GOOD_DOCS,
        _GOOD_ALLOWLIST,
        0,
    )
    case(
        "a program's own `code` field and an OAuth `code=` Name are never collected",
        _GOOD_SOURCE,
        _GOOD_DOCS,
        _GOOD_ALLOWLIST,
        0,
    )
    case(
        "negative control: a brand-new emitted code with no triage fails",
        _GOOD_SOURCE.replace("documented_code", "undocumented_new_code"),
        _GOOD_DOCS,
        _GOOD_ALLOWLIST,
        1,
    )
    case(
        "a deleted table row for a still-emitted code fails (forward direction)",
        _GOOD_SOURCE,
        _GOOD_DOCS.replace("| `documented_code` | A thing happened |\n", ""),
        _GOOD_ALLOWLIST,
        1,
    )
    case(
        "a documented code with no emission site left anywhere fails (reverse direction)",
        _GOOD_SOURCE,
        _GOOD_DOCS + "\n| `a_code_nothing_emits_anymore` | Stale |\n",
        _GOOD_ALLOWLIST,
        1,
    )
    case(
        "a stale allowlist entry the scanner no longer finds fails",
        _GOOD_SOURCE.replace(
            "code=INTERNAL_CODE", 'code="internal_only_literal"'
        ).replace('INTERNAL_CODE = "internal_only_literal"\n', ""),
        _GOOD_DOCS,
        ALLOWLIST_HEADER + "a_code_nobody_raises_anymore\tstale.\n",
        1,
    )

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write(root, DOCS_REL, _GOOD_DOCS)
        status = _run_quiet(root)
        if status != 2:
            print(
                f"SELF-TEST FAIL: missing src tree exited {status}, expected 2",
                file=sys.stderr,
            )
            ok = False

    if not ok:
        return 1
    print(
        "SELF-TEST OK: documented/allowlisted tree passes; unrelated `code`-named fields"
        " (a program's own code, an OAuth code=) are never collected; a new undocumented"
        " emission, a deleted table row, a documented-but-dead code, and a stale allowlist"
        " entry are each caught."
    )
    return 0


def main(argv: list[str]) -> int:
    root = Path(__file__).resolve().parent.parent
    if argv == ["--self-test"]:
        return self_test()
    if argv:
        print(f"usage: {Path(__file__).name} [--self-test]", file=sys.stderr)
        return 2
    return run_check(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
