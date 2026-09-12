#!/usr/bin/env bash
# scripts/check-anchored-popover-population.sh — ratchet the count of hand-rolled
# in-flow `absolute`-anchored panels in packages/web/src (web rule 260, #3664).
#
# WHY THIS EXISTS
# ----------------
# #3663 fixed one instance of a recurring class: a floating panel positioned as
# an in-flow `absolute` child instead of routed through `useAnchoredPopover`
# (which portals to `document.body`, positions `fixed`, and clamps into the
# viewport — see the hook's own header for the four things it owns). An in-flow
# `absolute` panel inherits every `overflow-hidden`/`overflow-y-auto` ancestor's
# clip, and `z-index` cannot rescue it — only leaving the subtree can.
#
# The #3664 sweep found the SAME class sitting six more times, all inside the
# outline's virtualized scroll wrapper (`TaskListPanel.tsx`, `overflow-x-hidden`
# `overflow-y-auto` with `contain: strict`) at a combined denominator of 40
# hand-rolled panels against 11 already on the hook. A horizontal clip is not
# mechanizable — whether a panel overruns its clipping ancestor is a DOM
# question about ancestor widths a static rule cannot answer without guessing
# and misfiring. What IS mechanizable is the population: a ratchet that can only
# go down converts "did the author pick the right anchor", which nothing can
# check, into "the author either used the hook or the count would have grown".
#
# WHAT COUNTS AS A HAND-ROLLED ANCHORED PANEL
# A JSX element is counted when, within a few lines of an `absolute` class, the
# window ALSO carries:
#   1. an explicit vertical open-direction offset — `top-full` / `bottom-full`
#      (the idiom every panel in this tree that opens directly below/above its
#      trigger uses), or an explicit "100% + gap" calc (`top-[calc(100%+...)]`),
#      or a two-digit-or-larger fixed `top-N` (a below-header gap, as
#      `RiskRegisterHeader`'s `top-11` or `ScheduleDependencyPicker`'s `top-7`) —
#   AND
#   2. a panel-chrome signal — `rounded-card`, an explicit pixel width
#      (`w-[Npx]` / `min-w-[Npx]` / `max-w-[...`), or one of this tree's fixed
#      Tailwind panel widths (`w-56`/`w-64`/`w-72`/`w-80`).
# (2) is what keeps this from flagging every cosmetically `absolute` badge, dot,
# caret, or gradient overlay in the tree — none of those carry panel chrome.
# A file that already imports `useAnchoredPopover` is never counted: its panel
# is positioned via the hook's `popoverStyle` (inline `position: fixed`), not a
# hand-rolled `absolute` className, even where residual chrome classes remain.
#
# NOT A CLAIM OF EXHAUSTIVE RECALL. This is a ratchet on a heuristic, not a
# proof. It will under-count a panel styled with a pattern this list has not
# seen yet, exactly as the dropdown-scroll gate's role-based scan does for
# `role="menu"`. Its job is not to find every clip — #3663 and #3664 were both
# found by hand — its job is to keep the known population from growing back
# once found. Extend the pattern (with a comment saying what it now catches)
# when a real hand-rolled panel slips past it in review.
#
# HOW A CONVERSION LOWERS THE BASELINE
# Moving a call site onto `useAnchoredPopover` drops its hand-rolled `absolute`
# className entirely (the hook renders a portaled `position: fixed` panel from
# `popoverStyle`), so the count drops on its own. Lower BASELINE by the number
# of sites you converted in the same change — never leave it higher than the
# tree actually contains, or the ratchet stops meaning anything.
#
# Usage:  scripts/check-anchored-popover-population.sh [--self-test]
# Exit:   0 count <= BASELINE (or --self-test passes) · 1 otherwise
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"
EXCLUDE_TREE='\.test\.|\.spec\.|\.stories\.'

# Set at #3664: 40 hand-rolled panels existed before that fix; it moved 6 onto
# the hook (NameAutocomplete, OwnerAutocomplete, TokenAutocomplete, SprintPrompt,
# MilestoneDatePopover, and TaskListRow's guardrail-notice wrapper), and this
# script's own heuristic — which does not recall every one of the 40 the manual
# sweep found by reading each component — counts 26 remaining against the tree
# at that point. The floor is this script's own count, not the sweep's: a
# heuristic ratchets against what it can see, or a future correct conversion
# that this pattern happens not to recognize would false-fail the gate forever.
BASELINE=26

VERTICAL_OFFSET_PAT='\btop-full\b|\bbottom-full\b|top-\[calc\(100%|top-1[0-9]\b|top-[7-9]\b'
PANEL_CHROME_PAT='rounded-card|w-\[[0-9]+px\]|min-w-\[[0-9]+px\]|\bw-(56|64|72|80)\b|\bmax-w-\['

WINDOW_AFTER=4

# shellcheck source-path=SCRIPTDIR source=lib/git-ignored.sh
. "$(cd "$(dirname "$0")" && pwd)/lib/git-ignored.sh"

g() {
  case "${1:-}" in
    -*r*) { grep "$@" || [ "$?" -eq 1 ]; } | drop_ignored_lines ;;
    *)    grep "$@" || [ "$?" -eq 1 ] ;;
  esac
}

