#!/usr/bin/env bash
# scripts/check-request-body-guards.sh — a `request.data` read must be narrowed
# first (#3280).
#
# ## Why this exists
#
# DRF types `Request.data` as `dict[str, Any] | list[Any]` because a top-level
# JSON array is a legal body. A handler that reaches for `.get`/`[...]` on one
# raises AttributeError/TypeError, and DRF renders that as a **500** — the caller
# is told the server broke rather than that their request was malformed.
#
# This class has been repaired four times: #2126, #2213, #2795 and #3278. Each
# repair fixed its instances, each sweep was complete on the day it landed, and
# each time the next instance arrived unannounced. The predicate is syntactic, so
# unlike most "be careful" findings this one can simply be checked.
#
# ## What counts as a READ
#
#   request.data.get(...) / .items() / .keys() / .pop(...)   attribute access
#   request.data["x"]                                        subscript
#   **request.data                                           dict unpacking
#   "x" in request.data                                      membership  <-- yes
#
# **Membership is a read, not a guard, and that is the point.** `in` also tests a
# *list's elements*, so it passes for the wrong shape and defers the crash:
#
#   if "value" not in request.data:  ...      # `["value"]` sails past
#   columns = request.data["value"]           # ...and dies here (#3278)
#
# The quieter variant returns a wrong 200 rather than crashing: a handler
# branching on `"column" in data` matched nothing for a list body, fell through,
# and reported success having written nothing. A ratchet that accepted `in` as a
# guard would have passed both.
#
# ## What counts as a NARROWING
#
#   object_body(request)                     the house helper (raises 400)
#   isinstance(request.data, dict)           the inline idiom
#   cast("dict[str, Any]", request.data)     provably-unreachable, with a reason
#   Serializer(data=request.data) + is_valid the envelope rejected it first
#   _task_body_mapping(request)              coerces a non-mapping to {}
#
# The last one is the opposite rule and is recognised deliberately rather than
# exempted by path: it is safe only because a ModelSerializer has already
# rejected non-dicts at both its call sites. Listing it here is what makes that
# a claim someone can find and re-check.
#
# ## Scope, honestly stated
#
# Function-scoped and line-ordered: a narrowing anywhere in the same function at
# or above the read satisfies it. That is deliberately permissive — a guard in a
# sibling `if` branch counts — because the alternative is path-sensitive analysis
# and a false positive on a gate people run before every push is how a gate gets
# disabled. It catches the class that has actually recurred: a NEW handler that
# reads named fields off the body and narrows nothing at all.
#
# Reads via a local (`body = object_body(request)` then `body["x"]`) are already
# invisible here, which is the intended shape rather than a gap.
#
# Usage:
#   bash scripts/check-request-body-guards.sh              # check the tree
#   bash scripts/check-request-body-guards.sh --self-test  # prove it can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCAN_ROOT="${1:-${REPO_ROOT}/packages/api/src}"

