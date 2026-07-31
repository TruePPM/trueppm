#!/usr/bin/env bash
# scripts/check-design-system-v2.sh — Design System v2 conformance gate (ADR-0126).
#
# This is the enforcement mechanism for "all future work inherits the v2 golden
# standard" (docs/design/v2-golden-standard.md). It blocks the design-drift
# antipatterns the standard forbids. Each check below maps 1:1 to a claim in
# ADR-0126 §5 — keep them in sync (do not advertise a check here or in the ADR
# that the script does not actually run).
#
#   1. arbitrary Tailwind color VALUE classes — e.g. `bg-[#7C3AED]`, `text-[#abc]` —
#      which bypass the token system entirely. RATCHET against a committed baseline.
#   2. raw hex color literals in component source — rule 8 ("no custom hex in
#      components"). Only hex in a COLOR context is counted: quoted (`'#f59e0b'`),
#      inside a Tailwind arbitrary value (`bg-[#7C3AED]`), or a CSS value after a
#      colon (`stroke: #fff`). A `#1236`-style issue reference is deliberately NOT
#      counted — not when bare, and (since #2651) not when it sits right after a
#      quote or colon either, which is where the last of the false positives hid.
#      This is the fix for the false-positive class that made the gate a moving
#      target: every `#NNNN` issue ref in a comment used to inflate the count and
#      fail unrelated MRs (see the "issue N" rewrites in git history). The tree
#      carries pre-existing debt, so this is a RATCHET: the count may not exceed the
#      baseline. New code adds zero; debt only trends down.
#   3. off-token box-shadow — named `shadow-{sm,md,lg,...}` utilities AND arbitrary
#      `shadow-[...]` values. The v2 standard is borders-over-shadows; `shadow-card`
#      / `shadow-pop` (the reserved pop-surface tokens) are NOT matched here. RATCHET.
#   3b. inline `rgba(0,0,0,α)` color values — the "black on blue" antipattern
#      (issue 1638): a fixed black value that renders invisible on the dark navy
#      surfaces. The #-hex ratchet (check 2) does not see these. RATCHET.
#   4b. sub-floor type outside the sanctioned settings tree — `text-[10px]` (rule 50
#      floor is text-xs/12px; rule 118 carves out `features/settings/` only) and
#      `text-[9px]` or smaller ANYWHERE (prohibited with no exception). ZERO
#      RATCHET: two decorative, `aria-hidden` occurrences predate the check (see
#      BASELINE_TINY_TEXT). New code adds zero (#2433).
#   4c. a bare text node as a `<Suspense fallback>` — rule 248 wants a skeleton that
#      mirrors the surface's shape, never a naked "Loading…" line, so the layout
#      does not jump when the chunk lands. ZERO TOLERANCE (#2431/#2433).
#   4. dark-chrome-on-light — a hardcoded dark navy SURFACE on the shell chrome that
#      is not `dark:`-gated, i.e. the "dark sidebar on a light app" antipattern
#      (ADR-0126 §4). ZERO TOLERANCE: any occurrence fails. Chrome must use the
#      adaptive `bg-chrome-surface` token, never a raw dark fill.
#
# Counts (checks 1–3) are compared against committed baselines below. Lower a
# baseline whenever you remove violations (the gate will tell you to). You can never
# raise one without an explicit edit to this file landing in review — which is the point.
#
# Scope: packages/web/src, excluding tests/specs/stories and the token sources
# themselves (globals.css / tailwind.config.ts / brand/ are where tokens are
# DEFINED). Runs in `make lint` and the web:lint CI job.
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"
SHELL_SRC="packages/web/src/features/shell"