# Core predicate, shared by the real scan and the self-test (the #2858 lesson:
# a check only the scan exercises can silently stop matching and nothing
# notices). Returns 0 (is a hand-rolled anchored panel) for the `absolute` match
# at `file:line`, 1 otherwise.
is_anchored_panel() {
  local file="$1" line="$2" content="$3"
  # A comment naming `absolute` is prose, not a rendered class.
  [[ "$content" =~ ^[[:space:]]*(//|\*|/\*|\{/\*) ]] && return 1
  # A file already on the hook positions via popoverStyle, not this className.
  grep -qF 'useAnchoredPopover' "$file" 2>/dev/null && return 1
  local start=$(( line - 1 ))
  (( start < 1 )) && start=1
  local end=$(( line + WINDOW_AFTER ))
  local window
  window="$(sed -n "${start},${end}p" "$file" 2>/dev/null)"
  grep -qE "$VERTICAL_OFFSET_PAT" <<<"$window" || return 1
  grep -qE "$PANEL_CHROME_PAT" <<<"$window" || return 1
  return 0
}

anchored_panel_sites() {
  local raw
  raw="$(g -rnE '\babsolute\b' "$WEB_SRC" --include="*.tsx" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno content
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    content="${line#*:*:}"
    if is_anchored_panel "$file" "$lineno" "$content"; then
      echo "$file:$lineno"
    fi
  done <<<"$raw"
  return 0
}

# Self-test: a hand-rolled panel (offender), a hook consumer with the same
# residual chrome text elsewhere in the file (must NOT count), and a cosmetic
# absolutely-positioned badge with a vertical offset but no panel chrome (must
# NOT count) — the false-positive this gate exists not to produce.
self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  cat >"$tmp/HandRolled.tsx" <<'EOF'
export function HandRolled() {
  return (
    <ul
      role="listbox"
      className="absolute top-full left-0 z-50 w-[280px] mt-0.5 rounded-card border border-chrome-border
        bg-chrome-surface-raised overflow-hidden"
    >
      <li role="option">One</li>
    </ul>
  );
}
EOF
  is_anchored_panel "$tmp/HandRolled.tsx" 5 '      className="absolute top-full left-0 z-50 w-[280px] mt-0.5 rounded-card border border-chrome-border' \
    || { echo "::error:: anchored-popover self-test: hand-rolled fixture not detected" >&2; rc=1; }

  cat >"$tmp/HookConsumer.tsx" <<'EOF'
import { useAnchoredPopover } from '@/hooks/useAnchoredPopover';
export function HookConsumer() {
  const { popoverStyle, popoverRef } = useAnchoredPopover({ open: true, width: 280, estimatedHeight: 200 });
  return (
    open &&
    popoverStyle &&
    createPortal(
      <div ref={popoverRef} style={popoverStyle} className="absolute top-full left-0 rounded-card w-[280px]">
        old residual chrome text left behind by a partial refactor
      </div>,
      document.body,
    )
  );
}
EOF
  if is_anchored_panel "$tmp/HookConsumer.tsx" 7 '      <div ref={popoverRef} style={popoverStyle} className="absolute top-full left-0 rounded-card w-[280px]">'; then
    echo "::error:: anchored-popover self-test: hook-consumer fixture counted as hand-rolled" >&2
    rc=1
  fi

  cat >"$tmp/Badge.tsx" <<'EOF'
export function Badge() {
  return <span className="absolute top-full -translate-y-1/2 h-2 w-2 rounded-full bg-brand-primary" />;
}
EOF
  if is_anchored_panel "$tmp/Badge.tsx" 2 '  return <span className="absolute top-full -translate-y-1/2 h-2 w-2 rounded-full bg-brand-primary" />;'; then
    echo "::error:: anchored-popover self-test: cosmetic badge (no panel chrome) counted as a panel" >&2
    rc=1
  fi

  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then
    echo "check-anchored-popover-population: self-test passed."
    exit 0
  else
    echo "check-anchored-popover-population: self-test FAILED — the predicate cannot be trusted." >&2
    exit 1
  fi
fi

if ! self_test; then
  echo "check-anchored-popover-population: self-test failed — refusing to report a count it cannot be trusted to produce." >&2
  exit 1
fi

sites="$(anchored_panel_sites)"
count=$(printf '%s' "$sites" | grep -c . || true)

echo "anchored-popover-population: $count hand-rolled absolute-anchored panel(s) (must be <= $BASELINE)."

if [ "$count" -gt "$BASELINE" ]; then
  {
    echo "::error:: $count hand-rolled absolute-anchored panel(s) exceed the ratchet baseline of $BASELINE (web rule 260, #3664)."
    echo "  A NEW in-flow \`absolute\` panel inherits any overflow-clipping ancestor's clip, and z-index"
    echo "  cannot rescue it — only leaving the subtree can. Route it through useAnchoredPopover"
    echo "  (packages/web/src/hooks/useAnchoredPopover.ts) instead of hand-rolling top-full/bottom-full"
    echo "  positioning. If this count DROPPED because you converted sites onto the hook, lower BASELINE"
    echo "  in this script to match — the ratchet only works while it tracks the real count. Sites:"
    printf '%s\n' "$sites" | sed 's/^/    /'
  } >&2
  exit 1
fi

echo "check-anchored-popover-population passed."
