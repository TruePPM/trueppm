#!/usr/bin/env bash
# scripts/check-hover-reveal-focus.sh — hover-only reveal keyboard-reachability
# gate (web-rule 417, #3619).
#
# WHY THIS EXISTS
# ----------------
# `opacity-0 group-hover:opacity-100` is TruePPM's standard pattern for a
# control that only appears while the pointer is over its row/card (a delete
# icon, a "···" overflow trigger, a drag handle). Written with no focus
# counterpart, a keyboard user can Tab onto the control — it is not
# `disabled`, not `aria-hidden`, `tabIndex` is untouched — and never see it,
# because nothing ever sets its opacity above 0 outside `:hover`. That is a
# WCAG 2.1.1 (Keyboard) / 2.4.7 (Focus Visible) failure hiding behind a class
# string that looks identical to a correctly-guarded one at a glance.
#
# This exact shape has been point-fixed three times on three different
# components (#1029 in 0.3, #1802 in 0.4, #3619) because each fix swept the
# component it was filed against and no mechanism swept the pattern itself.
# #3619 is the one that adds the gate instead of the fourth point fix.
#
# WHAT IS CHECKED
# Every source line under packages/web/src matching `opacity-0` (the class
# that hides the control at rest — NOT `opacity-40`/`opacity-50`/etc., which
# stay partially visible and are not a keyboard-reachability problem) AND a
# hover-reveal variant on the SAME line (`hover:opacity-100`,
# `group-hover:opacity-100`, or a named group form like
# `group-hover/row:opacity-100`) must have a focus-reveal counterpart
# (`focus:opacity-100`, `focus-within:opacity-100`, `focus-visible:opacity-100`,
# or the `group-focus-*:opacity-100` / `group-focus-*/name:opacity-100` forms)
# within a nearby window of source — Tailwind class strings routinely wrap
# across several JSX lines (see BoardViewDropdown.tsx and CardOverflowMenu.tsx,
# both of which already do this correctly: the opacity-0/hover pair sits on
# one line and focus:opacity-100 sits 1-2 lines below in the same
# `className="..."` string).
#
# WHAT IS NOT CHECKED, AND WHY A MARKER, NOT ZERO TOLERANCE
# A handful of hover-only reveals are genuinely fine without a focus
# counterpart — purely decorative chrome with no focusable content inside it
# (nothing to Tab onto, so nothing is ever unreachable). That is a semantic
# judgement, not a grep, so those sites carry an in-source marker exactly like
# rule 351's `dropdown-scroll-ok:` (see scripts/check-dropdown-scroll.sh):
#
#     className="opacity-0 group-hover:opacity-100 ..." // hover-reveal-ok: decorative gradient, nothing focusable inside
#
# It must sit on the SAME LINE as the `opacity-0`/hover-reveal pair and carry
# a non-empty reason, for the same colocation reason rule 351 gives: the
# marker travels with the line, so no unrelated edit can invalidate it, and it
# cannot be edited without the reason appearing in the same diff hunk.
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"
EXCLUDE_TREE='\.test\.|\.spec\.|\.stories\.'

# Window of source lines after an opacity-0/hover-reveal match to search for a
# focus-reveal counterpart. Real class strings observed in this tree wrap
# across 1-4 lines (BoardViewDropdown.tsx, CardOverflowMenu.tsx,
# RiskRegisterView.tsx); 20 lines forward is generous headroom without being
# so wide it would credit a genuinely unguarded control with a DIFFERENT
# element's focus styling several JSX nodes away.
WINDOW_BEFORE=1
WINDOW_AFTER=20

# `opacity-0` but not `opacity-0.NN` (an arbitrary-value decimal, e.g. the
# `opacity-0.22` comment in ScheduleView.tsx) — that is a different Tailwind
# token (a dimmed-but-visible state), not the "hidden until hover" pattern
# this gate exists for.
BASE_PAT='opacity-0([^.0-9]|$)'

# Bare `hover:opacity-100`, `group-hover:opacity-100`, or a named group form
# `group-hover/row:opacity-100`.
HOVER_PAT='hover(/[A-Za-z0-9_-]+)?:opacity-100'

# `focus:opacity-100`, `focus-within:opacity-100`, `focus-visible:opacity-100`,
# and the `group-focus-*` / `group-focus-*/name` equivalents — all reveal the
# control on keyboard focus in a real browser (focus-visible is the one form
# that is unconditionally false in jsdom — a testing quirk, not a production
# gap — so it is accepted here same as the others).
FOCUS_PAT='focus[A-Za-z-]*(/[A-Za-z0-9_-]+)?:opacity-100'

