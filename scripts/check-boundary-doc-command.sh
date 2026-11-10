#!/usr/bin/env bash
# Fail if a doc INSTRUCTS the reader to verify the Apache 2.0 boundary with the
# naive grep, which reports the invariant as broken on a clean tree (#2859).
#
# #2603 replaced `grep -r "trueppm_enterprise" packages/` with an import-syntax
# gate precisely because a string grep cannot distinguish prose from a dependency:
# the tree legitimately names the package in extension-point docstrings and ADR
# pointers, so that command returns prose-only hits on a clean tree.
# What #2603 did not do was update the documents telling people to run it — so
# CONTRIBUTING.md, two agent skills, and two published website pages each handed
# a contributor a command that reports the project's sacred invariant as violated.
#
# Scope: surfaces where the command is an INSTRUCTION TO RUN.
#
#   CONTRIBUTING.md, .claude/skills/, docs/design/,
#   packages/website/src/content/docs/, packages/*/CLAUDE.md, CLAUDE.md
#
# docs/adr/ is deliberately EXEMPT. An ADR is a point-in-time decision record, and
# its "OSS or Enterprise: OSS (grep returns zero)" consequence lines are assertions
# about what was true when the decision was made, not instructions to a reader —
# the same carve-out the version-status gate gives ADRs. ~40 of them say this; the
# handful that are genuinely instructional were corrected by hand in #2859.
#
# A line that mentions the naive grep in order to say it is WRONG is allowed; that
# is the correction, not the defect.
#
# Usage:
#   scripts/check-boundary-doc-command.sh [ROOT]     ROOT defaults to `.`; the
#       script cds there and resolves SEARCH_PATHS relative to it. The argument
#       exists so --self-test can run this same script against fixture trees
#       rather than keeping a second copy of the patterns.
#   scripts/check-boundary-doc-command.sh --self-test
#
# Exit codes:
#   0  no doc instructs the naive grep
#   1  at least one does
#   2  invocation error

