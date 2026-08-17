#!/usr/bin/env bash
# WebSocket event reachability gate (#2846).
#
# The published WS event taxonomy (packages/website/src/content/docs/api/
# websockets.md) is read by integrators as a subscribable surface: an event
# listed there is one you can connect a client to and receive. Five events were
# listed for months that no client can ever receive.
#
# `program_closed`, `program_reopened`, `program_deleted`, `program_split` and
# `program_sponsorship_transferred` are broadcast to the channel group
# `project_{program_id}`. There is no `ws/v1/programs/{id}/` route, and
# `ProjectConsumer` resolves membership against `ProjectMembership`, which a
# Program UUID never matches — so the only two `group_add` call sites in the
# codebase cannot produce that group. An integrator who builds against those
# rows gets a 4003 close and no amount of debugging on their side fixes it. The
# code half is #836 (0.8); this gate owns the documentation half, which is what
# actually ships at a tag.
#
# What it checks, both directions:
#
#   1. Every event the API broadcasts with a *program* id, when it appears in a
#      taxonomy line of websockets.md (a `- ` bullet or a `| ` table row), must
#      carry the literal marker "not deliverable" on that line — for as long as
#      no program WS route exists.
#   2. Once routing.py grows `ws/v1/programs/`, the same markers become the
#      inverted lie and must come off. Same discipline as the "Ships in 0.X"
#      callouts: the check that turns red is the one that fires on the release
#      which makes the statement false.
#   3. Every event named in the WS-to-webhook taxonomy table exists in
#      FROZEN_WS_EVENT_TYPES — a doc row for a renamed or deleted event is the
#      same defect in a quieter form.
#
# It deliberately does NOT infer deliverability from the event's *name*. The
# classification comes from the broadcast call site's first argument, so an
# event that starts fanning out on a program group under any name is caught.
#
# Exit codes:
#   0  reachable / correctly marked
#   1  a documented event is undeliverable and unmarked (or marked and now
#      deliverable, or names an event the code does not emit)
#   2  invocation / setup error, including "the scanner matched nothing"
#
# Modes:
#   bash scripts/check-ws-event-reachability.sh
#   bash scripts/check-ws-event-reachability.sh --self-test

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_SRC_DEFAULT="packages/api/src/trueppm_api"
ROUTING_DEFAULT="packages/api/src/trueppm_api/routing.py"
FROZEN_DEFAULT="packages/api/tests/apps/sync/test_broadcast.py"
DOC_DEFAULT="packages/website/src/content/docs/api/websockets.md"

# run_scan <api_src> <routing.py> <frozen.py> <doc.md>
run_scan() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import os
import re
import sys

api_src, routing_path, frozen_path, doc_path = sys.argv[1:5]

for p in (api_src, routing_path, frozen_path, doc_path):
    if not os.path.exists(p):
        sys.stderr.write("ERROR: not found: %s\n" % p)
        sys.exit(2)

MARKER = "not deliverable"

# ---------------------------------------------------------------------------
# 1. Classify every broadcast call site by the *type* of the id it fans out on.
#    The first positional argument is the group key: broadcast_board_event()
#    formats it as f"project_{id}". A call site whose id expression is a program
#    therefore produces a group nothing can join.
# ---------------------------------------------------------------------------
CALL_RE = re.compile(
    r"broadcast_board_event\(\s*(?P<idexpr>[^,]+?)\s*,\s*[\"'](?P<event>\w+)[\"']",
    re.S,
)

program_events = set()
all_broadcast_events = set()
call_sites = 0
for root, _dirs, files in os.walk(api_src):
    for name in files:
        if not name.endswith(".py"):
            continue
        path = os.path.join(root, name)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for m in CALL_RE.finditer(text):
            call_sites += 1
            event = m.group("event")
            all_broadcast_events.add(event)
            if re.search(r"program", m.group("idexpr"), re.I):
                program_events.add(event)

# A scanner that matches nothing passes vacuously — the #2647 failure mode.
if call_sites == 0:
    sys.stderr.write(
        "ERROR: found no broadcast_board_event() call sites under %s.\n"
        "       The scanner is broken or the helper was renamed; a gate that\n"
        "       inspects nothing must not report success.\n" % api_src
    )
    sys.exit(2)

# ---------------------------------------------------------------------------
# 2. Can any client join a program group?
# ---------------------------------------------------------------------------
with open(routing_path, encoding="utf-8") as fh:
    routing = fh.read()
program_route = bool(re.search(r"ws/v1/programs/", routing))

# ---------------------------------------------------------------------------
# 3. The frozen contract, for the doc-names-a-real-event parity check.
# ---------------------------------------------------------------------------
with open(frozen_path, encoding="utf-8") as fh:
    frozen_text = fh.read()
