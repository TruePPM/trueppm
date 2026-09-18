#!/usr/bin/env bash
# scripts/check-focus-trap-focuskey.sh — web rule 362, enforced instead of asserted.
#
# WHY THIS EXISTS
# ----------------
# Rule 362 says, in its own words: "Any dialog that disables its own controls
# while a request is in flight passes that pending flag as `focusKey`, and gives
# the container `tabIndex={-1}` so the empty phase has a seat."
#
# The mechanism: `useFocusTrap`'s FOCUSABLE_SELECTOR is `button:not([disabled])`
# (and the `:not([disabled])` siblings for input/select/textarea). When an
# in-flight flag disables the dialog's own controls, the trap's focusable set
# goes EMPTY, the browser blurs the just-activated — now disabled — control to
# `<body>`, and nothing re-seats it. An `aria-modal="true"` surface is then on
# screen with focus outside it; `document.activeElement` is neither the trap's
# first nor its last focusable, so the Tab handler stops intercepting and Tab
# walks into the page behind the scrim. WCAG 2.4.3 / 2.1.2.
#
# Rule 362 was written from #3129 (`CommitPlanConfirmDialog`), which was fixed.
# Nothing was added to stop the next one, and #3298 introduced a fresh instance
# seventeen issues later — caught only because a `ux-review` happened to look.
# The #3352 sweep then re-read all 72 `useFocusTrap<` call sites against the
# tree and fixed 25 traps across 24 files. A rule stated in prose and enforced
# by nothing is a rule that gets re-broken on a schedule; those 25 fixes without
# this gate would only reset the clock until the 26th.
#
# Corollary from rule 362 itself, and the reason a unit test cannot stand in for
# this script: **jsdom does not blur a focused element when it is disabled**, so
# a vitest assertion that "focus stayed inside the trap" passes with the fix
# reverted. That assertion is vacuous by construction. What a vitest test CAN
# pin — and `useFocusTrap.test.tsx` does — is that a changed `focusKey` re-seats
# focus onto the container when nothing focusable is left. The population is
# this script's job.
#
# WHAT IT FLAGS
# A `useFocusTrap<...>(...)` call with fewer than three arguments (no `focusKey`)
# in a file that also renders a `disabled={<expr>}` whose expression names an
# in-flight-style flag (isPending / pending / busy / submitting / saving /
# isLoading / retrying / resolving / activating / …). One entry per trap,
# keyed `path::refName`, so a line-number shift never invalidates a waiver.
#
# NOT A CLAIM OF EXHAUSTIVE RECALL — two known blind spots, both deliberate:
#   1. Indirection. `disabled={!canLog}` where `canLog` is derived from
#      `create.isPending` does not match, because the attribute does not name a
#      pending flag. `QuickLogTime.tsx` and `LogTimePopover.tsx` are exactly
#      that shape; #3352 fixed both by hand, and this script does not see them.
#      `controlsDisabled` IS in the pattern below — an alias that folds a pending
#      flag in is worth naming once it is known. `canLog` is not, because its
#      negation reads as validation and adding it would flag every form.
#   1b. Collision. Two traps in one file sharing a ref name collapse to one key
#      (`BaselineManagerModal.tsx` has two `trapRef`s). Both must be fixed for
#      the key to clear, but a waiver on that key covers both — so never waive a
#      key a file uses twice without saying so in the reason.
#   2. Scope. "Is the disabled control INSIDE the trap container?" is a DOM
#      question a grep cannot answer without guessing. That is the false
#      positive this gate produces, and the waiver list below is how it is paid
#      for — not `|| true`, and not an advisory exit 0.
# Its job is not to find every instance. Its job is to make the population
# non-increasing once found.
#
# THE WAIVER LIST
# `scripts/focus-trap-focuskey-waivers.txt`, one `path::refName<TAB>reason` per
# line. Ratcheted two ways, both of which can only make it smaller:
#   * a waived trap that no longer trips the detector is a STALE entry and fails
#     the gate — so fixing a dialog forces its waiver out of the file;
#   * the entry count may not exceed WAIVER_BASELINE below.
# A waiver is a claim that the pending-flag `disabled=` is outside the trap, is
# validation-only, or belongs to a phase swap that unmounts rather than disables.
# Be honest about what it buys: like `--update-baseline` on the docs gate, it
# cannot stop a wrong answer. What it removes is the silence.
#
# Usage:  scripts/check-focus-trap-focuskey.sh [--self-test]
# Exit:   0 no unwaived violations and no stale waivers · 1 otherwise
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"
WAIVER_FILE="scripts/focus-trap-focuskey-waivers.txt"

