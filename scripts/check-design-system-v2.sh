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
#      components"). The tree carries pre-existing debt, so this is a RATCHET: the
#      count may not exceed the baseline. New code adds zero; debt only trends down.
#   3. off-token box-shadow — named `shadow-{sm,md,lg,...}` utilities AND arbitrary
#      `shadow-[...]` values. The v2 standard is borders-over-shadows; `shadow-card`
#      / `shadow-pop` (the reserved pop-surface tokens) are NOT matched here. RATCHET.
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
BASELINE_HEX=1216
BASELINE_ARBITRARY=6
BASELINE_SHADOW=3

EXCLUDE='\.test\.|\.spec\.|\.stories\.'

hex_count() {
  grep -rIE "#[0-9a-fA-F]{3,8}\b" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null \
    | grep -vE "$EXCLUDE" | wc -l | tr -d ' '
}
arbitrary_count() {
  grep -rIE "(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-\[#" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | wc -l | tr -d ' '
}
# Named shadow utilities + any arbitrary shadow-[...]. Excludes the reserved
# `shadow-card` / `shadow-pop` pop-surface tokens (those are the sanctioned form).
shadow_count() {
  grep -rIE "\bshadow-(sm|md|lg|xl|2xl|inner)\b|shadow-\[" \
    "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | wc -l | tr -d ' '
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
dark_chrome=$(dark_chrome_offenders | wc -l | tr -d ' ')

echo "design-system-v2: hex=$hex (≤$BASELINE_HEX) · arbitrary-color=$arb (≤$BASELINE_ARBITRARY) · shadow=$shadow (≤$BASELINE_SHADOW) · dark-chrome=$dark_chrome (=0)"

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
