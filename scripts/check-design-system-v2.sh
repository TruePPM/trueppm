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
#   4b. sub-floor type outside the sanctioned carve-outs — every `text-[Npx]` below
#      the text-xs/12px floor (rule 50). `features/settings/` may use 10px/11px
#      (rule 118) and the global StatusBar may use 11px (rule 45); `text-[9px]` or
#      smaller is prohibited ANYWHERE. RATCHET: two decorative, `aria-hidden`
#      occurrences predate the check (see BASELINE_TINY_TEXT). New code adds zero
#      (#2433). The 11px case was UNMATCHABLE by this pattern until #2858.
#   4d. a resting `bg-semantic-{state}/N` opacity tint where rule 8b requires the
#      pre-computed `-bg` token — the two are different HUES, not different alphas
#      (see sem_tint_offenders). Interaction-state washes (`hover:`, `focus:`, …)
#      are legitimate opacity and are stripped before counting. ZERO TOLERANCE
#      (#2858); the check did not exist before it.
#   4e. a query destructure taking `isLoading` but never `error`/`isError`, which
#      renders a failed fetch as an empty surface (rule 246). RATCHET — the "is this
#      a primary surface?" judgement is not mechanizable, but the population size is,
#      and nobody was counting it across #1764/#1937/#1942/#2858.
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
#    118 →  122  (#2727 pt.7) GanttRenderer.ts's deliveryScrum/deliveryKanban
#                entries — 2 new hues x {COLOR, COLOR_DARK} — for the delivery-
#                mode gutter/texture. Same accepted pattern as the file's
#                existing SAGE_600/SAGE_700/SAGE_400 palette constants: this is
#                a canvas ctx.fillStyle palette, not CSS-in-JS, so it cannot
#                consume a CSS custom property directly. deliveryScrum's hex
#                mirrors --violet/--agile (globals.css) exactly; deliveryKanban's
#                hex mirrors the new --teal/--kanban token added alongside it,
#                which ScheduleLegend.tsx's KanbanSwatch consumes directly (so
#                the arbitrary-color count below did NOT need a bump).
#    122 →  124  (#2738) GanttRenderer.ts's chipTextOnHighlight — the ink for a
#                pill filled with the sprint-window band's edge violet — in
#                {COLOR, COLOR_DARK}. It cannot fold into chipTextOnSurface: the
#                two coincide on the light and dark palettes but diverge under
#                forced-colors, where a Highlight-filled pill's only guaranteed
#                contrast partner is HighlightText. The band's own edge hue added
#                nothing here — sprintBandEdge consumes the VIOLET_600/VIOLET_400
#                constants deliveryScrum already uses, which is what makes the
#                band and the scrum bars inside it the same violet by
#                construction rather than by review.
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
# Rose 6 → 7 for `deliveryTexture` (#2727 pt.7, delivery-mode gutter/texture): a
# light-only COLOR value (low-alpha black ink for the stripe/dot pattern) with a
# COLOR_DARK counterpart (rgba(255,255,255,0.14)) and a COLOR_FORCED counterpart
# (CanvasText) — same accepted pattern as rowHover above.
BASELINE_BLACK=7
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
# NOTE the pattern this baseline counts was WIDENED at #2858 — it now matches
# `text-[11px]` too, which it never could before (see TINY_TEXT_PAT). The count
# nevertheless stayed at 2: the ten 11px sites the widened pattern exposed were all
# raised to `text-xs` in the same commit, and the two named survivors below are the
# only ones left. Do not read the unchanged number as "nothing was wrong".
BASELINE_TINY_TEXT=2
# Unhandled query errors (rule 246, check 4e). 62 on `main` at #2858; RosterPage's
# fix takes it to 61. RATCHET, not zero tolerance — see query_error_offenders for why
# the "is this a primary surface?" question is not decidable here, and why counting
# the population is the part that was actually missing.
BASELINE_QUERY_ERROR=61

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
    grep -qE "$HEX_COLOR_PAT" <<<"$s" || { echo "::error:: hex pattern MISSED a color: $s" >&2; rc=1; }
  done
  # MUST NOT match — issue references, the false-positive class this pattern exists
  # to exclude. A bare ref, and the quote/colon-adjacent forms that #2651 fixed.
  for s in '// plain bare ref #2640 in prose' '/* the "#2495 scope boundary" test */' \
           'That is deliberate: #1788 tuned the phone bar'; do
    grep -qE "$HEX_COLOR_PAT" <<<"$s" && { echo "::error:: hex pattern COUNTED an issue ref: $s" >&2; rc=1; }
  done
  return $rc
}
if ! hex_pat_self_test; then
  echo "design-system-v2: HEX_COLOR_PAT is broken — refusing to report a count it cannot be trusted to produce." >&2
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
# Sub-floor type. The type floor is `text-xs` (12px, rule 50), so EVERY arbitrary
# pixel size below it is matched — 0–9px, 10px and 11px. Two named carve-outs:
# `features/settings/` may use `text-[10px]`/`text-[11px]` (rule 118's compact-admin
# density) and the global StatusBar may use `text-[11px]` (rule 45). `text-[9px]` and
# below are prohibited everywhere, settings included. All are a WCAG 1.4.3 risk,
# which is why the exceptions are named files/trees, not per-component judgement.
#
# THE 11px HOLE (#2858). This pattern read `text-\[([0-9]|10)px\]` from the day it
# was written — a single digit, or the literal "10". It could not match `text-[11px]`
# in ANY file, in ANY tree, which is why that exact class needed six dedicated sweeps
# (#434, #650, #1023, #1229, #1332, #2043) and came back a seventh time with the gate
# reporting green throughout. The alternation now spells the two-digit cases out.
# The self-test below exists because a widened pattern that silently narrows again is
# indistinguishable from a clean tree: this gate has already been that once.
TINY_TEXT_PAT='text-\[(1[01]|[0-9])px\]'
# Shared by the scan and its self-test so the two can never diverge. Input is
# `path:line:content` (grep -rIn form).
#   1. tests/specs/stories (the global EXCLUDE);
#   2. a line that STARTS as a comment — prose naming the class is documentation,
#      not a style (e.g. BulkEditSheet's "text-xs, not text-[11px]" rationale). A
#      className never begins a `//`, `*`, `/*` or `{/*` line, so this cannot mask
#      a real offender;
#   3. rule 118 — settings may use 10px/11px (but not 9px and below);
#   4. rule 45 — the global StatusBar may use 11px.
tiny_text_filter() {
  g -vE "$EXCLUDE" \
    | g -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*|\{/\*)" \
    | g -vE "^$WEB_SRC/features/settings/.*text-\[1[01]px\]" \
    | g -vE "^$WEB_SRC/features/shell/StatusBar\.tsx:[0-9]+:.*text-\[11px\]"
}
tiny_text_offenders() {
  g -rInE "$TINY_TEXT_PAT" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null \
    | tiny_text_filter
}