# Set at #3352: the sweep read all 72 call sites, fixed the 25 traps that
# reproduce, and left this many detector hits that are false positives on the
# grounds recorded per entry. It may only go down.
WAIVER_BASELINE=2

# An in-flight flag as it is spelled in a `disabled={...}` expression. Matched
# case-insensitively on the attribute value, so `isPending`, `pending`,
# `createBaseline.isPending` and `submitting || !url.trim()` all hit.
PENDING_FLAG_PAT='pending|controlsdisabled|busy|submitting|saving|loading|closing|retrying|resolving|activating|deleting|creating|updating|uploading|importing|sending|inflight|mutating|restoring'

# ── Trap extraction ───────────────────────────────────────────────────────────
# Emits "lineno<TAB>refName<TAB>argCount" for every useFocusTrap<...>( call in
# the file named on the command line. Argument counting is paren/brace/bracket
# depth aware and ignores a trailing comma, so the multi-line call shape this
# tree uses counts 2 args, not 3. POSIX awk only — this runs on alpine/BusyBox.
trap_calls() {
  awk '
    # Emptiness is all we need, so strip every space/tab rather than trimming —
    # a bracket expression containing \t is not portable to BusyBox awk.
    function flush_arg(   t) {
      t = seg
      gsub(" ", "", t)
      gsub("\t", "", t)
      if (t != "") nargs++
      seg = ""
    }
    {
      line = $0
      if (!collecting) {
        p = index(line, "useFocusTrap<")
        if (p == 0) next
        ref = "?"
        if (match(line, /const[ \t]+[A-Za-z0-9_]+[ \t]*=/)) {
          ref = substr(line, RSTART, RLENGTH)
          sub(/^const[ \t]+/, "", ref)
          sub(/[ \t]*=$/, "", ref)
        }
        q = index(substr(line, p), "(")
        if (q == 0) next          # generic split across lines; not a shape we emit
        start = p + q - 1
        collecting = 1; depth = 0; nargs = 0; seg = ""; startline = NR
        rest = substr(line, start)
      } else {
        rest = line
      }
      n = length(rest)
      for (i = 1; i <= n; i++) {
        c = substr(rest, i, 1)
        if (c == "(" || c == "[" || c == "{") { depth++; if (depth > 1) seg = seg c; continue }
        if (c == ")" || c == "]" || c == "}") {
          depth--
          if (depth == 0) {
            flush_arg()
            printf "%d\t%s\t%d\n", startline, ref, nargs
            collecting = 0
            break
          }
          seg = seg c
          continue
        }
        if (c == "," && depth == 1) { flush_arg(); continue }
        if (depth >= 1) seg = seg c
      }
    }
  ' "$1"
}

# Core predicate, shared by the real scan and the self-test (the #2858 lesson: a
# check only the scan exercises can silently stop matching and nothing notices).
# Prints "path::ref" for every unkeyed trap in a file that also renders a
# pending-flag `disabled=`. Prints nothing otherwise.
unkeyed_traps_in_file() {
  local file="$1" rel="$2" calls line lineno ref nargs
  calls="$(trap_calls "$file")"
  [ -z "$calls" ] && return 0
  # Cheap gate first: no pending-flag disable in the file, nothing to report.
  grep -iqE "disabled=[{][^}]*($PENDING_FLAG_PAT)" "$file" || return 0
  while IFS=$'\t' read -r lineno ref nargs; do
    [ -n "$nargs" ] || continue
    [ "$nargs" -ge 3 ] && continue
    echo "$rel::$ref"
  done <<< "$calls"
  return 0
}

# ── Waivers ───────────────────────────────────────────────────────────────────
waiver_keys() {
  [ -f "$WAIVER_FILE" ] || return 0
  # Strip comments and blanks; a waiver line is "key<TAB>reason", so `cut -f1`
  # already stops at the tab — no trailing-whitespace sed, whose `[ \t]` class is
  # not portable to BusyBox sed.
  grep -v '^[[:space:]]*#' "$WAIVER_FILE" \
    | grep -v '^[[:space:]]*$' \
    | cut -f1
}