m = re.search(r"FROZEN_WS_EVENT_TYPES\s*=\s*frozenset\(\s*\{(.*?)\}\s*\)", frozen_text, re.S)
if not m:
    sys.stderr.write("ERROR: could not parse FROZEN_WS_EVENT_TYPES from %s\n" % frozen_path)
    sys.exit(2)
frozen = set(re.findall(r"[\"'](\w+)[\"']", m.group(1)))
if not frozen:
    sys.stderr.write("ERROR: FROZEN_WS_EVENT_TYPES parsed as empty in %s\n" % frozen_path)
    sys.exit(2)

# ---------------------------------------------------------------------------
# 4. Read the doc's taxonomy lines. A "taxonomy line" is a bullet or a table
#    row — the two forms that present an event as part of the surface. Prose
#    inside an aside is explanation, not a listing, and is not required to
#    repeat the marker on every line.
# ---------------------------------------------------------------------------
with open(doc_path, encoding="utf-8") as fh:
    doc_lines = fh.read().split("\n")

violations = []

# The parity check below is scoped to one section; if that heading is ever
# renamed the check would inspect zero rows and pass vacuously.
if "### Board events broadcast over WebSocket" not in "\n".join(doc_lines):
    sys.stderr.write(
        "ERROR: %s no longer contains the heading\n"
        "       '### Board events broadcast over WebSocket'. The taxonomy-table\n"
        "       parity check is scoped to that section and would inspect nothing.\n"
        % doc_path
    )
    sys.exit(2)

# A "taxonomy block" is one logical listing: a `- ` bullet together with its
# indented continuation lines, or a single `| ` table row. Grouping matters
# because a bullet can carry the marker on its first line and the event names on
# a continuation — the marker applies to the whole bullet, not to each line.
blocks = []  # (first_lineno, text)
i = 0
while i < len(doc_lines):
    line = doc_lines[i]
    stripped = line.lstrip()
    if stripped.startswith("- "):
        start = i
        buf = [line]
        i += 1
        while i < len(doc_lines):
            nxt = doc_lines[i]
            if nxt.strip() == "" or nxt.lstrip().startswith("- ") or not nxt.startswith(" "):
                break
            buf.append(nxt)
            i += 1
        blocks.append((start + 1, "\n".join(buf)))
        continue
    if stripped.startswith("|"):
        blocks.append((i + 1, line))
    i += 1


def blocks_mentioning(event):
    needle = "`%s`" % event
    return [(n, t) for n, t in blocks if needle in t]


for event in sorted(program_events):
    hits = blocks_mentioning(event)
    if not hits:
        continue
    if not program_route:
        for n, text in hits:
            if MARKER in text.lower():
                continue
            violations.append(
                "%s:%d lists `%s` with no \"%s\" marker, but it is broadcast on a\n"
                "    program group that no group_add() can join (there is no\n"
                "    ws/v1/programs/ route). An integrator who subscribes gets 4003.\n"
                "    %s" % (doc_path, n, event, MARKER, text.strip().split("\n")[0])
            )
    else:
        for n, text in hits:
            if MARKER not in text.lower():
                continue
            violations.append(
                "%s:%d still marks `%s` \"%s\", but routing.py now serves\n"
                "    ws/v1/programs/ — the marker is the inverted claim now. Remove it,\n"
                "    and the pre-release aside above the taxonomy with it.\n    %s"
                % (doc_path, n, event, MARKER, text.strip().split("\n")[0])
            )

# Table-row parity: a doc row for an event the code does not emit. Scoped to the
# WS-to-webhook taxonomy section — other tables on the page list close codes and
# endpoints, whose cells are not event names.
TAXONOMY_HEADING = "### Board events broadcast over WebSocket"
TABLE_ROW_RE = re.compile(r"^\|\s*`(\w+)`\s*\|")
in_taxonomy = False
for i, line in enumerate(doc_lines, start=1):
    if line.strip() == TAXONOMY_HEADING:
        in_taxonomy = True
        continue
    if in_taxonomy and line.startswith("## "):
        in_taxonomy = False
    if not in_taxonomy:
        continue
    m = TABLE_ROW_RE.match(line.strip())
    if not m:
        continue
    event = m.group(1)
    if event not in frozen:
        violations.append(
            "%s:%d documents event `%s`, which is not in FROZEN_WS_EVENT_TYPES.\n"
            "    Either the event was renamed/removed in code, or the freeze set is\n"
            "    missing it." % (doc_path, i, event)
        )

if violations:
    sys.stderr.write("\n")
    for v in violations:
        sys.stderr.write("VIOLATION: %s\n" % v)
    sys.stderr.write(
        "\nERROR: %d WebSocket event reachability violation(s).\n" % len(violations)
    )
    sys.exit(1)

print(
    "OK: %d broadcast call sites, %d program-group event(s), program WS route: %s."
    % (call_sites, len(program_events), "present" if program_route else "absent")
)
print("    Every documented event is emitted and correctly marked.")
sys.exit(0)
PY
}