# Rule 8b: a semantic status tint is the pre-computed `bg-semantic-{state}-bg`
# token, never the opacity modifier `bg-semantic-{state}/N`. The two are NOT the
# same color with different alpha — verified against globals.css:
#   · warning  — base is `133 77 14` (#854D0E, the AA-safe *text* color) in light
#     and `250 204 21` (#FACC15, yellow) in dark, while --sem-warning-bg is
#     rgba(217,119,6,…) (#D97706 brand amber) light and rgba(251,146,60,…) (orange)
#     dark. A DIFFERENT HUE in BOTH modes. globals.css says so itself: "Brand amber
#     #D97706 lives only in --sem-warning-bg."
#   · on-track — base `49 111 87` (sage-700) vs --sem-on-track-bg rgba(62,140,109,…)
#     (#3E8C6D brand fill) in light: also a different RGB.
#   · at-risk / critical — same RGB, but the `-bg` alpha is mode-specific (e.g.
#     0.08 light / 0.15 dark) against the single fixed alpha a `/N` applies to both.
# So the modifier form silently renders the wrong color, not merely a weaker one.
#
# NO CHECK FOR THIS EXISTED (#2858) — the pattern reached 7 resting fills before a
# human read them off the tree by hand.
#
# What makes it decidable: an INTERACTION-STATE variant (`hover:`, `focus:`, …) IS
# legitimate opacity — a hover wash on a destructive text button, or `/90` darkening
# a solid critical button, are the codebase's normal idiom and rule 8b does not
# reach them (it governs resting badge/pill/card fills). Those variants are stripped
# first, so only a BARE, resting `bg-semantic-{state}/N` survives. On the tree at
# #2858 that separated exactly the 7 real offenders from 32 legitimate hover washes.
SEM_TINT_PAT='bg-semantic-(critical|warning|on-track|at-risk|success)/[0-9]'
SEM_TINT_VARIANT_STRIP='s/(hover|focus|focus-visible|focus-within|active|group-hover|group-focus|peer-hover|peer-focus|disabled|enabled|aria-[a-z-]+|data-\[[^]]*\]):bg-semantic-[a-z-]+\/[0-9]+//g'
sem_tint_filter() {
  g -vE "$EXCLUDE" | sed -E "$SEM_TINT_VARIANT_STRIP" | g -E "$SEM_TINT_PAT"
}
sem_tint_offenders() {
  g -rInE "$SEM_TINT_PAT" "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null \
    | sem_tint_filter
}