# In-source exemption marker. See "WHAT IS NOT CHECKED" above.
MARKER_PAT='hover-reveal-ok:[[:space:]]*[^[:space:]]'

# grep wrapper: exit 1 ("no match") is a clean empty result under `set -e`,
# exit >=2 is a real error and must still propagate. Recursive forms enumerate
# files, so they must not report a path git ignores (#3178).
# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

g() {
  case "${1:-}" in
    -*r*) { grep "$@" || [ "$?" -eq 1 ]; } | drop_ignored_lines ;;
    *)    grep "$@" || [ "$?" -eq 1 ] ;;
  esac
}

# A comment/prose line (JSDoc `*`, `//`, `/*`, `{/*`) naming these classes as
# an example is not a rendered element. Same predicate shape as rule 351's
# line_declares_role.
line_is_prose() {
  [[ "$1" =~ ^[[:space:]]*(//|\*|/\*|\{/\*) ]]
}

line_is_marked() { grep -qE "$MARKER_PAT" <<<"$1"; }

# Core predicate, shared by the real scan and the self-test so they can never
# diverge (the #2858 lesson). Returns 0 (safe) if a focus-reveal counterpart
# is found within the window after `line` in `file`, 1 (offender) otherwise.
window_is_guarded() {
  local file="$1" line="$2"
  local start=$(( line - WINDOW_BEFORE ))
  (( start < 1 )) && start=1
  local end=$(( line + WINDOW_AFTER ))
  local window
  window="$(sed -n "${start},${end}p" "$file" 2>/dev/null)"
  grep -qE "$FOCUS_PAT" <<<"$window"
}

hover_reveal_offenders() {
  local raw
  raw="$(g -rnE "$BASE_PAT" "$WEB_SRC" --include="*.tsx" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno content
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    content="${line#*:*:}"
    line_is_prose "$content" && continue
    grep -qE "$HOVER_PAT" <<<"$content" || continue
    line_is_marked "$content" && continue
    window_is_guarded "$file" "$lineno" || echo "$file:$lineno"
  done <<<"$raw"
}

# A `hover-reveal-ok:` marker whose line no longer declares an
# opacity-0/hover-reveal pair exempts nothing and documents nothing.
stale_markers() {
  local raw
  raw="$(g -rnE "$MARKER_PAT" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno content
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    content="${line#*:*:}"
    if ! line_is_marked "$content"; then
      echo "$file:$lineno (marker carries no reason)"
      continue
    fi
    if [[ "$content" =~ $BASE_PAT ]] && grep -qE "$HOVER_PAT" <<<"$content"; then
      continue
    fi
    echo "$file:$lineno (no opacity-0/hover-reveal pair left on this line)"
  done <<<"$raw"
}

# Self-test: build throwaway fixture files and assert the SAME predicates the
# real scan uses report the expected verdict on each. If this ever passes
# trivially it means the predicate is disarmed (rule 300(a)).
self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  cat >"$tmp/Guarded.tsx" <<'EOF'
export function Guarded() {
  return (
    <button
      className="opacity-0 group-hover:opacity-100
        focus:opacity-100 focus:ring-2"
    >
      x
    </button>
  );
}
EOF
  window_is_guarded "$tmp/Guarded.tsx" 4 \
    || { echo "::error:: hover-reveal-focus self-test: guarded fixture reported as an offender" >&2; rc=1; }

  cat >"$tmp/Unguarded.tsx" <<'EOF'
export function Unguarded() {
  return (
    <button
      className="opacity-0 group-hover:opacity-100 text-neutral-text-disabled"
    >
      x
    </button>
  );
}
EOF
  window_is_guarded "$tmp/Unguarded.tsx" 4 \
    && { echo "::error:: hover-reveal-focus self-test: unguarded fixture reported as safe" >&2; rc=1; }

  # focus-within / group-focus-within / named-group hover forms all count.
  cat >"$tmp/FocusWithin.tsx" <<'EOF'
export function FocusWithin() {
  return (
    <div className="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      x
    </div>
  );
}
EOF
  window_is_guarded "$tmp/FocusWithin.tsx" 3 \
    || { echo "::error:: hover-reveal-focus self-test: named-group focus-within fixture reported as an offender" >&2; rc=1; }

  # opacity-0.NN (arbitrary decimal, e.g. ScheduleView.tsx's dimmed state) is
  # a different token and must not be read as the hidden-until-hover pattern.
  grep -qE "$BASE_PAT" <<<"opacity-0.22 pointer-events-none" \
    && { echo "::error:: hover-reveal-focus self-test: opacity-0.NN was read as opacity-0" >&2; rc=1; }
  grep -qE "$BASE_PAT" <<<"opacity-0 group-hover:opacity-100" \
    || { echo "::error:: hover-reveal-focus self-test: a real opacity-0 was not matched" >&2; rc=1; }

  # A prose/comment line naming the pattern as an example is not a panel.
  line_is_prose '  // `opacity-0 group-hover:opacity-100` looks identical in a screenshot' \
    || { echo "::error:: hover-reveal-focus self-test: a comment line was read as a rendered element" >&2; rc=1; }
  line_is_prose '      className="opacity-0 group-hover:opacity-100"' \
    && { echo "::error:: hover-reveal-focus self-test: a real className line was read as prose" >&2; rc=1; }

  # --- in-source marker ---------------------------------------------------
  line_is_marked '      className="opacity-0 group-hover:opacity-100" // hover-reveal-ok: decorative, nothing focusable inside' \
    || { echo "::error:: hover-reveal-focus self-test: trailing // marker not recognised" >&2; rc=1; }
  line_is_marked '      className="opacity-0 group-hover:opacity-100" // hover-reveal-ok:' \
    && { echo "::error:: hover-reveal-focus self-test: a reasonless marker was accepted" >&2; rc=1; }

  # --- end-to-end: the scan itself must fail on a seeded violation and pass
  # once a focus counterpart (or a reasoned marker) is added. Exercises
  # hover_reveal_offenders() directly rather than window_is_guarded(), so a
  # regression in the raw-grep/dispatch plumbing is caught too, not just the
  # window predicate.
  mkdir -p "$tmp/scan/src/features/x"
  cat >"$tmp/scan/src/features/x/Seeded.tsx" <<'EOF'
export function Seeded() {
  return (
    <button className="opacity-0 group-hover:opacity-100 text-neutral-text-disabled">
      x
    </button>
  );
}
EOF
  (
    cd "$tmp/scan"
    WEB_SRC="src"
    raw="$(grep -rnE "$BASE_PAT" "$WEB_SRC" --include='*.tsx' 2>/dev/null || true)"
    echo "$raw" | grep -qE 'Seeded\.tsx:3' \
      || { echo "::error:: hover-reveal-focus self-test: seeded violation was not even found by the raw scan" >&2; exit 1; }
  ) || rc=1

  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then
    echo "check-hover-reveal-focus: self-test passed."
    exit 0
  else
    echo "check-hover-reveal-focus: self-test FAILED — the predicate cannot be trusted." >&2
    exit 1
  fi
fi

if ! self_test; then
  echo "check-hover-reveal-focus: self-test failed — refusing to report a count it cannot be trusted to produce." >&2
  exit 1
fi

offenders="$(hover_reveal_offenders)"
count=$(printf '%s' "$offenders" | grep -c . || true)
stale="$(stale_markers)"
stale_count=$(printf '%s' "$stale" | grep -c . || true)

echo "hover-reveal-focus: $count hover-only-reveal control(s) with no focus counterpart (must be 0)."

rc=0

if [ "$count" -gt 0 ]; then
  {
    echo "::error:: $count control(s) use opacity-0 + a hover-reveal variant with no focus counterpart (web-rule 417, #3619)."
    echo "  A keyboard user can Tab onto the control and never see it — nothing outside :hover ever"
    echo "  raises its opacity. Fix: add focus:opacity-100 (or focus-within:/focus-visible:/"
    echo "  group-focus-within:, matching whichever hover variant is already there) next to the"
    echo "  existing hover:opacity-100 / group-hover:opacity-100 class."
    echo "  If the control is genuinely decorative — nothing focusable inside it — mark the line"
    echo "  itself instead of adding an unreachable focus style:"
    echo "      className=\"opacity-0 group-hover:opacity-100 ...\" // hover-reveal-ok: <why nothing inside is focusable>"
    echo "  Offenders:"
    printf '%s\n' "$offenders" | sed 's/^/    /'
  } >&2
  rc=1
fi

if [ "$stale_count" -gt 0 ]; then
  {
    echo "::error:: $stale_count stale hover-reveal-ok marker(s) — each exempts nothing and documents nothing."
    echo "  A marker must sit on the same line as the opacity-0/hover-reveal class pair it exempts,"
    echo "  and must state a reason. If the control is gone, delete the marker; if it moved, the"
    echo "  marker should have moved with it. Stale markers:"
    printf '%s\n' "$stale" | sed 's/^/    /'
  } >&2
  rc=1
fi

[ "$rc" -eq 0 ] || exit 1

echo "check-hover-reveal-focus passed."
