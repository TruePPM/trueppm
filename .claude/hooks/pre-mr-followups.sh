#!/usr/bin/env bash
# PreToolUse hook (matcher: "Bash") — run the `lint:mr-followups` check on an MR
# description BEFORE the description reaches GitLab (#5108).
#
# ## Why a hook
#
# `lint:mr-followups` (`scripts/check-mr-followups.sh`, #4159) reds the MR pipeline
# when a description line uses follow-up / deferral wording with no open issue on that
# line. The `/mr` skill has carried a prose rule against the commonest trip — calling a
# commit already on the branch "the follow-up commit" — and it tripped anyway three
# times (!2841, !3025, !3557). The check is a pure text scan with a `--file` mode, so
# the only reason it ran after the push was that nothing ran it before.
#
# ## What it inspects
#
# Only a Bash command that writes an MR description:
#   `glab mr create` / `glab mr update` carrying -d / --description
#   `glab api` against a `merge_requests` path with a `description` field
# The description is taken from, in order: heredoc bodies in the command,
# `$(cat <file>)` and `description=@<file>` file reads, and a literal `-d` /
# `--description` / `description=` value. Anything else is allowed untouched.
# Every heredoc in such a command is scanned, so a `git commit` heredoc chained in
# front of `glab mr create` is checked too; keep those chains apart.
#
# The check runs OFFLINE (no CI_PROJECT_ID), so it proves a follow-up line names an
# issue, not that the issue is open; the CI job still checks the tracker.
#
# ## Output contract
#
# Exit 2 blocks the tool call and feeds stderr back to Claude; exit 0 allows it.
# Any error inside the hook itself fails OPEN: this is a convenience ahead of a CI
# gate that still runs, never the boundary.
# <!-- cc-claim: https://code.claude.com/docs/en/hooks checked: 2026-11-23 -->
#
# Self-test: scripts/tests/pre-mr-followups.test.sh
set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
CHECK="${MR_FOLLOWUPS_CHECK:-$ROOT/scripts/check-mr-followups.sh}"

command -v python3 >/dev/null 2>&1 || exit 0
[ -f "$CHECK" ] || exit 0

tmp="$(mktemp -d 2>/dev/null)" || exit 0
trap 'rm -rf "$tmp"' EXIT

IFS= read -r -d '' EXTRACT <<'PYEOF' || true
import json, os, re, shlex, sys

try:
    event = json.load(sys.stdin)
    cmd = event.get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)
if not isinstance(cmd, str) or not cmd:
    sys.exit(0)

mr_write = re.search(r"\bglab\b[^\n;&|]*?\bmr\s+(create|update)\b", cmd) and re.search(
    r"(^|\s)(-d|--description)(=|\s)", cmd
)
api_write = (
    re.search(r"\bglab\s+api\b", cmd)
    and "merge_requests" in cmd
    and re.search(r"\bdescription=", cmd)
)
if not (mr_write or api_write):
    sys.exit(0)

cwd = event.get("cwd") or os.getcwd()
roots = [cwd, os.environ.get("CLAUDE_PROJECT_DIR", "")]


def read_file(path):
    path = os.path.expanduser(path.strip().strip("'\""))
    for base in [""] + roots:
        full = path if os.path.isabs(path) or not base else os.path.join(base, path)
        try:
            with open(full, encoding="utf-8") as fh:
                return fh.read()
        except OSError:
            continue
    return None


texts = []
# Heredoc bodies: `<<'EOF' ... EOF`, `<<EOF`, `<<-EOF`.
for m in re.finditer(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*(?=$|\n|\))", cmd, re.S):
    texts.append(m.group(3))
# File reads: `$(cat file)`, `description=@file`.
for m in re.finditer(r"\$\(\s*cat\s+([^)<\s][^)]*?)\s*\)", cmd):
    body = read_file(m.group(1))
    if body is not None:
        texts.append(body)
for m in re.finditer(r"description=@(\"[^\"]+\"|'[^']+'|\S+)", cmd):
    body = read_file(m.group(1))
    if body is not None:
        texts.append(body)
# A literal value, when no substitution supplied it.
if not texts:
    try:
        toks = shlex.split(cmd, posix=True)
    except ValueError:
        toks = []
    for i, t in enumerate(toks):
        val = None
        if t in ("-d", "--description") and i + 1 < len(toks):
            val = toks[i + 1]
        elif t.startswith("--description="):
            val = t.split("=", 1)[1]
        elif t.startswith("description=") and not t.startswith("description=@"):
            val = t.split("=", 1)[1]
        if val and "$(" not in val:
            texts.append(val)
if not texts:
    sys.exit(0)
sys.stdout.write("\n\n".join(texts))
PYEOF

desc="$tmp/description.md"
python3 -c "$EXTRACT" >"$desc" 2>/dev/null || exit 0
[ -s "$desc" ] || exit 0

out="$(env -u CI_PROJECT_ID -u CI_MERGE_REQUEST_IID -u CI_MERGE_REQUEST_DESCRIPTION \
  bash "$CHECK" --file "$desc" 2>&1)"
rc=$?
if [ "$rc" -eq 1 ]; then
  {
    echo "Blocked by .claude/hooks/pre-mr-followups.sh: this MR description would fail lint:mr-followups."
    echo "$out"
    echo "Name the open issue on the flagged line. If the line describes work already done on this"
    echo "branch (e.g. a completeness-check fix commit), say what happened — 'fixed by commit <sha>"
    echo "on this branch' — instead of 'follow-up'. Use 'followup-ok' only for a line that owes nothing."
  } >&2
  exit 2
fi
exit 0