# Rule 246: a TanStack Query destructure that takes `isLoading` but never `error`
# or `isError` renders a failed fetch as an empty (or perpetually-skeletal) surface,
# indistinguishable from "nothing here yet".
#
# This is a RATCHET, and deliberately so. #1764 (Board/Overview), #1937 (SprintsView),
# #1942 (RiskRegisterView) and #2858 (RosterPage) each fixed the identical bug on one
# more page, because nothing counted the population. Nothing here can decide whether a
# given call site is a "primary data surface" (which rule 246 governs) or a small
# inline widget whose parent owns the error — that is a semantic judgement no grep and
# no AST selector can make, which is exactly why a zero-tolerance form of this check
# would be noise and get deleted. What it CAN do is make the population a published
# number that may not grow: a new page that ignores `error` fails the gate, and the
# only way past is to handle it or to raise the baseline in review.
#
# Coverage: single-line destructures. That is not a compromise on this tree — an
# equivalent AST sweep (esquery `ObjectPattern:has(isLoading):not(:has(error))` under
# a `use[A-Z]*()` initializer) returned the same 63 sites at #2858, because multi-line
# query destructures are not a style anyone here writes.
# NOT anchored to start-of-line: `grep -rInE` matches file CONTENT, but the self-test
# feeds the `path:line:content` shape the scan emits, and a `^` would silently never
# match there — a self-test that cannot fail is the failure mode this file already had.
QUERY_ERROR_PAT='\b(const|let)[[:space:]]+\{[^}]*\bisLoading\b[^}]*\}[[:space:]]*=[[:space:]]*use[A-Z][A-Za-z0-9_]*\('
# React's own primitives also match `use[A-Z]` — `const { options, isLoading } =
# useMemo(…)` is a derived value, not a query, and has no `error` to handle.
query_error_filter() {
  g -vE "$EXCLUDE" \
    | g -vE "=[[:space:]]*use(Memo|Callback|State|Reducer|Ref|Context|Effect)\(" \
    | g -vE "\bisError\b|\berror\b"
}
query_error_offenders() {
  g -rInE "$QUERY_ERROR_PAT" "$WEB_SRC" --include="*.tsx" 2>/dev/null | query_error_filter
}

