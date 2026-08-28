#!/usr/bin/env bash
# scripts/check-dropdown-scroll.sh — floating menu/listbox scroll-safety gate (web-rule 351, #3109).
#
# WHY THIS EXISTS
# ----------------
# The Schedule "Display" dropdown (`ScheduleDisplayMenu.tsx`) rendered its panel
# as a plain `absolute` `<div>` with no `max-height` and no `overflow-y-auto`. On
# a viewport shorter than the panel's content — a laptop at 100% zoom, a small
# external display — the bottom options rendered off the bottom of the screen
# with nothing to scroll them into view: not clipped, not scrollable, simply
# unreachable (#3109). An audit of every floating popover in the tree found this
# was not a single instance: roughly a dozen more `role="menu"` / `role="listbox"`
# panels had the identical gap, because no shared primitive owned vertical
# viewport-collision handling (`useAnchoredPopover` computes horizontal clamp and
# flip-above but, before #3109, never exposed a `maxHeight`).
#
# WHAT IS CHECKED
# Every `role="menu"` / `role="listbox"` JSX occurrence in packages/web/src (that
# is not a comment, a type/string reference, or in a test/spec/story file) must
# have BOTH of these within a nearby window of source:
#   - an overflow marker:   overflow-y-auto | overflow-auto
#   - a height-guard marker: max-h- (Tailwind) | maxHeight (inline style,
#     including the useAnchoredPopover-derived popoverStyle.maxHeight) |
#     style={popoverStyle} (the hook already supplies maxHeight in that object)
# Without both, a panel that grows past its guess (or is never guessed at all)
# has nothing to keep it on-screen and nothing to scroll it if it doesn't fit.
#
# WHAT IS NOT CHECKED, AND WHY A RATCHET, NOT ZERO TOLERANCE
# A handful of `role="menu"`/`role="listbox"` panels are genuinely safe without a
# local guard — content that is provably small and fixed (2-3 static items), or a
# listbox that is in-flow inside an ancestor that already scrolls (rule 260's
# "escape a clipping ancestor" case run in reverse: the ancestor's own
# `overflow-y-auto` is the guard, not this element's). Which is which is a
# semantic judgement — decidable by a human reading the component, not by grep —
# so those sites are named exclusions below (see EXCLUDE_MATCHES), each with a
# one-line reason, exactly like rule 300(c)'s "separate the sanctioned exception
# from the violation mechanically, or the exception list becomes the hole." Any
# NEW `role="menu"`/`role="listbox"` panel that is not in that list and lacks a
# guard fails the gate; the ratchet's only job is not re-litigating today's
# reviewed exclusions on every future scan.
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"
EXCLUDE_TREE='\.test\.|\.spec\.|\.stories\.'

# Window of source lines around a role="menu"/role="listbox" match to search for
# the overflow marker (and, absent a hook consumer, the height guard too). 3
# lines back covers className-before-role in the same tag (e.g.
# AddCalendarPicker.tsx); 40 lines forward covers role-then-className a few
# lines below (ToolbarOverflowMenu.tsx) as well as a long onKeyDown/aria-*
# attribute block sitting between the two (ProgramCadencePage.tsx's role="menu"
# and its className are 33 lines apart for exactly this reason).
WINDOW_BEFORE=3
WINDOW_AFTER=40

OVERFLOW_PAT='overflow-y-auto|overflow-auto'
HEIGHT_GUARD_PAT='max-h-|maxHeight'

