#!/usr/bin/env bash
# scripts/check-aria-modal-focus-trap.sh — pair aria-modal="true" with a real
# focus trap (#4085, #2193 recurring, #4125's "aria-modal pairing" lint half).
#
# WHY THIS EXISTS
# ----------------
# `role="dialog"`/`role="alertdialog"` + `aria-modal="true"` is a promise to
# assistive tech and sighted keyboard users alike: focus cannot leave this
# surface. Nothing in the tree enforced that promise — #2193 found ~17 dialogs
# that declared `aria-modal="true"` with no Tab handler and no `inert`, they
# were migrated to `useFocusTrap` by hand, and #4085 found 14 fresh instances
# recurring with no gate to catch the next one. A rule fixed by hand and
# enforced by nothing is a rule that gets re-broken on a schedule.
#
# WHAT IT FLAGS
# A `.tsx` file (excluding test/spec/story files) that renders a literal
# `aria-modal="true"` or `aria-modal={true}` JSX attribute, and does none of
# the three things that pair it with a real trap:
#   1. imports/uses `useFocusTrap` (the shared hook, `src/hooks/useFocusTrap.ts`);
#   2. carries an inline `// focus-trap: <reason>` waiver — for a component that
#      hand-rolls a verified-correct Tab trap (see `ScheduleTaskDialog.tsx`,
#      #4085's documented false positive) rather than importing the hook;
#   3. renders through `<BottomSheet>`, which owns its own trap/scrim/Escape
#      (`components/ui/BottomSheet.tsx`) — a component that only ever mounts a
#      `BottomSheet` for its modal surface has nothing further to pair.
#
# NOT A CLAIM OF EXHAUSTIVE RECALL — two known blind spots, both deliberate:
#   1. Comment-only mentions. A docstring or `//` note that quotes
#      `aria-modal="true"` in prose (there are over a dozen in this tree) is
#      not a rendered attribute and is skipped — matched by "the line, trimmed,
#      starts with `//` or `*`".
#   2. `querySelector`/`querySelectorAll` CSS-selector strings. A line like
#      `document.querySelector('[role="dialog"][aria-modal="true"]')`
#      (`SprintsView.tsx`, #4085) contains the literal text this gate looks for
#      but is a runtime lookup over OTHER dialogs' DOM, not a declaration of
#      this component's own modal — skipped.
# Its job is not to find every instance. Its job is to make the population
# non-increasing once found (#4085's 14, minus whatever a future sweep adds,
# never silently grows again).
#
# Usage:  scripts/check-aria-modal-focus-trap.sh [--self-test]
# Exit:   0 no unwaived violations · 1 otherwise
set -euo pipefail

cd "$(dirname "$0")/.."
WEB_SRC="packages/web/src"

# ── Detection ─────────────────────────────────────────────────────────────────
# Emits one line number per REAL `aria-modal="true"`/`aria-modal={true}` JSX
# attribute in the file — i.e. not a comment line, not a querySelector string.
# `index()`, not a brace-containing regex: BusyBox awk's interval-expression
# support for `{` / `}` is not guaranteed, so this avoids depending on it.
real_aria_modal_hits() {
  local file="$1"
  awk '
    {
      line = $0
      if (index(line, "aria-modal=\"true\"") == 0 && index(line, "aria-modal={true}") == 0) next
      if (index(line, "querySelector") > 0) next
      trimmed = line
      sub(/^[ \t]+/, "", trimmed)
      if (substr(trimmed, 1, 2) == "//") next
      if (substr(trimmed, 1, 1) == "*") next
      print NR
    }
  ' "$file"
}

# True if the file pairs its aria-modal with a trap by one of the three
# recognized mechanisms (see header). Plain `grep -q` — none of the three
# needles contain regex metacharacters that change their meaning.
has_pairing() {
  local file="$1"
  grep -q 'useFocusTrap' "$file" && return 0
  grep -q 'focus-trap:' "$file" && return 0
  grep -q 'BottomSheet' "$file" && return 0
  return 1
}

# ── Scans ─────────────────────────────────────────────────────────────────────
# Real tree: `find`, not `git ls-files` — the alpine gate image has no git, and
# nothing under packages/web/src is generated or gitignored.
scan_tree() {
  find "$WEB_SRC" -name '*.tsx' -type f \
    | grep -vE '\.test\.|\.spec\.|\.stories\.' \
    | sort \
    | while IFS= read -r f; do
        hits="$(real_aria_modal_hits "$f")"
        [ -z "$hits" ] && continue
        has_pairing "$f" && continue
        echo "$f"
      done
}

# Fixture tree: same predicate, rooted elsewhere, so the self-test works
# outside a git checkout and does not need its own .tsx extension excuses.
scan_dir() {
  local root="$1"
  find "$root" -name '*.tsx' -type f | sort | while IFS= read -r f; do
    hits="$(real_aria_modal_hits "$f")"
    [ -z "$hits" ] && continue
    has_pairing "$f" && continue
    echo "${f#"$root"/}"
  done
}