# Self-test for the three pattern+filter pipelines above. Same contract as
# hex_pat_self_test: a ratchet whose pattern matches nothing reports 0 and PASSES,
# so a narrowed pattern disarms the check silently instead of failing it — which is
# literally what the 11px hole did for six sweeps. Fixtures run in BOTH directions:
# a violating line that must survive the filter, and a sanctioned line that must not.
# Input is the `path:line:content` shape the real scans produce.
pipeline_self_test() {
  local rc=0 s
  # -- tiny text: MUST be reported --
  for s in \
    'packages/web/src/components/linkPresentation.tsx:61:  className="text-[11px] font-medium"' \
    'packages/web/src/features/assets/AssetsPage.tsx:515:  className="px-1.5 text-[11px]"' \
    'packages/web/src/features/settings/X.tsx:9:  className="text-[9px]"' \
    'packages/web/src/features/shell/StatusBar.tsx:1:  className="text-[10px]"' \
    'packages/web/src/features/foo/Bar.tsx:3:  className="text-[10px]"'; do
    printf '%s\n' "$s" | g -E "$TINY_TEXT_PAT" | tiny_text_filter | grep -q . \
      || { echo "::error:: tiny-text pipeline MISSED an offender: $s" >&2; rc=1; }
  done
  # -- tiny text: MUST NOT be reported --
  for s in \
    'packages/web/src/features/settings/X.tsx:9:  className="text-[11px]"' \
    'packages/web/src/features/settings/X.tsx:9:  className="text-[10px]"' \
    'packages/web/src/features/shell/StatusBar.tsx:124:  className="text-[11px]"' \
    'packages/web/src/features/schedule/BulkEditSheet.tsx:446:        {/* text-xs, not text-[11px]: rationale */}' \
    'packages/web/src/features/foo/Bar.spec.ts:3:  expect(x).toContain("text-[11px]")' \
    'packages/web/src/features/foo/Bar.tsx:3:  className="text-[12px]"'; do
    printf '%s\n' "$s" | g -E "$TINY_TEXT_PAT" | tiny_text_filter | grep -q . \
      && { echo "::error:: tiny-text pipeline COUNTED a sanctioned line: $s" >&2; rc=1; }
  done
  # -- semantic tint: MUST be reported (bare, resting fills) --
  for s in \
    'packages/web/src/a/M.tsx:135:  className="border-semantic-warning/40 bg-semantic-warning/10 px-3"' \
    'packages/web/src/a/T.tsx:17:  Yours: "bg-semantic-success/10 text-semantic-success"' \
    'packages/web/src/a/C.tsx:37:  <span className="block h-full bg-semantic-critical/60" />' \
    'packages/web/src/a/R.tsx:35:  className="rounded-full bg-semantic-on-track/15"'; do
    printf '%s\n' "$s" | g -E "$SEM_TINT_PAT" | sem_tint_filter | grep -q . \
      || { echo "::error:: semantic-tint pipeline MISSED an offender: $s" >&2; rc=1; }
  done
  # -- semantic tint: MUST NOT be reported --
  for s in \
    'packages/web/src/a/P.tsx:233:  className="text-semantic-critical hover:bg-semantic-critical/5"' \
    'packages/web/src/a/D.tsx:115:  className="bg-semantic-critical hover:bg-semantic-critical/90"' \
    'packages/web/src/a/R.tsx:61:  ? "bg-semantic-at-risk-bg hover:bg-semantic-at-risk/10"' \
    'packages/web/src/a/A.tsx:9:  className="focus-visible:bg-semantic-critical/5"' \
    'packages/web/src/a/B.tsx:9:  className="bg-semantic-at-risk-bg text-semantic-at-risk"' \
    'packages/web/src/a/B.test.tsx:9:  expect(c).toContain("bg-semantic-warning/10")'; do
    printf '%s\n' "$s" | g -E "$SEM_TINT_PAT" | sem_tint_filter | grep -q . \
      && { echo "::error:: semantic-tint pipeline COUNTED a legitimate line: $s" >&2; rc=1; }
  done
  # -- unhandled query error: MUST be reported --
  for s in \
    'packages/web/src/features/roster/RosterPage.tsx:21:  const { data: roster = [], isLoading } = useProjectResourcePool(projectId);' \
    'packages/web/src/a/X.tsx:4:  const { data, isLoading } = useThing(id);'; do
    printf '%s\n' "$s" | g -E "$QUERY_ERROR_PAT" | query_error_filter | grep -q . \
      || { echo "::error:: query-error pipeline MISSED an offender: $s" >&2; rc=1; }
  done
  # -- unhandled query error: MUST NOT be reported --
  for s in \
    'packages/web/src/a/X.tsx:4:  const { data, isLoading, isError, refetch } = useThing(id);' \
    'packages/web/src/a/X.tsx:4:  const { data, isLoading, error } = useThing(id);' \
    'packages/web/src/a/X.tsx:4:  const { open, setOpen } = useDisclosure();' \
    'packages/web/src/a/X.tsx:61:  const { options, isLoading } = useMemo(() => build(), []);' \
    'packages/web/src/a/X.test.tsx:4:  const { data, isLoading } = useThing(id);'; do
    printf '%s\n' "$s" | g -E "$QUERY_ERROR_PAT" | query_error_filter | grep -q . \
      && { echo "::error:: query-error pipeline COUNTED a handled/irrelevant line: $s" >&2; rc=1; }
  done
  return $rc
}
if ! pipeline_self_test; then
  echo "design-system-v2: a check pipeline is broken — refusing to report counts it cannot be trusted to produce." >&2
  exit 1