# ── Baselines (ratchet floors). See header. Drive these to zero over time. ──
# BASELINE_HEX counts hex literals in a COLOR context only (see hex_count and the
# header). Two re-baselines, both from removing `#NNNN` issue references that were
# never colors — the count is real hardcoded color literals, nothing else:
#   1195 → 129  the pattern gained its color-CONTEXT prefix (quote / `[` / `value:`).
#    121 →  118  the all-decimal branch gained a closing delimiter (#2651), dropping
#                the three refs that sat right after a colon. (129 → 121 in between
#                is genuine debt paid down by tokenizing colors.)
BASELINE_HEX=118
BASELINE_ARBITRARY=4
BASELINE_SHADOW=0
# Inline `rgba(0,0,0,α)` color VALUES in component/style source. These bypass the
# hex ratchet (check 2 only matches #-hex) and are the "black on blue" antipattern
# when they land on a dark surface without a mode-aware counterpart (issue 1638 —
# the BurnChart grid stroke was one). RATCHET: the surviving occurrences are
# light-palette values with a COLOR_DARK counterpart, or textures on a *colored*
# bar/swatch that darken in both modes. New code must use a mode-aware token, so
# the count may not exceed the baseline.
# Dropped 8 → 5 when ProgramScheduleLegend / AllocationSpan / ResourceView's
# hatch fills moved to the mode-aware --hatch-limited-view /
# --allocation-partial-stripe* tokens (issue #1914); the remaining values are all in
# GanttRenderer.ts's light-only COLOR palette (each has a COLOR_DARK counterpart) or
# a fixed texture ink on a colored bar that reads in both modes.
# Rose 5 → 6 for the synced row-hover wash `rowHover` (#2096): a light-only COLOR
# value with its COLOR_DARK / forced-colors counterparts, same accepted pattern as
# its palette siblings (rowBandAlt / weekend / gridLine).
BASELINE_BLACK=6
# Sub-floor type outside the sanctioned settings tree (check 4b). The two survivors
# are both DECORATIVE text inside an `aria-hidden` element, where the accessible
# name is carried by a sibling — so neither is a literal WCAG 1.4.3 failure, but
# both sit below the type floor and should trend to zero:
#   · TaskSummaryStrip  — 10px initials inside a 20px avatar circle (aria-hidden;
#     the owner's name renders beside it).
#   · ProgramIdentitySquare `xs-label` — 7px code inside a 16px square (aria-hidden
#     by rule 158; the program name is the accessible signal).
# A zero-tolerance gate here would have failed every unrelated MR on day one, so
# this ratchets like its siblings above.
BASELINE_TINY_TEXT=2

EXCLUDE='\.test\.|\.spec\.|\.stories\.'

# A hex COLOR literal, as it actually appears in TSX/CSS-in-JS. Every branch shares
# the same PREFIX — the `#` is preceded by a string quote (' " `), a Tailwind
# arbitrary-value `[`, or a CSS `value:` colon — and then splits on a single
# question: does the run contain a letter?
#
#   HEX_LETTER_PAT — the run has an `a-f`, so it CANNOT be an issue number. Ends at
#                    a word boundary, exactly as this check always did.
#   HEX_DECIMAL_PAT — the run is all digits, so `#2495` is ambiguous: a valid RGBA
#                    shorthand and a plausible issue number. Only here is a CLOSING
#                    delimiter required — a quote/bracket/paren/brace, `;` or `,`,
#                    or end of line; whitespace counts only before a digit or `!`,
#                    which keeps `#123456 0%` and `#123456 !important`.
#
# Why the split. The prefix alone was not enough: it skips a BARE `#1236` issue
# reference, but a quote- or colon-adjacent one — `the "#2495 scope boundary" test`,
# or `deliberate: #1788 tuned …` — still matched, because most issue numbers are
# valid hex. That failed MRs which added no color at all and sent the reader hunting
# for one (#2651).
#
# Requiring a closing delimiter of EVERY run was the first attempt, and it was WRONG:
# it dropped `stroke: #abcdef inherit;` and `background: #0e1626 url(…)`, which the
# old word-boundary caught — a genuine hole in the ratchet, since a new hardcoded
# color could then be merged just by leaving it unquoted. Letters are the honest
# discriminator: an issue reference is decimal, always. So only the decimal branch
# pays the stricter test, and no letter-bearing color loses coverage.
#
# Residual, accepted: an ALL-DECIMAL color that is both unquoted and followed by a
# word — `color: #123456 inherit` — is not counted. That is the unavoidable price of
# excluding `deliberate: #1788 tuned`; the two are textually identical. Quoted and
# Tailwind forms, which dominate this codebase, are unaffected.
#
# Separately, the PREFIX is conservative: a `#` reached from neither quote, bracket,
# nor colon (say `border: 1px solid #ccc`) is not counted at all. That under-count
# predates #2651 and is unchanged by it; widening the prefix is separate work and
# would need its own re-baseline.
#
# NOTE the `]` sits FIRST in the closing bracket expression. POSIX ERE gives `\` no
# special meaning inside `[...]`, so the intuitive `[...\]}]` does not escape it —
# the class ends at that `]` and the rest leaks into the pattern, which silently
# matches nothing and reports hex=0. Leading `]` is the only portable spelling.
HEX_LETTER_PAT='(["'\''`[]|:[[:space:]]*)#[0-9a-fA-F]{0,7}[a-fA-F][0-9a-fA-F]{0,7}\b'
HEX_DECIMAL_PAT='(["'\''`[]|:[[:space:]]*)#[0-9]{3,8}([]"'\''`);,}]|[[:space:]]+[0-9!]|$)'
HEX_COLOR_PAT="$HEX_LETTER_PAT|$HEX_DECIMAL_PAT"