# ── Self-test ─────────────────────────────────────────────────────────────────
# Plants the violation this gate exists to catch and asserts BOTH directions:
# the offender is detected, and each shape that must NOT be flagged is not
# (#3195 — a --self-test that only asserts the happy path proves nothing).
self_test() {
  local tmp rc=0 out
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # (1) OFFENDER — aria-modal="true", no trap, no waiver, no BottomSheet.
  cat >"$tmp/Offender.tsx" <<'EOF'
export function Offender({ onCancel }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div role="dialog" aria-modal="true">
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
EOF

  # (2) OFFENDER, `{true}` form — must also be flagged.
  cat >"$tmp/OffenderBraceTrue.tsx" <<'EOF'
export function OffenderBraceTrue({ onCancel }: Props) {
  return (
    <div role="dialog" aria-modal={true}>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
EOF

  # (3) FIXED — paired with useFocusTrap.
  cat >"$tmp/FixedTrap.tsx" <<'EOF'
import { useFocusTrap } from '@/hooks/useFocusTrap';
export function FixedTrap({ onCancel }: Props) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  return (
    <div ref={trapRef} role="dialog" aria-modal="true">
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
EOF

  # (4) FIXED — inline waiver comment, no useFocusTrap import.
  cat >"$tmp/FixedWaiver.tsx" <<'EOF'
export function FixedWaiver({ onCancel }: Props) {
  // focus-trap: hand-rolled Tab containment verified in review, see #4085.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Tab') { /* ... */ }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div role="dialog" aria-modal="true">
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
EOF

  # (5) FIXED — renders through BottomSheet, nothing further to pair.
  cat >"$tmp/FixedBottomSheet.tsx" <<'EOF'
import { BottomSheet } from '@/components/ui/BottomSheet';
export function FixedBottomSheet({ onClose, titleId }: Props) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <BottomSheet isOpen onClose={onClose} titleId={titleId}>
        <p>Body</p>
      </BottomSheet>
    </div>
  );
}
EOF

  # (6) CLEAN — only `aria-modal="false"`; never matched at all.
  cat >"$tmp/FalseOnly.tsx" <<'EOF'
export function FalseOnly() {
  return <div role="dialog" aria-modal="false">Not modal</div>;
}
EOF

  # (7) CLEAN — `aria-modal="true"` appears only in a docstring/comment.
  cat >"$tmp/CommentOnly.tsx" <<'EOF'
/**
 * `role="dialog" aria-modal="true"`, focus-trapped elsewhere.
 */
export function CommentOnly() {
  // aria-modal="true" is handled by the parent shell.
  return <div role="presentation">Shell content</div>;
}
EOF

  # (8) CLEAN — `aria-modal="true"` appears only inside a querySelector
  # CSS-selector string (the SprintsView.tsx false-positive class, #4085).
  cat >"$tmp/QuerySelectorOnly.tsx" <<'EOF'
export function useGlobalShortcut(onKey: () => void) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      onKey();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onKey]);
}
EOF

  out="$(scan_dir "$tmp" || true)"

  grep -qx 'Offender.tsx' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: offender NOT detected" >&2; rc=1; }
  grep -qx 'OffenderBraceTrue.tsx' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: aria-modal={true} offender NOT detected" >&2; rc=1; }
  ! grep -q '^FixedTrap\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: useFocusTrap-paired dialog flagged" >&2; rc=1; }
  ! grep -q '^FixedWaiver\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: waivered dialog flagged" >&2; rc=1; }
  ! grep -q '^FixedBottomSheet\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: BottomSheet-shelled dialog flagged" >&2; rc=1; }
  ! grep -q '^FalseOnly\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: aria-modal=false flagged" >&2; rc=1; }
  ! grep -q '^CommentOnly\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: comment-only mention flagged" >&2; rc=1; }
  ! grep -q '^QuerySelectorOnly\.tsx$' <<<"$out" \
    || { echo "::error:: aria-modal-focus-trap self-test: querySelector string flagged" >&2; rc=1; }

  return $rc
}

if [ "${1:-}" = "--self-test" ]; then
  if self_test; then
    echo "check-aria-modal-focus-trap: self-test passed."
    exit 0
  fi
  echo "check-aria-modal-focus-trap: self-test FAILED — the predicate cannot be trusted." >&2
  exit 1
fi

if ! self_test; then
  echo "check-aria-modal-focus-trap: self-test failed — refusing to report a result it cannot be trusted to produce." >&2
  exit 1
fi

violations="$(scan_tree || true)"
violation_count=$(printf '%s' "$violations" | grep -c . || true)

echo "aria-modal-focus-trap: $violation_count unpaired dialog(s)."

if [ "$violation_count" -gt 0 ]; then
  {
    echo "::error:: $violation_count file(s) declare aria-modal=\"true\"/{true} with no focus trap (WCAG 2.4.3 / 2.1.2, the #2193 class)."
    echo "  FIX: attach useFocusTrap's ref to the dialog's container —"
    echo ""
    echo "      import { useFocusTrap } from '@/hooks/useFocusTrap';"
    echo "      const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);"
    echo "      <div ref={trapRef} role=\"dialog\" aria-modal=\"true\" tabIndex={-1} …>"
    echo ""
    echo "  and remove any hand-rolled Escape/Tab keydown listener it replaces."
    echo ""
    echo "  If the component hand-rolls a VERIFIED-correct trap instead, add an"
    echo "  inline waiver comment naming why: \`// focus-trap: <reason>\`."
    echo "  If it only ever renders its modal surface through <BottomSheet>,"
    echo "  nothing further is needed — this gate recognizes that shell. Offenders:"
    printf '%s' "$violations" | sed 's/^/    /'
  } >&2
  exit 1
fi

echo "check-aria-modal-focus-trap passed."
exit 0