# Named, reviewed exclusions — `file:line` of the role="menu"/role="listbox"
# match itself, one per line, each with the reason inline. Keep line numbers
# current: a file that moves the match should move its entry, not delete it,
# unless the exclusion itself no longer applies (add a guard instead).
EXCLUDE_MATCHES="
$WEB_SRC/features/schedule/QuarterModeControl.tsx:152 # 2-3 fixed radio items, content cannot grow
$WEB_SRC/features/shell/CreateMenu.tsx:127 # small fixed/permission-filtered list
$WEB_SRC/features/shell/NotificationRow.tsx:187 # fixed SNOOZE_PRESETS, never grows
$WEB_SRC/features/risk/register/RiskRegisterHeader.tsx:375 # 2 fixed items (Import/Export CSV)
$WEB_SRC/features/reports/BurnChartChrome.tsx:56 # 2 fixed items (export menu)
$WEB_SRC/features/me/StatusPicker.tsx:74 # fixed short status enum
$WEB_SRC/features/schedule/buildMode/NameAutocomplete.tsx:64 # hard-capped slice(0, MAX_SUGGESTIONS)
$WEB_SRC/features/schedule/buildMode/OwnerAutocomplete.tsx:66 # hard-capped slice(0, MAX_SUGGESTIONS)
$WEB_SRC/features/schedule/buildMode/TokenAutocomplete.tsx:88 # hard-capped slice(0, MAX_SUGGESTIONS)
$WEB_SRC/features/shell/ViewsMenu.tsx:316 # in-flow inside the rail's own overflow-y-auto scroll region (Sidebar.tsx), not a floating panel — verified #3109
$WEB_SRC/features/board/card/CardOverflowMenu.tsx:158 # nested 'Move to…' submenu renders in-flow inside the outer panel's own guard (line 113), not a second scrollable surface
$WEB_SRC/features/schedule/ScheduleAriaOverlay.tsx:551 # sr-only accessibility tree mirroring the Gantt canvas, not a floating menu/listbox
$WEB_SRC/features/roster/RosterList.tsx:44 # in-page list inheriting its ancestor panel's overflow-y-auto (RosterPage.tsx), not a floating dropdown
$WEB_SRC/features/schedule/ScheduleView.tsx:3550 # a document.querySelector CSS selector STRING, not a rendered role= attribute
$WEB_SRC/features/schedule/UnscheduledTaskRow.tsx:378 # grandfathered hand-rolled spec (rule 260); content is 0-2 quick actions + a compact date form, provably bounded
$WEB_SRC/components/filters/MultiSelectFacet.tsx:453 # wraps {body}, which already carries its own overflow-y-auto + maxHeight: LIST_MAX_HEIGHT guard
$WEB_SRC/features/schedule/sections/RelatedLinkPicker.tsx:314 # flex-1 overflow-y-auto inside the picker dialog's own max-h-[520px] flex-col container
$WEB_SRC/features/schedule/sections/RelatedLinkPicker.tsx:469 # same dialog as :314, second (program-scope) results listbox
$WEB_SRC/features/schedule/ScheduleDependencyPicker.tsx:693 # flex-1 overflow-y-auto inside the picker dialog's own max-h-[480px] flex-col container
$WEB_SRC/features/schedule/ScheduleDependencyPicker.tsx:876 # same dialog as :693, second results listbox
$WEB_SRC/features/board/BacklogBand.tsx:364 # outer menu is 2 fixed items; the one growable part (file-under targets) has its own max-h-60 overflow-y-auto nested guard
"

is_excluded() {
  local match="$1"
  local entry
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    local excl_ref="${entry%%#*}"
    excl_ref="$(echo "$excl_ref" | sed 's/[[:space:]]*$//')"
    [ "$excl_ref" = "$match" ] && return 0
  done <<<"$EXCLUDE_MATCHES"
  return 1
}

# Core predicate, shared by the real scan and the self-test so they can never
# diverge (the #2858 lesson: a check that only the scan exercises can silently
# stop matching and nothing notices). Returns 0 (safe) if the window around
# `line` in `file` has an overflow marker AND a height guard, 1 (offender)
# otherwise.
#
# The height guard has two forms: a LOCAL one (max-h-.../maxHeight text inside
# the window — the bespoke-panel fix) and a FILE-LEVEL one (this file calls
# `useAnchoredPopover` and spreads `style={popoverStyle}` somewhere — rule 260's
# hook always derives a dynamic `maxHeight` into that style object, but the JSX
# that spreads it is frequently many lines from the actual scrollable listbox —
# a search input, a long onKeyDown handler, or a chrome row sits between them —
# so a pure line-window would false-positive on every real hook consumer).
# `overflow-y-auto` itself stays window-scoped: THAT has to sit on (or very near)
# the actual scrolling element, wherever the guard comes from.
window_is_guarded() {
  local file="$1" line="$2"
  local start=$(( line - WINDOW_BEFORE ))
  (( start < 1 )) && start=1
  local end=$(( line + WINDOW_AFTER ))
  local window
  window="$(sed -n "${start},${end}p" "$file" 2>/dev/null)"
  grep -qE "$OVERFLOW_PAT" <<<"$window" || return 1

  grep -qE "$HEIGHT_GUARD_PAT" <<<"$window" && return 0
  grep -qF 'useAnchoredPopover' "$file" 2>/dev/null && grep -qF 'style={popoverStyle}' "$file" 2>/dev/null && return 0
  return 1
}

# grep wrapper: exit 1 ("no match") is a clean empty result under `set -e`,
# exit >=2 is a real error and must still propagate.
g() { grep "$@" || [ "$?" -eq 1 ]; }