fi

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
sem_tint=$(sem_tint_offenders | wc -l | tr -d ' ')
query_error=$(query_error_offenders | wc -l | tr -d ' ')

echo "design-system-v2: hex=$hex (≤$BASELINE_HEX) · arbitrary-color=$arb (≤$BASELINE_ARBITRARY) · shadow=$shadow (≤$BASELINE_SHADOW) · black-rgba=$black (≤$BASELINE_BLACK) · dark-chrome=$dark_chrome (=0) · tiny-text=$tiny_text (≤$BASELINE_TINY_TEXT) · bare-suspense=$bare_suspense (=0) · semantic-tint=$sem_tint (=0) · query-error-unhandled=$query_error (≤$BASELINE_QUERY_ERROR)"

if (( arb > BASELINE_ARBITRARY )); then
  {
    echo "::error:: $arb arbitrary Tailwind color value classes (baseline $BASELINE_ARBITRARY)."
    echo "  Use a Design System token, not bg-[#...]/text-[#...]. New offenders:"
    grep -rInE "(bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|shadow)-\[#" \
      "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  } >&2
  fail=1
elif (( arb < BASELINE_ARBITRARY )); then
  echo "::notice:: arbitrary color classes dropped to $arb — lower BASELINE_ARBITRARY in $(basename "$0") to $arb."
fi

if (( hex > BASELINE_HEX )); then
  {
    echo "::error:: $hex raw hex literals in component source (baseline $BASELINE_HEX) — you added new hardcoded colors."
    echo "  Define colors as tokens in globals.css / tailwind.config.ts (ADR-0126, rule 8); consume the token."
  } >&2
  fail=1
elif (( hex < BASELINE_HEX )); then
  echo "::notice:: hex literals dropped to $hex — lower BASELINE_HEX in $(basename "$0") to $hex to lock the gain."
fi

if (( shadow > BASELINE_SHADOW )); then
  {
    echo "::error:: $shadow off-token box-shadows (baseline $BASELINE_SHADOW) — v2 is borders-over-shadows (rule 1)."
    echo "  Use 'border border-neutral-border' to separate; reserve shadow-card/shadow-pop for popover/drawer/modal/palette/toast. Offenders:"
    grep -rInE "\bshadow-(sm|md|lg|xl|2xl|inner)\b|shadow-\[" \
      "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  } >&2
  fail=1
elif (( shadow < BASELINE_SHADOW )); then
  echo "::notice:: off-token shadows dropped to $shadow — lower BASELINE_SHADOW in $(basename "$0") to $shadow."
fi

if (( black > BASELINE_BLACK )); then
  {
    echo "::error:: $black inline rgba(0,0,0,α) color values (baseline $BASELINE_BLACK) — the black-on-blue antipattern (issue 1638)."
    echo "  A fixed black value renders invisible on the dark navy surfaces. Use a mode-aware token (var(--color-*) / a COLOR_DARK palette entry). Offenders:"
    grep -rInE "rgba\(0, ?0, ?0, ?[0-9]?\.[0-9]" \
      "$WEB_SRC" --include="*.tsx" --include="*.ts" 2>/dev/null | grep -vE "$EXCLUDE" | sed 's/^/    /'
  } >&2
  fail=1
elif (( black < BASELINE_BLACK )); then
  echo "::notice:: black-rgba values dropped to $black — lower BASELINE_BLACK in $(basename "$0") to $black to lock the gain."
fi

if (( dark_chrome > 0 )); then
  {
    echo "::error:: $dark_chrome dark-chrome-on-light occurrence(s) in $SHELL_SRC (ADR-0126 §4 — never a dark sidebar on a light app)."
    echo "  Shell chrome must use the adaptive 'bg-chrome-surface' token (it swaps with the .dark class), not a raw dark navy fill. Offenders:"
    dark_chrome_offenders | sed 's/^/    /'
  } >&2
  fail=1
fi

if (( tiny_text > BASELINE_TINY_TEXT )); then
  {
    echo "::error:: $tiny_text sub-floor type occurrence(s) (baseline $BASELINE_TINY_TEXT) — the type floor is text-xs (12px, rule 50)."
    echo "  text-[10px] is permitted only inside features/settings (rule 118); text-[9px] and below are prohibited everywhere. Offenders:"
    tiny_text_offenders | sed 's/^/    /'
  } >&2
  fail=1
elif (( tiny_text < BASELINE_TINY_TEXT )); then
  echo "::notice:: sub-floor type dropped to $tiny_text — lower BASELINE_TINY_TEXT in $(basename "$0") to $tiny_text to lock the gain."
fi

if (( bare_suspense > 0 )); then
  {
    echo "::error:: $bare_suspense bare text node(s) used as a Suspense fallback (rule 248)."
    echo "  Render a skeleton that mirrors the surface's shape so the layout does not jump when the chunk lands. Offenders:"
    bare_suspense_fallback_offenders | sed 's/^/    /'
  } >&2
  fail=1
fi

if (( sem_tint > 0 )); then
  {
    echo "::error:: $sem_tint resting bg-semantic-{state}/N tint(s) (rule 8b) — use the pre-computed -bg token."
    echo "  bg-semantic-warning/10 is NOT bg-semantic-warning-bg: the base token is the AA-safe TEXT color and the -bg token is the brand fill, a different hue in both modes (globals.css). Swap to bg-semantic-{state}-bg, or bg-semantic-{state} at full strength for a solid indicator. Interaction-state washes (hover:/focus:/…) are exempt. Offenders:"
    sem_tint_offenders | sed 's/^/    /'
  } >&2
  fail=1
fi

if (( query_error > BASELINE_QUERY_ERROR )); then
  {
    echo "::error:: $query_error query destructure(s) taking isLoading but never error/isError (baseline $BASELINE_QUERY_ERROR, rule 246)."
    echo "  A failed fetch then renders as an empty or perpetually-skeletal surface — indistinguishable from 'nothing here yet' (#1764/#1937/#1942/#2858). Destructure error/isError and render <QueryErrorState/>. Offenders:"
    query_error_offenders | sed 's/^/    /'
  } >&2
  fail=1
elif (( query_error < BASELINE_QUERY_ERROR )); then
  echo "::notice:: unhandled query errors dropped to $query_error — lower BASELINE_QUERY_ERROR in $(basename "$0") to $query_error to lock the gain."
fi

if (( fail )); then
  echo "design-system-v2 gate FAILED — see docs/design/v2-golden-standard.md / ADR-0126." >&2
  exit 1
fi
echo "design-system-v2 gate passed."