set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  # Prove the gate can still FAIL, in the same job it runs in (#3195). A gate
  # that cannot detect anything is indistinguishable from one that works —
  # `boundary:imports` passed a real enterprise import for its entire life
  # because the CI image's grep rejected an option and the error was swallowed
  # (#3172). This gate shares that job and that image.
  #
  # Every case runs the REAL script against a fixture root, so there is no
  # second copy of PATTERN / EXONERATING / SEARCH_PATHS to drift. Both
  # directions are asserted: a happy-path-only self-test proves nothing.
  st_self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  st_tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now, not at trap time
  trap "rm -rf '$st_tmp'" EXIT
  st_rc=0
  st_probe() { # <name> <expect-pass|expect-fail> <dir>
    # Exit 2 is an invocation error, NOT a detection. Accepting it as a rejection
    # would let a mistyped fixture path stand in for the gate working.
    local st_out st_code
    st_out=$(bash "$st_self" "$3" 2>&1) && st_code=0 || st_code=$?
    case "$st_code" in
      0) if [ "$2" = "expect-pass" ]; then echo "SELF-TEST OK: $1 accepted."
         else echo "SELF-TEST FAILED: $1 was accepted and must not be." >&2; st_rc=1; fi ;;
      1) if [ "$2" = "expect-fail" ]; then echo "SELF-TEST OK: $1 correctly rejected."
         else echo "SELF-TEST FAILED: $1 was rejected and must not be." >&2; st_rc=1; fi ;;
      *) echo "SELF-TEST FAILED: $1 exited $st_code (invocation error, not a verdict):" >&2
         printf '%s\n' "$st_out" | sed 's/^/    /' >&2; st_rc=1 ;;
    esac
  }
  # Single-quoted throughout: the backticks are literal Markdown code spans as a
  # doc would write them, not command substitution (shellcheck SC2016 is wrong
  # here, and "fixing" it would execute the very grep this gate forbids).
  # The defect, verbatim as a doc would write it.
  st_bad='Verify the boundary with `grep -r "trueppm_enterprise" packages/` before pushing.'
  # The correct instruction the gate must never fire on.
  st_good='Verify the boundary with `make enterprise-boundary-check` before pushing.'

  # --- accept: the CORRECT instruction ------------------------------------
  d="$st_tmp/clean"; mkdir -p "$d"
  printf '%s\n' "$st_good" > "$d/CONTRIBUTING.md"
  st_probe "correct instruction (make enterprise-boundary-check)" expect-pass "$d"

  # --- reject: one case per path-discovery mechanism -----------------------
  # 1. a literal path in SEARCH_PATHS
  d="$st_tmp/contributing"; mkdir -p "$d"
  printf '%s\n' "$st_bad" > "$d/CONTRIBUTING.md"
  st_probe "CONTRIBUTING.md instructing the naive grep" expect-fail "$d"

  # 2. a directory in SEARCH_PATHS, matched recursively
  d="$st_tmp/website"; mkdir -p "$d/packages/website/src/content/docs/architecture"
  printf '%s\n' "$st_bad" \
    > "$d/packages/website/src/content/docs/architecture/boundary.md"
  st_probe "published website page instructing the naive grep" expect-fail "$d"

  d="$st_tmp/skill"; mkdir -p "$d/.claude/skills/enterprise-check"
  printf '%s\n' "$st_bad" > "$d/.claude/skills/enterprise-check/SKILL.md"
  st_probe "agent skill instructing the naive grep" expect-fail "$d"

  # 3. the `find packages -maxdepth 2 -name CLAUDE.md` branch, which contributes
  #    paths that appear in no literal list — neuter the find and this is the
  #    only case that notices.
  d="$st_tmp/pkgclaude"; mkdir -p "$d/packages/api"
  printf '%s\n' "$st_bad" > "$d/packages/api/CLAUDE.md"
  st_probe "per-package CLAUDE.md instructing the naive grep" expect-fail "$d"

  # --- accept: the documented carve-outs ----------------------------------
  # Naming the package in prose is legal and the tree relies on it; a gate that
  # fires here becomes noisy enough to get disabled, which is how the
  # protection is really lost.
  d="$st_tmp/prose"; mkdir -p "$d/packages/website/src/content/docs/architecture"
  printf 'The proprietary half lives in ``trueppm_enterprise``; OSS never imports it.\n' \
    > "$d/packages/website/src/content/docs/architecture/prose.md"
  st_probe "package named in prose, no command" expect-pass "$d"

  # Quoting the command in order to say it is wrong is the correction, not the
  # defect. This file carries the exact defect string plus the negation.
  d="$st_tmp/corrective"; mkdir -p "$d"
  printf 'A plain `grep -r "trueppm_enterprise" packages/` is **not** the check.\n' \
    > "$d/CONTRIBUTING.md"
  st_probe "corrective mention (\"is **not** the check\")" expect-pass "$d"

  # docs/adr/ is deliberately out of scope: an ADR consequence line is an
  # assertion about a past decision, not an instruction. Paired with a clean
  # CONTRIBUTING.md so the fixture is not vacuously empty of searched paths.
  d="$st_tmp/adr"; mkdir -p "$d/docs/adr"
  printf '%s\n' "$st_good" > "$d/CONTRIBUTING.md"
  printf '%s\n' "OSS or Enterprise: OSS — \`grep -r \"trueppm_enterprise\" packages/\` returns zero." \
    > "$d/docs/adr/0001-example.md"
  st_probe "docs/adr/ consequence line (exempt tree)" expect-pass "$d"

  # --- the success message this gate's own advice quotes is the real one ---
  # #3799: five surfaces, this script's fixture among them, kept quoting the
  # pre-#2859 message after the boundary gate changed it, and nothing compared
  # the documented output to the real output. Derive the real message by running
  # the boundary gate on an empty `packages/` tree (no second literal to drift),
  # then require the "Use instead:" advice in this file to quote exactly that.
  st_real_dir="$st_tmp/realmsg"; mkdir -p "$st_real_dir/packages"
  st_real=$(cd "$st_real_dir" && bash "$(dirname "$st_self")/check-enterprise-imports.sh" 2>&1 || true)
  st_quoted=$(sed -n 's/^  make enterprise-boundary-check   # //p' "$st_self" | head -n 1)
  if [ -z "$st_real" ] || [ "$st_real" != "$st_quoted" ]; then
    echo "SELF-TEST FAILED: the advice quotes '$st_quoted' but check-enterprise-imports.sh prints '$st_real'." >&2
    st_rc=1
  else
    echo "SELF-TEST OK: the quoted success message matches check-enterprise-imports.sh."
  fi

  # --- the transcript check itself can fail, and passes on a current quote ---
  # Runs the REAL script against a temp root holding one surface (never the real
  # docs). A stale quote must be rejected; the real message must be accepted; a
  # root with none of the surfaces must not error.
  d="$st_tmp/tx-stale"; mkdir -p "$d"
  printf 'make enterprise-boundary-check   # OK: no trueppm-enterprise imports in packages.\n' > "$d/CONTRIBUTING.md"
  st_probe "stale quoted success message" expect-fail "$d"
  d="$st_tmp/tx-current"; mkdir -p "$d"
  printf 'make enterprise-boundary-check   # %s\n' "$st_real" > "$d/CONTRIBUTING.md"
  st_probe "current quoted success message" expect-pass "$d"
  d="$st_tmp/tx-must-print"; mkdir -p "$d/.claude/skills/pre-release"
  printf 'Run it; must print "OK: no trueppm-enterprise imports at all." then stop.\n' > "$d/.claude/skills/pre-release/SKILL.md"
  st_probe "stale 'must print' quote" expect-fail "$d"
  d="$st_tmp/tx-none"; mkdir -p "$d"
  st_probe "no transcript surfaces present" expect-pass "$d"

  [ "$st_rc" -eq 0 ] && echo "SELF-TEST: all cases passed."
  exit "$st_rc"