# Self-test: a ratchet whose pattern matches nothing reports 0 and PASSES, so a
# malformed pattern disarms this check silently instead of failing it. That is not
# hypothetical — the `\]` bracket bug above did exactly that during #2651, and the
# run looked clean. Assert both directions on fixtures before counting anything.
hex_pat_self_test() {
  local s rc=0
  # MUST match — a real literal in each supported context. The unquoted-then-word
  # cases (`#abcdef inherit`, `#0e1626 url(…)`) are the regression a closing-delimiter
  # requirement introduced during #2651; they are fixtures so it cannot come back.
  for s in "const c = '#f59e0b';" '<div className="bg-[#7C3AED]">' '  stroke: #fff;' \
           '  color: #1A1917,' '  color: #fff !important;' '  stroke: #abcdef inherit;' \
           '  background: #0e1626 url(/x.png);' '  border-bottom: #ccc solid;' \
           '  color: #123456;'; do
    grep -qE "$HEX_COLOR_PAT" <<<"$s" || { echo "::error:: hex pattern MISSED a color: $s"; rc=1; }
  done
  # MUST NOT match — issue references, the false-positive class this pattern exists
  # to exclude. A bare ref, and the quote/colon-adjacent forms that #2651 fixed.
  for s in '// plain bare ref #2640 in prose' '/* the "#2495 scope boundary" test */' \
           'That is deliberate: #1788 tuned the phone bar'; do
    grep -qE "$HEX_COLOR_PAT" <<<"$s" && { echo "::error:: hex pattern COUNTED an issue ref: $s"; rc=1; }
  done
  return $rc
}
if ! hex_pat_self_test; then
  echo "design-system-v2: HEX_COLOR_PAT is broken — refusing to report a count it cannot be trusted to produce."
  exit 1
fi

# grep wrapper for the count pipelines below. grep exits 1 on "no match", which
# under `set -euo pipefail` would kill the gate the moment a count legitimately
# reaches zero — exactly the state this gate exists to ratchet toward. Treat
# exit 1 as a clean empty result, but still propagate a real grep error (>=2) so
# a broken pattern fails loudly rather than silently counting zero. The
# over-baseline `fail=1` comparison below is unchanged — enforcement is intact.
g() { grep "$@" || [ "$?" -eq 1 ]; }

hex_count() {
  g -rIE "$HEX_COLOR_PAT" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null \
    | g -vE "$EXCLUDE" | wc -l | tr -d ' '
}
arbitrary_count() {
  g -rIE "(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-\[#" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | g -vE "$EXCLUDE" | wc -l | tr -d ' '
}
# Named shadow utilities + any arbitrary shadow-[...]. Excludes the reserved
# `shadow-card` / `shadow-pop` pop-surface tokens (those are the sanctioned form).
shadow_count() {
  g -rIE "\bshadow-(sm|md|lg|xl|2xl|inner)\b|shadow-\[" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | g -vE "$EXCLUDE" | wc -l | tr -d ' '
}
# Inline rgba(0,0,0,α) color VALUES (numeric alpha, so prose comments that write
# `rgba(0,0,0,…)` with an ellipsis are not counted). See BASELINE_BLACK.
black_rgba_count() {
  g -rIE "rgba\(0, ?0, ?0, ?[0-9]?\.[0-9]" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | g -vE "$EXCLUDE" | wc -l | tr -d ' '
}
# Sub-floor type. `text-[10px]` is permitted ONLY inside features/settings (the
# compact-admin density carve-out, rule 118); `text-[9px]` and below are prohibited
# everywhere, settings included. Both are a WCAG 1.4.3 risk, which is why the
# exception is a named tree rather than a per-component judgement call.
tiny_text_offenders() {
  g -rInE "text-\[([0-9]|10)px\]" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null \
    | g -vE "$EXCLUDE" \
    | g -vE "^$WEB_SRC/features/settings/.*text-\[10px\]"
}
# A Suspense fallback that is a DOM element wrapping immediate text — i.e. a bare
# "Loading…" line where rule 248 requires a shape-mirroring skeleton.
bare_suspense_fallback_offenders() {
  g -rInE "fallback=\{<(div|span|p|section)[^>]*>[[:space:]]*[A-Za-z]" \
    "$WEB_SRC" --include="*.tsx" 2>/dev/null | g -vE "$EXCLUDE"
}

# Lines in the shell that apply a raw dark navy SURFACE not gated by `dark:`.
# (bg-black scrims are intentionally NOT matched — only navy chrome surfaces.)
dark_chrome_offenders() {
  grep -rInE "bg-(navy-[789]00|gantt-surface)\b|bg-\[#(0[eE]1626|15223[cC]|1[bB]2[aA]4[aA])\]" \
    "$SHELL_SRC" --include="*.tsx" 2>/dev/null \
    | grep -vE "$EXCLUDE" \
    | grep -vE "dark:bg-(navy-[789]00|gantt-surface)|dark:bg-\[#" || true
}