waiver_reason_missing() {
  # Any non-comment line with no tab-separated reason is a bare exemption.
  [ -f "$WAIVER_FILE" ] || return 1
  grep -v '^[[:space:]]*#' "$WAIVER_FILE" | grep -v '^[[:space:]]*$' | grep -vq "$(printf '\t')"
}

# ── Scans ─────────────────────────────────────────────────────────────────────
# Real tree: enumerate tracked .tsx under packages/web/src, skipping test trees.
scan_tree() {
  local f
  # `find`, not `git ls-files`: the alpine gate image has no git, and nothing
  # under packages/web/src is generated or gitignored.
  find "$WEB_SRC" -name '*.tsx' -type f \
    | grep -vE '\.test\.|\.spec\.|\.stories\.' \
    | while IFS= read -r f; do
        grep -q 'useFocusTrap<' "$f" || continue
        unkeyed_traps_in_file "$f" "$f"
      done
}

# Fixture tree: plain find, so the self-test works outside a git checkout.
scan_dir() {
  local root="$1" f
  find "$root" -name '*.tsx' -type f | sort | while IFS= read -r f; do
    grep -q 'useFocusTrap<' "$f" || continue
    unkeyed_traps_in_file "$f" "${f#"$root"/}"
  done
}

# ── Self-test ─────────────────────────────────────────────────────────────────
# Plants the violation this gate exists to catch and asserts BOTH directions:
# the offender is detected, and each of the three shapes that must not be
# flagged is not. A --self-test that only asserts the happy path proves nothing
# (#3195).
self_test() {
  local tmp rc=0 out
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # (1) OFFENDER — unkeyed trap, own controls disabled by an in-flight flag.
  cat >"$tmp/Offender.tsx" <<'EOF'
export function Offender({ onCancel, onConfirm, isPending }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div ref={trapRef} role="alertdialog" aria-modal="true" tabIndex={-1}>
      <button type="button" onClick={onCancel} disabled={isPending}>Cancel</button>
      <button type="button" onClick={onConfirm} disabled={isPending}>Delete</button>
    </div>
  );
}
EOF

  # (2) FIXED — same dialog with the pending flag passed as focusKey.
  cat >"$tmp/Fixed.tsx" <<'EOF'
export function Fixed({ onCancel, onConfirm, isPending }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel, isPending);
  return (
    <div ref={trapRef} role="alertdialog" aria-modal="true" tabIndex={-1}>
      <button type="button" onClick={onCancel} disabled={isPending}>Cancel</button>
      <button type="button" onClick={onConfirm} disabled={isPending}>Delete</button>
    </div>
  );
}
EOF

  # (3) FIXED, MULTI-LINE + TRAILING COMMA — the shape this tree actually writes.
  # A naive comma count reads three args here; this one must still pass.
  cat >"$tmp/FixedMultiline.tsx" <<'EOF'
export function FixedMultiline({ onClose, pending }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(
    true,
    onClose,
    pending,
  );
  return (
    <div ref={trapRef} tabIndex={-1}>
      <button type="button" disabled={pending}>Save</button>
    </div>
  );
}
EOF

  # (4) UNKEYED, MULTI-LINE, TRAILING COMMA, NO focusKey — must be flagged. This
  # is the counterpart of (3): if trailing-comma handling over-corrects, this
  # one goes silent and the gate is blind to the tree's most common call shape.
  cat >"$tmp/OffenderMultiline.tsx" <<'EOF'
export function OffenderMultiline({ onClose, saving }: Props) {
  const panelRef = useFocusTrap<HTMLDivElement>(
    true,
    onClose,
  );
  return (
    <div ref={panelRef} tabIndex={-1}>
      <button type="button" disabled={saving}>Save</button>
    </div>
  );
}
EOF

  # (5) CLEAN — validation-only disable, no in-flight flag anywhere.
  cat >"$tmp/Clean.tsx" <<'EOF'
export function Clean({ onClose, name }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  return (
    <div ref={trapRef} tabIndex={-1}>
      <input value={name} />
      <button type="button" disabled={!name.trim()}>Create</button>
    </div>
  );
}
EOF

  # (6) INLINE-CALLBACK ARG — an arrow function with its own commas and parens
  # must not be miscounted into a third argument.
  cat >"$tmp/InlineCallback.tsx" <<'EOF'