fi

cd "${1:-.}" || { echo "ERROR: cannot cd to '${1:-.}'" >&2; exit 2; }

SEARCH_PATHS=(
  CONTRIBUTING.md
  CLAUDE.md
  .claude/skills
  docs/design
  packages/website/src/content/docs
)
# Per-package CLAUDE.md files, if any exist.
while IFS= read -r f; do SEARCH_PATHS+=("$f"); done < <(
  find packages -maxdepth 2 -name CLAUDE.md 2>/dev/null || true
)

PATTERN='grep -r "trueppm_enterprise" packages/'

# A mention that exists to correct the command is fine. Matched on the negation
# alone rather than "is not the check", because the corrective sentence often wraps
# and only "… is NOT the" lands on the line grep reports.
EXONERATING='is \*\*not\*\* the|is NOT the|previously named|would report|reports the invariant as broken'

hits=""
for path in "${SEARCH_PATHS[@]}"; do
  [ -e "$path" ] || continue
  found=$(grep -rn --fixed-strings "$PATTERN" "$path" 2>/dev/null || true)
  [ -n "$found" ] || continue
  found=$(echo "$found" | grep -vE "$EXONERATING" || true)
  [ -n "$found" ] && hits="${hits}${found}"$'\n'
done

hits=$(echo "$hits" | grep -v '^$' || true)

if [ -n "$hits" ]; then
  echo ""
  echo "STALE BOUNDARY COMMAND: these docs tell a reader to run the naive grep:"
  echo ""
  echo "$hits" | sed 's/^/  /'
  cat <<'MSG'

That command returns prose-only hits on a clean tree — legitimate prose in extension-point
docstrings and ADR pointers — so it reports the Apache 2.0 boundary as violated when
it is intact. It was replaced by an import-syntax gate in #2603.

Use instead:

  make enterprise-boundary-check   # OK: no trueppm-enterprise imports or dependency entries in packages.

(CI runs the same check as `boundary:imports`; it is also part of `make pre-push`.)

If you are deliberately quoting the old command in order to say it is wrong, phrase
it so this gate can tell — e.g. "a plain `grep …` is **not** the check".
MSG
  exit 1
fi

# --- the documented success message must be the real one (#3799) -----------
# The surfaces below quote check-enterprise-imports.sh's success line. Derive
# the real line by running that gate on an empty packages/ tree, so the literal
# lives only in that script. Only lines that quote an "OK: no trueppm-enterprise"
# message are compared; a surface file that is absent is skipped.
gate_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-enterprise-imports.sh"
real_dir=$(mktemp -d); mkdir -p "$real_dir/packages"
real_msg=$(cd "$real_dir" && bash "$gate_script" 2>&1 || true)
rm -rf "$real_dir"
if [ -z "$real_msg" ]; then
  echo "ERROR: could not derive the real message from check-enterprise-imports.sh" >&2
  exit 2
fi
TRANSCRIPT_SURFACES=(
  CONTRIBUTING.md
  packages/website/src/content/docs/contributing/guide.md
  packages/website/src/content/docs/architecture/overview.md
  docs/adr/0038-terminology-glossary.md
  .claude/skills/enterprise-check/SKILL.md
  .claude/skills/pre-release/SKILL.md
)
stale=""
for f in "${TRANSCRIPT_SURFACES[@]}"; do
  [ -f "$f" ] || continue
  # Join each file's wrapped lines so a quote broken across lines is compared whole.
  while IFS=: read -r ln rest; do
    quoted=$(printf '%s' "$rest" | grep -o 'OK: no trueppm-enterprise[^"`]*' | sed -n 1p || true)
    [ -n "$quoted" ] || continue
    [ "$quoted" = "$real_msg" ] && continue
    # A quote wrapped across lines ends the line without closing: compare as a
    # prefix, but only when nothing follows the matched text on that line.
    case "$rest" in *"$quoted") case "$real_msg" in "$quoted"*) continue ;; esac ;; esac
    stale="${stale}${f}:${ln}: quotes '${quoted}'"$'\n'
  done < <(grep -n 'OK: no trueppm-enterprise' "$f" || true)
done
if [ -n "$stale" ]; then
  echo "STALE BOUNDARY TRANSCRIPT: these surfaces quote a success message that differs from"
  echo "what check-enterprise-imports.sh prints ('$real_msg'):"
  printf '%s' "$stale" | sed 's/^/  /'
  exit 1
fi

echo "OK: no doc instructs the stale boundary grep."
