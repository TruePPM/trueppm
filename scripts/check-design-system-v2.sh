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
#      colon (`stroke: #fff`). A bare `#1236`-style token in a comment or string —
#      an issue reference, not a color — is deliberately NOT counted (it is decimal
#      and never in color context). This is the fix for the false-positive class
#      that made the gate a moving target: every `#NNNN` issue ref in a comment used
#      to inflate the count and fail unrelated MRs (see the "issue N" rewrites in
#      git history). The tree carries pre-existing debt, so this is a RATCHET: the
#      count may not exceed the baseline. New code adds zero; debt only trends down.
#   3. off-token box-shadow — named `shadow-{sm,md,lg,...}` utilities AND arbitrary
#      `shadow-[...]` values. The v2 standard is borders-over-shadows; `shadow-card`
#      / `shadow-pop` (the reserved pop-surface tokens) are NOT matched here. RATCHET.
#   3b. inline `rgba(0,0,0,α)` color values — the "black on blue" antipattern
#      (issue 1638): a fixed black value that renders invisible on the dark navy
#      surfaces. The #-hex ratchet (check 2) does not see these. RATCHET.
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
# header). It dropped from 1195 to 129 when the count stopped miscounting `#NNNN`
# issue references as colors — the 129 are the real hardcoded color literals.
BASELINE_HEX=124
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

EXCLUDE='\.test\.|\.spec\.|\.stories\.'

# A hex COLOR literal, as it actually appears in TSX/CSS-in-JS: the `#` is preceded
# by a string quote (' " `), a Tailwind arbitrary-value `[`, or a CSS `value:` colon.
# This is what rule 8 forbids. It deliberately does NOT match a bare `#1236` issue
# reference in a comment (decimal, never in color context) — the false-positive class
# that used to inflate the ratchet and fail unrelated MRs.
HEX_COLOR_PAT='(["'\''`[]|:[[:space:]]*)#[0-9a-fA-F]{3,8}\b'

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

echo "design-system-v2: hex=$hex (≤$BASELINE_HEX) · arbitrary-color=$arb (≤$BASELINE_ARBITRARY) · shadow=$shadow (≤$BASELINE_SHADOW) · black-rgba=$black (≤$BASELINE_BLACK) · dark-chrome=$dark_chrome (=0)"

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

if (( fail )); then
  echo "design-system-v2 gate FAILED — see docs/design/v2-golden-standard.md / ADR-0126."
  exit 1
fi
echo "design-system-v2 gate passed."