export function InlineCallback({ setOpen, pending }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, () => {
    setOpen(false, { restore: true });
  });
  return (
    <div ref={trapRef} tabIndex={-1}>
      <button type="button" disabled={pending}>Go</button>
    </div>
  );
}
EOF

  out="$(scan_dir "$tmp" || true)"

  grep -qx 'Offender.tsx::trapRef' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: unkeyed offender NOT detected" >&2; rc=1; }
  grep -qx 'OffenderMultiline.tsx::panelRef' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: multi-line unkeyed offender NOT detected" >&2; rc=1; }
  grep -qx 'InlineCallback.tsx::trapRef' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: inline-callback offender NOT detected" >&2; rc=1; }
  ! grep -q '^Fixed\.tsx::' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: keyed dialog flagged" >&2; rc=1; }
  ! grep -q '^FixedMultiline\.tsx::' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: keyed multi-line dialog flagged (trailing comma)" >&2; rc=1; }
  ! grep -q '^Clean\.tsx::' <<<"$out" \
    || { echo "::error:: focus-trap-focuskey self-test: validation-only disable flagged" >&2; rc=1; }

  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then
    echo "check-focus-trap-focuskey: self-test passed."
    exit 0
  fi
  echo "check-focus-trap-focuskey: self-test FAILED — the predicate cannot be trusted." >&2
  exit 1
fi

if ! self_test; then
  echo "check-focus-trap-focuskey: self-test failed — refusing to report a result it cannot be trusted to produce." >&2
  exit 1
fi

if waiver_reason_missing; then
  echo "::error:: $WAIVER_FILE has an entry with no tab-separated reason. Every waiver states why." >&2
  exit 1
fi

hits="$(scan_tree | sort -u || true)"
waivers="$(waiver_keys || true)"
waiver_count=$(printf '%s' "$waivers" | grep -c . || true)

violations=""
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  if ! grep -qxF "$hit" <<<"$waivers"; then
    violations="${violations}${hit}"$'\n'
  fi
done <<<"$hits"

stale=""
while IFS= read -r key; do
  [ -n "$key" ] || continue
  if ! grep -qxF "$key" <<<"$hits"; then
    stale="${stale}${key}"$'\n'
  fi
done <<<"$waivers"

violation_count=$(printf '%s' "$violations" | grep -c . || true)
stale_count=$(printf '%s' "$stale" | grep -c . || true)

echo "focus-trap-focuskey: $violation_count unwaived, $waiver_count waived (max $WAIVER_BASELINE), $stale_count stale waiver(s)."

rc=0

if [ "$violation_count" -gt 0 ]; then
  {
    echo "::error:: $violation_count focus trap(s) disable their own controls mid-request without a \`focusKey\` (web rule 362)."
    echo "  When the in-flight flag disables the dialog's buttons, FOCUSABLE_SELECTOR"
    echo "  (\`button:not([disabled])\`) matches nothing, the browser drops focus to <body>,"
    echo "  and Tab walks out of an aria-modal surface — WCAG 2.4.3 / 2.1.2."
    echo ""
    echo "  FIX: pass the pending flag as useFocusTrap's third argument and give the trap"
    echo "  container tabIndex={-1} so the empty phase has a seat:"
    echo ""
    echo "      const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel, isPending);"
    echo "      <div ref={trapRef} tabIndex={-1} …>"
    echo ""
    echo "  If the disabled control is OUTSIDE this trap, the disable is validation-only,"
    echo "  or the phase unmounts rather than disables, add a line to $WAIVER_FILE"
    echo "  with the reason. Offenders:"
    printf '%s' "$violations" | sed 's/^/    /'
  } >&2
  rc=1
fi

if [ "$stale_count" -gt 0 ]; then
  {
    echo "::error:: $stale_count waiver(s) in $WAIVER_FILE no longer match anything."
    echo "  The trap was fixed, renamed, or removed. Delete the line — this list only shrinks."
    printf '%s' "$stale" | sed 's/^/    /'
  } >&2
  rc=1
fi

if [ "$waiver_count" -gt "$WAIVER_BASELINE" ]; then
  {
    echo "::error:: $waiver_count waivers exceed the ratchet baseline of $WAIVER_BASELINE."
    echo "  A new waiver is a new unenforced dialog. Fix the trap instead, or — if the"
    echo "  baseline is genuinely wrong — lower it, never raise it."
  } >&2
  rc=1
fi

[ "$rc" -eq 0 ] && echo "check-focus-trap-focuskey passed."
exit $rc
