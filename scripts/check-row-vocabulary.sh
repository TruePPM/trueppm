#!/usr/bin/env bash
# Fail if the outline's governed vocabulary is written anywhere but its module.
#
# ## What is governed and why
#
# A row in the outline may be a task, a phase, a milestone or a subtask, and
# `structure_role` is declared only once something declares it (ADR-0843). On
# the surfaces that exist BEFORE the type does — column headers, create
# affordances, placeholders, and the name a create path mints — the noun must
# be "item", because any other noun is a claim about a row nobody has made yet.
#
# Everywhere else "task" is the correct word. This gate therefore does NOT scan
# for the word "task"; such a scan would be wrong almost everywhere it fired and
# would demand wrong "fixes" to right strings. See #3031.
#
# ## What this gate is FOR, and what it is not
#
# The primary mechanism is the type system: governed copy is a `VocabularyToken`
# that only `rowVocabulary.ts` can mint, so a literal in a governed prop does not
# compile (packages/web/src/features/schedule/rowVocabulary.ts). `tsc` cannot
# pass vacuously and there is no roster to maintain.
#
# This script covers the residual the types cannot see — a component that
# renders a governed surface without going through the module at all:
#
#   (a) NO SECOND COPY. Every governed string, read out of the module itself,
#       must appear nowhere else in packages/web/src. There is no list here to
#       drift: the strings come from the file the gate is protecting.
#
#   (b) NO LITERAL MINTED NAME. Inside features/schedule/, a `name:` property
#       assigned a multi-word capitalized string literal — or a blank-name
#       fallback (`x.name || 'Untitled task'`) that names a row TYPE — is a name
#       a human will read in a Name cell — and if they abandon the edit it becomes a real
#       committed name in the plan, the WBS and the rollup. That is exactly the
#       defect #3027 found (`+ Item` created a row named "New task"), and it was
#       invisible to a sweep looking at button labels: a row's own name is a
#       stronger type claim than any label.
#
# ## What it is blind to, stated plainly
#
#   * A brand-new component that hardcodes its own freshly-worded type claim.
#     (a) only sees COPIES of strings that already exist. The DOM-level guard in
#     rowVocabularyLock.test.tsx narrows this to "not on the outline surface";
#     nothing closes it completely.
#   * A single-word minted name (`name: 'Task'`). (b)'s shape test needs a space.
#   * Anything outside packages/web/src — the e2e tree is deliberately excluded,
#     because a spec SHOULD pin user-visible copy as its own independent
#     assertion. A spec that asserted through the same constant could not catch
#     a wrong change to it.
#
# A gate that does not say what it cannot see is how a rule survives two hand
# sweeps, so it is said here rather than in a commit message.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_REL="packages/web/src/features/schedule/rowVocabulary.ts"
SRC_REL="packages/web/src"

# ---------------------------------------------------------------------------
# Self-test: this gate's passing output is identical whether it is working or
# has been defeated by a pattern drift, so "it passed" is not evidence it can
# still fail. Prove both assertions against fixtures carrying known violations.
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  # A fixture tree needs at least one INNOCENT outline file, or the gate's own
  # non-vacuity floor (it refuses to scan zero files) fires and every case below
  # would "fail" for the wrong reason — proving nothing about the patterns.
  seed() {
    rm -rf "$tmp/$SRC_REL"
    mkdir -p "$tmp/$SRC_REL/features/schedule"
    cp "$REPO_ROOT/$MODULE_REL" "$tmp/$MODULE_REL"
    printf '%s\n' \
      '// A comment mentioning "New task" and "No items yet." must NOT fire —' \
      '// prose about the rule is not a breach of it.' \
      'export const Clean = () => <span>{ROW_VOCABULARY.empty.title}</span>;' \
      > "$tmp/$SRC_REL/features/schedule/Clean.tsx"
  }

  # (a) a second copy of a governed string
  seed
  printf '%s\n' 'export const X = <span>No items yet.</span>;' \
    > "$tmp/$SRC_REL/features/schedule/Sneaky.tsx"
  if "$0" --root "$tmp" >/dev/null 2>&1; then
    echo "✖ self-test FAILED: a duplicated governed string was not detected" >&2
    exit 1
  fi

  # (b) a literal minted row name
  seed
  printf '%s\n' 'mutate({ name: "New task", duration: 1 });' \
    > "$tmp/$SRC_REL/features/schedule/Minter.tsx"
  if "$0" --root "$tmp" >/dev/null 2>&1; then
    echo "✖ self-test FAILED: a literal minted row name was not detected" >&2
    exit 1
  fi

  # (b2) a blank-name fallback claiming a type
  seed
  printf '%s\n' "const label = snapshot.name || 'Untitled task';" \
    > "$tmp/$SRC_REL/features/schedule/Fallback.tsx"
  if "$0" --root "$tmp" >/dev/null 2>&1; then
    echo "✖ self-test FAILED: a type-claiming blank-name fallback was not detected" >&2
    exit 1
  fi

  # and the clean tree must PASS, or the two above prove nothing
  seed
  if ! "$0" --root "$tmp" >/dev/null 2>&1; then
    echo "✖ self-test FAILED: the gate rejected a tree with no violation" >&2
    exit 1
  fi

  echo "✓ self-test: detects a duplicated string, a literal minted name, and a type-claiming fallback"
  exit 0
fi

ROOT="$REPO_ROOT"
if [[ "${1:-}" == "--root" ]]; then ROOT="$2"; shift 2; fi

MODULE="$ROOT/$MODULE_REL"
SRC="$ROOT/$SRC_REL"

