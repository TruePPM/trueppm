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
# so those sites carry an in-source marker, exactly like rule 300(c)'s "separate
# the sanctioned exception from the violation mechanically, or the exception list
# becomes the hole." Any NEW `role="menu"`/`role="listbox"` panel that is neither
# marked nor guarded fails the gate; the ratchet's only job is not re-litigating
# today's reviewed exclusions on every future scan.
#
# HOW AN EXCLUSION IS SPELLED, AND WHY IT LIVES IN THE SOURCE (#3117)
# The reviewed exclusions used to be a list of `path:LINE` pairs in this file.
# That key is invalidated by any edit that shifts the line — including an edit
# hundreds of lines away with nothing to do with dropdowns — so the gate reddened
# against code the author had not touched, named a line they had not written, and
# prescribed a fix that would have been wrong to apply. It fired three times in
# nine days on `ScheduleView.tsx` alone (#3114, #3113, #3117), and twice it also
# produced a merge conflict between two branches that had each renumbered the
# same entry — where neither side's number was correct on the merged tree.
#
# An exclusion is now a comment on the offending line itself:
#
#     role="menu" // dropdown-scroll-ok: 2-3 fixed radio items, content cannot grow
#     <ul role="listbox" /* dropdown-scroll-ok: inherits RosterPage's scroll */ >
#
# It must sit on the SAME LINE as the `role=` attribute (either comment form —
# both are legal in JSX attribute position) and must carry a non-empty reason.
# Same-line is deliberate and is the whole mechanism: the marker moves with the
# line, so no unrelated insert can invalidate it, and — the property a `path:line`
# list could never have — the line cannot be edited without the reason appearing
# in the same diff hunk as the edit. That is colocation, not verification: it does
# not prove the reason still holds, it guarantees the reviewer is shown it.
#
# A content hash (`path:sha256(line)`) was the other candidate and was rejected on
# the tree's actual data: 15 of the 21 reviewed sites are the byte-identical text
# `role="menu"` or `role="listbox"`, and two files (RelatedLinkPicker,
# ScheduleDependencyPicker) hold identical PAIRS. One hash entry would have
# covered both members of a pair — and silently covered a third, unreviewed panel
# added to the same file later. The hole a hash opens is worse than the churn it
# closes.
#
# Stale markers are an error too: a `dropdown-scroll-ok:` comment on a line with
# no `role=` match left on it means the panel was deleted or refactored and the
# exemption outlived its subject.
#
# NOT EVERY `role="menu"` IS A PANEL
# `document.querySelector('[role="menu"]...')` is a CSS attribute selector in a
# string, not a rendered attribute — there is nothing there to scroll. Matches
# written in the bracketed selector form are skipped structurally rather than
# named as exclusions.
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

# In-source exemption marker. See "HOW AN EXCLUSION IS SPELLED" above.
MARKER_PAT='dropdown-scroll-ok:[[:space:]]*[^[:space:]]'

# A bracketed `[role="menu"]` is a CSS attribute selector inside a string, not a
# rendered JSX attribute. Strip those occurrences before deciding whether a line
# still declares a role, so a `document.querySelector` call is skipped because of
# what it is rather than because someone wrote its line number down.
strip_selector_forms() { sed -E 's/\[role="(menu|listbox)"\]?//g'; }

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