fail=0
hex=$(hex_count)
arb=$(arbitrary_count)
shadow=$(shadow_count)
black=$(black_rgba_count)
dark_chrome=$(dark_chrome_offenders | wc -l | tr -d ' ')
tiny_text=$(tiny_text_offenders | wc -l | tr -d ' ')
bare_suspense=$(bare_suspense_fallback_offenders | wc -l | tr -d ' ')

echo "design-system-v2: hex=$hex (≤$BASELINE_HEX) · arbitrary-color=$arb (≤$BASELINE_ARBITRARY) · shadow=$shadow (≤$BASELINE_SHADOW) · black-rgba=$black (≤$BASELINE_BLACK) · dark-chrome=$dark_chrome (=0) · tiny-text=$tiny_text (≤$BASELINE_TINY_TEXT) · bare-suspense=$bare_suspense (=0)"

if (( arb > BASELINE_ARBITRARY )); then
  echo "::error:: $arb arbitrary Tailwind color value classes (baseline $BASELINE_ARBITRARY)."
  echo "  Use a Design System token, not bg-[#...]/text-[#...]. New offenders:"
  grep -rInE "(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-\[#" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  fail=1
elif (( arb < BASELINE_ARBITRARY )); then
  echo "::notice:: arbitrary color classes dropped to $arb — lower BASELINE_ARBITRARY in $(basename "$0") to $arb."
fi

if (( hex > BASELINE_HEX )); then
  echo "::error:: $hex raw hex literals in component source (baseline $BASELINE_HEX) — you added new hardcoded colors."
  echo "  Define colors as tokens in globals.css / tailwind.config.ts (ADR-0126, rule 8); consume the token."
  fail=1
elif (( hex < BASELINE_HEX )); then
  echo "::notice:: hex literals dropped to $hex — lower BASELINE_HEX in $(basename "$0") to $hex to lock the gain."
fi

if (( shadow > BASELINE_SHADOW )); then
  echo "::error:: $shadow off-token box-shadows (baseline $BASELINE_SHADOW) — v2 is borders-over-shadows (rule 1)."
  echo "  Use 'border border-neutral-border' to separate; reserve shadow-card/shadow-pop for popover/drawer/modal/palette/toast. Offenders:"
  grep -rInE "\bshadow-(sm|md|lg|xl|2xl|inner)\b|shadow-\[" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  fail=1
elif (( shadow < BASELINE_SHADOW )); then
  echo "::notice:: off-token shadows dropped to $shadow — lower BASELINE_SHADOW in $(basename "$0") to $shadow."
fi

if (( black > BASELINE_BLACK )); then
  echo "::error:: $black inline rgba(0,0,0,α) color values (baseline $BASELINE_BLACK) — the black-on-blue antipattern (issue 1638)."
  echo "  A fixed black value renders invisible on the dark navy surfaces. Use a mode-aware token (var(--color-*) / a COLOR_DARK palette entry). Offenders:"
  grep -rInE "rgba\(0, ?0, ?0, ?[0-9]?\.[0-9]" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  fail=1
elif (( black < BASELINE_BLACK )); then
  echo "::notice:: black-rgba values dropped to $black — lower BASELINE_BLACK in $(basename "$0") to $black to lock the gain."
fi

if (( dark_chrome > 0 )); then
  echo "::error:: $dark_chrome dark-chrome-on-light occurrence(s) in $SHELL_SRC (ADR-0126 §4 — never a dark sidebar on a light app)."
  echo "  Shell chrome must use the adaptive 'bg-chrome-surface' token (it swaps with the .dark class), not a raw dark navy fill. Offenders:"
  dark_chrome_offenders | sed 's/^/    /'
  fail=1
fi

if (( tiny_text > BASELINE_TINY_TEXT )); then
  echo "::error:: $tiny_text sub-floor type occurrence(s) (baseline $BASELINE_TINY_TEXT) — the type floor is text-xs (12px, rule 50)."
  echo "  text-[10px] is permitted only inside features/settings (rule 118); text-[9px] and below are prohibited everywhere. Offenders:"
  tiny_text_offenders | sed 's/^/    /'
  fail=1
elif (( tiny_text < BASELINE_TINY_TEXT )); then
  echo "::notice:: sub-floor type dropped to $tiny_text — lower BASELINE_TINY_TEXT in $(basename "$0") to $tiny_text to lock the gain."
fi

if (( bare_suspense > 0 )); then
  echo "::error:: $bare_suspense bare text node(s) used as a Suspense fallback (rule 248)."
  echo "  Render a skeleton that mirrors the surface's shape so the layout does not jump when the chunk lands. Offenders:"
  bare_suspense_fallback_offenders | sed 's/^/    /'
  fail=1
fi

if (( fail )); then
  echo "design-system-v2 gate FAILED — see docs/design/v2-golden-standard.md / ADR-0126."
  exit 1
fi
echo "design-system-v2 gate passed."