if [[ ! -f "$MODULE" ]]; then
  echo "check-row-vocabulary: $MODULE_REL not found" >&2
  exit 1
fi

python3 - "$MODULE" "$SRC" "$MODULE_REL" <<'PY'
import pathlib, re, sys

module_path, src_root, module_rel = sys.argv[1], sys.argv[2], sys.argv[3]
module_src = pathlib.Path(module_path).read_text()
src = pathlib.Path(src_root)

# -- Read the governed strings OUT OF THE MODULE. ---------------------------
# Only the ROW_VOCABULARY object is scanned for duplication. ROW_NOUN and its
# plural are deliberately excluded: "item" is a single common word that appears
# legitimately all over the tree, and a gate that flagged it would be the
# indiscriminate scan this one exists not to be.
body = module_src.split('export const ROW_VOCABULARY', 1)
if len(body) != 2:
    print("✖ ROW_VOCABULARY not found — the gate cannot read what it protects", file=sys.stderr)
    sys.exit(1)
governed = re.findall(r"lock\(\s*(['\"])(.*?)\1\s*,?\s*\)", body[1], re.S)
governed = [g[1] for g in governed]

MIN_TOKENS = 12  # non-vacuity floor; the module has more than this today
if len(governed) < MIN_TOKENS:
    print(f"✖ read only {len(governed)} governed strings from {module_rel} "
          f"(expected >= {MIN_TOKENS}) — the extraction has drifted and this "
          f"gate would pass by matching nothing", file=sys.stderr)
    sys.exit(1)

SCOPE = 'features/schedule/'   # the outline's own tree — see header
files = [q for q in list(src.rglob('*.ts')) + list(src.rglob('*.tsx'))
         if '.test.' not in q.name
         and q.name != 'rowVocabulary.ts'
         and SCOPE in str(q).replace('\\', '/')]

if not files:
    print(f"✖ scanned 0 files under {SCOPE} — the gate would pass by matching "
          f"nothing", file=sys.stderr)
    sys.exit(1)

def code_lines(text):
    """Yield (lineno, line) for lines that render copy, skipping prose.

    Comments are excluded on purpose: this gate governs what the product SAYS,
    and a docstring explaining why a row is named "New item" is documentation of
    the rule, not a violation of it. Stripping them is what keeps the gate from
    punishing the comments that make the rule legible.
    """
    in_block = False
    for i, line in enumerate(text.split('\n'), 1):
        stripped = line.strip()
        if in_block:
            if '*/' in stripped:
                in_block = False
            continue
        if stripped.startswith('/*') or stripped.startswith('{/*'):
            # JSX comments open with `{/*` and close with `*/}`; a multi-line one
            # is where five of this gate's first six hits lived, all of them
            # prose ABOUT the rule rather than breaches of it.
            if '*/' not in stripped:
                in_block = True
            continue
        if stripped.startswith('//') or stripped.startswith('*'):
            continue
        yield i, line

fail = False

# -- (a) no second copy of a governed string --------------------------------
# Matched as a COMPLETE string literal or as standalone JSX text, never as a
# substring: 'Item' must not fire on `localStorage.setItem`, and the first
# draft of this gate reported 200+ such hits, which is its own lesson about
# what a scan of short common words costs.
for token in governed:
    esc = re.escape(token)
    literal = re.compile(r"""(['"`])%s\1""" % esc)
    jsx_text = re.compile(r">\s*%s\s*<" % esc)
    for q in files:
        for i, line in code_lines(q.read_text()):
            if literal.search(line) or jsx_text.search(line):
                print(f"✖ {q}:{i}: governed copy written here instead of "
                      f"imported from rowVocabulary: {token!r}", file=sys.stderr)
                fail = True

# -- (b) no literal minted row name inside the outline ----------------------
# A multi-word capitalized literal assigned to `name:` is a name a human reads.
# Single words ('Name', 'description') are field descriptors, and '' asserts
# nothing — both pass, and both limits are recorded in the header.
MINTED = re.compile(r"""\bname:\s*(['"])([A-Z][^'"]*\s[^'"]*)\1""")

# A blank-name FALLBACK is the same slot reached by a different operator, and
# `snapshot.name || 'Untitled task'` is not a `name:` assignment — two of them
# were live when this gate was written, one on a delete toast. Narrow on
# purpose: only a fallback that names a row TYPE is caught, so `|| 'Untitled
# item'` passes. This is NOT the indiscriminate "no `task` anywhere" scan the
# issue forbids — a NAME is the one slot where a type word is never a
# description and always a claim about a row nobody has typed.
FALLBACK = re.compile(
    r"""(?:\|\||\?\?)\s*(['"])((?:New|Untitled)\s+(?:tasks?|phases?|milestones?|subtasks?))\1""",
    re.I)

for q in files:
    for i, line in code_lines(q.read_text()):
        for rx, why in ((MINTED, 'a row name minted from a literal'),
                        (FALLBACK, 'a blank-name fallback that claims a row type')):
            m = rx.search(line)
            if m:
                print(f"✖ {q}:{i}: {why}: {m.group(2)!r} — "
                      f"take it from ROW_VOCABULARY.minted so the noun is governed",
                      file=sys.stderr)
                fail = True


if fail:
    print("", file=sys.stderr)
    print("The outline's vocabulary has ONE owner: " + module_rel, file=sys.stderr)
    print("Import the token rather than writing the words again (#3031).", file=sys.stderr)
    sys.exit(1)

print(f"✓ row vocabulary: {len(governed)} governed strings, {len(files)} outline files, each written once")
PY