dropdown_offenders() {
  local raw
  raw="$(g -rnE 'role="menu"|role="listbox"' "$WEB_SRC" --include="*.tsx" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno match
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    # Skip comment/prose lines — a docstring naming `role="menu"` is not a panel.
    local content="${line#*:*:}"
    [[ "$content" =~ ^[[:space:]]*(//|\*|/\*|\{/\*) ]] && continue
    match="$file:$lineno"
    is_excluded "$match" && continue
    window_is_guarded "$file" "$lineno" || echo "$match"
  done <<<"$raw"
}

# Self-test: build two throwaway fixture files and assert the SAME
# window_is_guarded predicate the real scan uses reports the expected verdict on
# each. If this ever passes trivially (e.g. the pattern stops matching either
# fixture) it means the predicate is disarmed — see rule 300(a).
self_test() {
  local tmp rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  cat >"$tmp/Guarded.tsx" <<'EOF'
export function Guarded() {
  return (
    <div
      role="menu"
      className="absolute z-30 max-h-[min(70vh,32rem)] overflow-y-auto rounded-card"
    >
      <button role="menuitem">One</button>
    </div>
  );
}
EOF
  window_is_guarded "$tmp/Guarded.tsx" 4 \
    || { echo "::error:: dropdown-scroll self-test: guarded fixture reported as an offender" >&2; rc=1; }

  cat >"$tmp/Unguarded.tsx" <<'EOF'
export function Unguarded() {
  return (
    <div
      role="menu"
      className="absolute z-30 rounded-card"
    >
      <button role="menuitem">One</button>
    </div>
  );
}
EOF
  window_is_guarded "$tmp/Unguarded.tsx" 4 \
    && { echo "::error:: dropdown-scroll self-test: unguarded fixture reported as safe" >&2; rc=1; }

  # Hook consumer: style={popoverStyle} — which carries a dynamic maxHeight —
  # sits many lines from the actual role="listbox", the way it does in every
  # real useAnchoredPopover call site (search box, keyboard handler, chrome
  # row between the two). Only the LOCAL overflow-y-auto has to be near the
  # role attribute; the height guard is satisfied file-wide.
  cat >"$tmp/HookConsumer.tsx" <<'EOF'
export function HookConsumer() {
  const { triggerRef, popoverRef, popoverStyle } = useAnchoredPopover<
    HTMLButtonElement,
    HTMLDivElement
  >({ open, width: 240, estimatedHeight: 200 });
  return (
    open &&
    popoverStyle &&
    createPortal(
      <div ref={popoverRef} style={popoverStyle} className="rounded-card">
        <input aria-label="Search" />
        <div role="listbox" className="flex-1 min-h-0 overflow-y-auto">
          <button role="option">One</button>
        </div>
      </div>,
      document.body,
    )
  );
}
EOF
  window_is_guarded "$tmp/HookConsumer.tsx" 12 \
    || { echo "::error:: dropdown-scroll self-test: hook-consumer fixture reported as an offender" >&2; rc=1; }

  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then
    echo "check-dropdown-scroll: self-test passed."
    exit 0
  else
    echo "check-dropdown-scroll: self-test FAILED — the predicate cannot be trusted." >&2
    exit 1
  fi
fi

if ! self_test; then
  echo "check-dropdown-scroll: self-test failed — refusing to report a count it cannot be trusted to produce." >&2
  exit 1
fi

offenders="$(dropdown_offenders)"
count=$(printf '%s' "$offenders" | grep -c . || true)

echo "dropdown-scroll: $count unguarded role=\"menu\"/role=\"listbox\" panel(s) (must be 0)."

if [ "$count" -gt 0 ]; then
  {
    echo "::error:: $count floating menu/listbox panel(s) have no overflow-y-auto + height guard (web-rule 351, #3109)."
    echo "  A panel taller than the viewport spills off-screen with nothing to scroll it into view."
    echo "  Fix: add max-h-[min(70vh,<cap>)] overflow-y-auto (bespoke panels), or route through"
    echo "  useAnchoredPopover and spread style={popoverStyle} + overflow-y-auto (hook consumers)."
    echo "  If this site is genuinely safe (content is small and fixed, or it scrolls via an ancestor),"
    echo "  add a reviewed, commented entry to EXCLUDE_MATCHES in $(basename "$0") instead. Offenders:"
    printf '%s\n' "$offenders" | sed 's/^/    /'
  } >&2
  exit 1
fi

echo "check-dropdown-scroll passed."