_self_test() {
  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  mk_fixture() { # mk_fixture <dir> <doc-body> [--with-program-route]
    local dir="$1" body="$2" route="${3:-}"
    mkdir -p "$dir/api/apps/projects" "$dir/api/tests" "$dir/doc"
    cat >"$dir/api/apps/projects/program_views.py" <<'PYFX'
def close(self, request, pk=None):
    program_id = str(program.pk)
    transaction.on_commit(
        lambda: broadcast_board_event(
            program_id,
            "program_closed",
            {"id": program_id},
        )
    )


def rename(self, request, pk=None):
    transaction.on_commit(
        lambda: broadcast_board_event(project_id, "project_updated", {"id": project_id})
    )
PYFX
    if [ "$route" = "--with-program-route" ]; then
      cat >"$dir/api/routing.py" <<'PYFX'
websocket_urlpatterns = [
    path("ws/v1/projects/<uuid:pk>/", ProjectConsumer.as_asgi()),
    path("ws/v1/programs/<uuid:pk>/", ProgramConsumer.as_asgi()),
]
PYFX
    else
      cat >"$dir/api/routing.py" <<'PYFX'
websocket_urlpatterns = [
    path("ws/v1/projects/<uuid:pk>/", ProjectConsumer.as_asgi()),
]
PYFX
    fi
    cat >"$dir/api/tests/test_broadcast.py" <<'PYFX'
FROZEN_WS_EVENT_TYPES = frozenset(
    {
        "program_closed",
        "project_updated",
    }
)
PYFX
    # Every fixture carries the taxonomy heading the parity check is scoped to.
    { echo '### Board events broadcast over WebSocket'; echo; printf '%s\n' "$body"; } \
      >"$dir/doc/websockets.md"
  }

  scan() { run_scan "$1/api" "$1/api/routing.py" "$1/api/tests/test_broadcast.py" "$1/doc/websockets.md"; }

  case_run() { # case_run <name> <expect-pass|expect-fail> <dir>
    local name="$1" expect="$2" dir="$3"
    if scan "$dir" >/dev/null 2>&1; then
      if [ "$expect" = "expect-pass" ]; then
        echo "SELF-TEST OK: $name accepted."
      else
        echo "SELF-TEST FAILED: $name was accepted and should not be." >&2
        return 1
      fi
    else
      if [ "$expect" = "expect-fail" ]; then
        echo "SELF-TEST OK: $name correctly rejected."
      else
        echo "SELF-TEST FAILED: $name was rejected and should not be." >&2
        return 1
      fi
    fi
  }

  # The defect as shipped: a program event listed as ordinary surface.
  mk_fixture "$tmp/unmarked" '- **Programs**: `program_closed`

| `program_closed` | **WS-only** |'
  case_run "unmarked-program-event" expect-fail "$tmp/unmarked" || return 1

  # The fix: every listing carries the marker.
  mk_fixture "$tmp/marked" '- **Programs** — not deliverable until 0.8: `program_closed`

| `program_closed` | **WS-only** — not deliverable until 0.8 |'
  case_run "marked-program-event" expect-pass "$tmp/marked" || return 1

  # Table row marked, bullet not — the row an integrator reads is the bullet.
  mk_fixture "$tmp/partial" '- **Programs**: `program_closed`

| `program_closed` | **WS-only** — not deliverable until 0.8 |'
  case_run "partially-marked" expect-fail "$tmp/partial" || return 1

  # The inverted failure: the channel ships, the marker stays.
  mk_fixture "$tmp/stale" '- **Programs** — not deliverable until 0.8: `program_closed`

| `program_closed` | **WS-only** — not deliverable until 0.8 |' --with-program-route
  case_run "stale-marker-after-route-ships" expect-fail "$tmp/stale" || return 1

  mk_fixture "$tmp/shipped" '- **Programs**: `program_closed`

| `program_closed` | **WS-only** |' --with-program-route
  case_run "unmarked-after-route-ships" expect-pass "$tmp/shipped" || return 1

  # A project-scoped event needs no marker at all.
  mk_fixture "$tmp/project" '- **Membership / project**: `project_updated`

| `project_updated` | **WS-only** |'
  case_run "project-event-unmarked" expect-pass "$tmp/project" || return 1

  # A doc row naming an event the code no longer emits.
  mk_fixture "$tmp/ghost" '| `task_ghosted` | **WS-only** |'
  case_run "doc-row-for-unknown-event" expect-fail "$tmp/ghost" || return 1

  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    _self_test
    return $?
  fi
  cd "$REPO_ROOT"
  run_scan \
    "${API_SRC_OVERRIDE:-$API_SRC_DEFAULT}" \
    "${ROUTING_OVERRIDE:-$ROUTING_DEFAULT}" \
    "${FROZEN_OVERRIDE:-$FROZEN_DEFAULT}" \
    "${DOC_OVERRIDE:-$DOC_DEFAULT}"
}

main "$@"