# Does this source line still declare a JSX role after the CSS-selector forms are
# stripped out? Shared by the scan (skip selector strings) and the stale-marker
# check (a marker must sit on a line that really does declare one).
line_declares_role() {
  local content="$1"
  # A comment/prose line naming `role="menu"` is not a panel. A marker comment
  # is written AFTER the attribute, so this only rejects lines that OPEN with one.
  [[ "$content" =~ ^[[:space:]]*(//|\*|/\*|\{/\*) ]] && return 1
  grep -qE 'role="menu"|role="listbox"' <<<"$(strip_selector_forms <<<"$content")"
}

line_is_marked() { grep -qE "$MARKER_PAT" <<<"$1"; }

dropdown_offenders() {
  local raw
  raw="$(g -rnE 'role="menu"|role="listbox"' "$WEB_SRC" --include="*.tsx" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno content
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    content="${line#*:*:}"
    line_declares_role "$content" || continue
    line_is_marked "$content" && continue
    window_is_guarded "$file" "$lineno" || echo "$file:$lineno"
  done <<<"$raw"
}

# A `dropdown-scroll-ok:` marker whose line no longer declares a role exempts
# nothing and documents nothing — the panel it was reviewed against has been
# deleted or refactored out from under it. Report those rather than let the
# exemption outlive its subject.
stale_markers() {
  local raw
  raw="$(g -rnE 'dropdown-scroll-ok:' "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | g -vE "$EXCLUDE_TREE")"
  [ -z "$raw" ] && return 0
  local line file lineno content
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    file="${line%%:*}"
    lineno="${line#*:}"; lineno="${lineno%%:*}"
    content="${line#*:*:}"
    # An empty reason is as stale as a missing panel: it suppresses without saying why.
    if ! line_is_marked "$content"; then
      echo "$file:$lineno (marker carries no reason)"
      continue
    fi
    line_declares_role "$content" \
      || echo "$file:$lineno (no role=\"menu\"/role=\"listbox\" left on this line)"
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

  # --- selector-string narrowing (#3117) ---------------------------------
  # A bracketed `[role="menu"]` inside a querySelector argument must be skipped
  # structurally. If this ever starts counting again the gate will demand a
  # scroll guard on a string literal, which is the false positive that made the
  # old line-anchored exclusion list necessary in the first place.
  line_declares_role $'if (document.querySelector(\'[role="menu"][aria-label="Row actions"]\')) return;' \
    && { echo "::error:: dropdown-scroll self-test: a querySelector selector string was read as a rendered role" >&2; rc=1; }
  line_declares_role '      role="menu"' \
    || { echo "::error:: dropdown-scroll self-test: a real role= attribute was skipped as a selector string" >&2; rc=1; }
  line_declares_role '  // a docstring mentioning role="menu" is prose' \
    && { echo "::error:: dropdown-scroll self-test: a comment line was read as a panel" >&2; rc=1; }

  # --- in-source marker (#3117) ------------------------------------------
  # Both comment forms are legal in JSX attribute position and both must count;
  # a marker with no reason after the colon must NOT.
  line_is_marked '      role="menu" // dropdown-scroll-ok: 2-3 fixed items' \
    || { echo "::error:: dropdown-scroll self-test: trailing // marker not recognised" >&2; rc=1; }
  line_is_marked '      <ul role="listbox" /* dropdown-scroll-ok: ancestor scrolls */ >' \
    || { echo "::error:: dropdown-scroll self-test: inline /* */ marker not recognised" >&2; rc=1; }
  line_is_marked '      role="menu" // dropdown-scroll-ok:' \
    && { echo "::error:: dropdown-scroll self-test: a reasonless marker was accepted" >&2; rc=1; }

  # --- the property the whole change exists for --------------------------
  # An unrelated insert ABOVE a marked site must not disturb it. The old
  # `path:LINE` allowlist failed exactly here (#3114, #3113, #3117): the entry
  # was keyed on a coordinate, so any edit that moved the line reddened the gate
  # against code the author never touched. Build the same file twice, once with
  # 40 extra lines pushed in above, and require an identical verdict.
  local marked_body='export function Marked() {
  return (
    <div
      role="menu" // dropdown-scroll-ok: fixture — 2 fixed items
      className="absolute z-30"
    >
      <button role="menuitem">One</button>
    </div>
  );
}'
  printf '%s\n' "$marked_body" >"$tmp/Marked.tsx"
  { local i=0; while [ "$i" -lt 40 ]; do echo "// filler"; i=$((i + 1)); done; printf '%s\n' "$marked_body"; } >"$tmp/MarkedShifted.tsx"
  local a b
  a="$(g -nm1 -E 'role="menu"' "$tmp/Marked.tsx")"
  b="$(g -nm1 -E 'role="menu"' "$tmp/MarkedShifted.tsx")"
  [ "${a%%:*}" = "${b%%:*}" ] \
    && { echo "::error:: dropdown-scroll self-test: shift fixture did not actually shift" >&2; rc=1; }
  line_is_marked "${a#*:}" && line_is_marked "${b#*:}" \
    || { echo "::error:: dropdown-scroll self-test: marker did not survive a line shift" >&2; rc=1; }

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
stale="$(stale_markers)"
stale_count=$(printf '%s' "$stale" | grep -c . || true)

echo "dropdown-scroll: $count unguarded role=\"menu\"/role=\"listbox\" panel(s) (must be 0)."

rc=0

if [ "$count" -gt 0 ]; then
  {
    echo "::error:: $count floating menu/listbox panel(s) have no overflow-y-auto + height guard (web-rule 351, #3109)."
    echo "  A panel taller than the viewport spills off-screen with nothing to scroll it into view."
    echo "  Fix: add max-h-[min(70vh,<cap>)] overflow-y-auto (bespoke panels), or route through"
    echo "  useAnchoredPopover and spread style={popoverStyle} + overflow-y-auto (hook consumers)."
    echo "  If this site is genuinely safe (content is small and fixed, or it scrolls via an ancestor),"
    echo "  mark the line itself instead — both comment forms are legal in JSX attribute position:"
    echo "      role=\"menu\" // dropdown-scroll-ok: <why this one cannot outgrow the viewport>"
    echo "      <ul role=\"listbox\" /* dropdown-scroll-ok: <why> */ >"
    echo "  The marker travels with the line, so no later edit can invalidate it. Offenders:"
    printf '%s\n' "$offenders" | sed 's/^/    /'
  } >&2
  rc=1
fi

if [ "$stale_count" -gt 0 ]; then
  {
    echo "::error:: $stale_count stale dropdown-scroll-ok marker(s) — each exempts nothing and documents nothing."
    echo "  A marker must sit on the same line as the role=\"menu\"/role=\"listbox\" attribute it"
    echo "  exempts, and must state a reason. If the panel is gone, delete the marker; if it moved,"
    echo "  the marker should have moved with it. Stale markers:"
    printf '%s\n' "$stale" | sed 's/^/    /'
  } >&2
  rc=1
fi

[ "$rc" -eq 0 ] || exit 1

echo "check-dropdown-scroll passed."