analyze() {
  python3 - "$1" <<'PYEOF'
import ast, pathlib, sys

READ_ATTRS = {"get", "items", "keys", "values", "pop", "copy", "setdefault", "update"}


def is_request_data(node):
    """`request.data` or `self.request.data`."""
    if not isinstance(node, ast.Attribute) or node.attr != "data":
        return False
    v = node.value
    if isinstance(v, ast.Name) and v.id == "request":
        return True
    return (
        isinstance(v, ast.Attribute)
        and v.attr == "request"
        and isinstance(v.value, ast.Name)
        and v.value.id == "self"
    )


class FnScan(ast.NodeVisitor):
    def __init__(self):
        self.reads = []      # (lineno, what)
        self.narrowings = [] # lineno
        self._has_is_valid = False
        self._serializer_over_body = []

    # -- narrowings ------------------------------------------------------
    def visit_Call(self, node):
        f = node.func
        name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")
        if name in ("object_body", "_task_body_mapping"):
            self.narrowings.append(node.lineno)
        elif name == "isinstance" and node.args and is_request_data(node.args[0]):
            self.narrowings.append(node.lineno)
        elif name == "cast" and len(node.args) == 2 and is_request_data(node.args[1]):
            self.narrowings.append(node.lineno)
        elif name == "is_valid":
            self._has_is_valid = True
        for kw in node.keywords:
            if kw.arg == "data" and kw.value is not None and is_request_data(kw.value):
                self._serializer_over_body.append(node.lineno)
        self.generic_visit(node)

    # -- reads -----------------------------------------------------------
    def visit_Attribute(self, node):
        if is_request_data(node.value) and node.attr in READ_ATTRS:
            self.reads.append((node.lineno, f".{node.attr}(...)"))
        self.generic_visit(node)

    def visit_Subscript(self, node):
        if is_request_data(node.value):
            self.reads.append((node.lineno, "[...] subscript"))
        self.generic_visit(node)

    def visit_Dict(self, node):
        for k, v in zip(node.keys, node.values):
            if k is None and is_request_data(v):
                self.reads.append((v.lineno, " unpacked with **"))
        self.generic_visit(node)

    def visit_Compare(self, node):
        for op, cmp in zip(node.ops, node.comparators):
            if isinstance(op, (ast.In, ast.NotIn)) and is_request_data(cmp):
                self.reads.append((cmp.lineno, " used with `in` — membership is NOT a guard"))
        self.generic_visit(node)

    def visit_FunctionDef(self, node):
        pass  # nested functions are scanned separately by the outer walk

    visit_AsyncFunctionDef = visit_FunctionDef


violations = []
root = pathlib.Path(sys.argv[1])
files = sorted(root.rglob("*.py")) if root.is_dir() else [root]
for path in files:
    if "/migrations/" in str(path):
        continue
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except SyntaxError as exc:
        print(f"check-request-body-guards: cannot parse {path}: {exc}", file=sys.stderr)
        sys.exit(3)
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        scan = FnScan()
        for stmt in fn.body:
            scan.visit(stmt)
        if not scan.reads:
            continue
        guards = list(scan.narrowings)
        if scan._has_is_valid:
            guards += scan._serializer_over_body
        for lineno, what in scan.reads:
            if any(g <= lineno for g in guards):
                continue
            violations.append((path, lineno, fn.name, what))

for path, lineno, fn, what in violations:
    print(f"{path}:{lineno}: {fn}() — unguarded `request.data`{what}")
print(f"check-request-body-guards: {len(violations)} unguarded read(s).")
sys.exit(1 if violations else 0)
PYEOF
}

# --------------------------------------------------------------------------
# Self-test — the real check, against fixture files (#3195: no second copy of
# the parsing logic to drift).
# --------------------------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  st_rc=0

  expect() { # name expectation file
    local want got
    case "$2" in
      accept) want=0 ;;
      reject) want=1 ;;
      *) echo "SELF-TEST: bad expectation '$2'" >&2; st_rc=1; return ;;
    esac
    set +e; analyze "$3" >/dev/null 2>&1; got=$?; set -e
    if [ "$got" -eq "$want" ]; then
      echo "SELF-TEST OK: $1 (exit $got)."
    else
      echo "SELF-TEST FAILED: $1 — expected exit $want, got $got." >&2
      st_rc=1
    fi
  }

  cat > "$tmp/bare_get.py" <<'EOF'
def handler(request):
    return request.data.get("x")
EOF
  cat > "$tmp/membership_then_subscript.py" <<'EOF'
def handler(request):
    if "value" not in request.data:
        raise ValueError
    return request.data["value"]
EOF
  cat > "$tmp/guarded_helper.py" <<'EOF'
from trueppm_api.core.request_body import object_body

def handler(request):
    return object_body(request).get("x")
EOF
  cat > "$tmp/guarded_isinstance.py" <<'EOF'
def handler(request):
    if not isinstance(request.data, dict):
        return None
    return request.data.get("x")
EOF
  cat > "$tmp/guarded_cast.py" <<'EOF'
from typing import Any, cast

def handler(request):
    return cast("dict[str, Any]", request.data).get("x")
EOF
  cat > "$tmp/guarded_serializer.py" <<'EOF'
def handler(request):
    envelope = Serializer(data=request.data)
    envelope.is_valid(raise_exception=True)
    return request.data["changes"]
EOF
  cat > "$tmp/guard_after_read.py" <<'EOF'
def handler(request):
    value = request.data.get("x")
    if not isinstance(request.data, dict):
        return None
    return value
EOF

  expect "a bare .get is rejected"                       reject "$tmp/bare_get.py"
  expect "\`in\` is a read, not a guard"                   reject "$tmp/membership_then_subscript.py"
  expect "a guard AFTER the read does not count"         reject "$tmp/guard_after_read.py"
  expect "object_body() is accepted"                     accept "$tmp/guarded_helper.py"
  expect "isinstance() is accepted"                      accept "$tmp/guarded_isinstance.py"
  expect "cast() is accepted"                            accept "$tmp/guarded_cast.py"
  expect "serializer-then-raw-read is accepted"          accept "$tmp/guarded_serializer.py"

  if [ "$st_rc" -eq 0 ]; then
    echo "SELF-TEST: all cases passed."
  else
    echo "SELF-TEST: FAILURES above." >&2
  fi
  exit "$st_rc"
fi

analyze "$SCAN_ROOT"
