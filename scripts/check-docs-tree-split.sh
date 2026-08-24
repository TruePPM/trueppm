#!/usr/bin/env bash
# Docs tree-split gate (#2928).
#
# Two documentation trees exist and only one of them is gated:
#
#   packages/website/src/content/docs/  -- the PUBLISHED product docs. Six gates
#       cover it: check-version-status.sh (tense + the documentedFor declaration
#       ratchet + the sidebar badge pairing), check-adr-status.sh,
#       check-mermaid-rendered.sh, check-ws-event-reachability.sh,
#       check-boundary-doc-command.sh, and release.sh.
#   docs/  -- ADRs, specs, audits, design records, maintainer notes. Engineering
#       artifacts. NOT product documentation, and covered by none of the above.
#
# For months `docs/administration/` held a second copy of eight published pages.
# All eight had diverged, the website copy was 2-5x more complete on every one,
# and `scripts/backup.sh --help` pointed operators at the stale half -- the copy
# missing the warning that a restore onto a fresh cluster silently orphans every
# stored SMTP credential and integration PAT. Nothing failed. Nothing could:
# every gate path-matches the website tree, so the duplicate was structurally
# invisible.
#
# Deleting those eight files buys nothing beyond today unless something makes
# the next re-divergence loud. That is this script. Two rules:
#
#   1. NO SHARED BASENAME. A *.md basename under docs/ (excluding the artifact
#      subtrees below) must not also exist anywhere under the website tree.
#      Basename rather than relative path on purpose: `mcp-connect.md` sat at
#      `docs/administration/` and `website/.../features/` -- different paths,
#      same page, and a path comparison saw nothing.
#
#   2. NO DEAD `docs/` POINTER. A repo-relative `docs/....md` path cited from
#      running code, CI config or a developer README must exist. This is the
#      half that reached an operator -- `backup.sh --help` named a file, and
#      after the duplicate is deleted that name resolves to nothing.
#
#      Deliberately NOT "must not cite docs/<published tree>" at all. That
#      phrasing was tried first and produced 37 hits, nearly all of them third-
#      party URLs (`kubernetes.io/docs/reference/...`), `$docs/features/` shell
#      variables inside other gates' own fixtures, and this file's own prose. A
#      rule that noisy gets disabled and takes the real protection with it.
#
#      Two narrowings keep it exact. The path must sit under a PUBLISHED_TREES
#      name -- which drops `docs/field_id_reference.md`, a file belonging to a
#      third-party fixture generator's own repository. And the artifact subtrees
#      are exempt as sources: a design record or spec legitimately names a
#      deliverable that does not exist yet (`docs/design/schedule-pdf-export.md`
#      naming the page #1439 will create), and that is a plan, not a pointer.
#
# Exit codes:
#   0  clean
#   1  a violation
#   2  invocation / setup error
#
# Modes:
#   bash scripts/check-docs-tree-split.sh              # scan the repo
#   bash scripts/check-docs-tree-split.sh --self-test  # synthesize fixtures, assert

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DEFAULT="docs"
WEBSITE_DEFAULT="packages/website/src/content/docs"

# Subtrees of docs/ that are engineering artifacts, not product documentation.
# A basename collision here is meaningless -- an ADR and a feature page may
# legitimately share a word -- and ADRs are explicitly exempt from docs rules
# elsewhere (they are design-decision records, forward-tense by nature).
ARTIFACT_DIRS="adr api audits design maintainers specs ux durability"

# Trees inside the website whose names, used under docs/, mean "product docs in
# the wrong place". Rule 2 matches `docs/<one of these>/`.
PUBLISHED_TREES="administration features getting-started architecture guides overview reference integration"

# Paths that legitimately carry a historical `docs/<tree>/` string. CHANGELOG.md
# is an assembled release artifact recording what was true at each tag (and
# CLAUDE.md forbids editing it directly); ADRs are point-in-time design records
# whose "Affected packages" lists must not be rewritten to match a later move.
is_exempt_source() {
  case "$1" in
    */CHANGELOG.md|CHANGELOG.md) return 0 ;;
    # This gate's own prose and self-test fixtures must contain the exact
    # strings it looks for, or the cases could not assert anything.
    */check-docs-tree-split.sh|scripts/check-docs-tree-split.sh) return 0 ;;
    *) ;;
  esac
  # Engineering artifacts name planned and historical deliverables. A design
  # record pointing at the page an unstarted issue will create is a plan, not a
  # broken link, and rewriting it would falsify the record.
  local d
  for d in $ARTIFACT_DIRS; do
    case "$1" in */docs/"$d"/*|docs/"$d"/*|./docs/"$d"/*) return 0 ;; esac
  done
  return 1
}

# Rule 1: basenames shared between the two trees.
check_shared_basenames() { # <docs_root> <website_root>
  local docs_root="$1" website_root="$2" violations=0
  [ -d "$docs_root" ] || return 0
  [ -d "$website_root" ] || return 0

  local prune=() d
  for d in $ARTIFACT_DIRS; do
    prune+=(-path "$docs_root/$d" -prune -o)
  done

  local docs_files website_names base match
  docs_files="$(find "$docs_root" "${prune[@]}" -name '*.md' -print 2>/dev/null | sort)"
  website_names="$(find "$website_root" -name '*.md' -print 2>/dev/null \
    | sed 's|.*/||' | sort -u)"

  while IFS= read -r f; do
    [ -z "$f" ] && continue
    base="${f##*/}"
    if printf '%s\n' "$website_names" | grep -qxF "$base"; then
      match="$(find "$website_root" -name "$base" -print 2>/dev/null | head -n 1)"
      echo "VIOLATION: $f duplicates a published page basename" >&2
      echo "    The published, gated copy is: $match"
      echo "    docs/ is for ADRs, specs and design records -- not a second copy"
      echo "    of the product docs. Delete this file, porting anything the"
      echo "    published copy lacks, and cite the website path instead."
      violations=$((violations + 1))
    fi
  done <<< "$docs_files"

  return "$violations"
}

# Rule 2: a cited repo-relative docs/ path must resolve to a real file.
check_source_pointers() { # <root>
  local root="$1" violations=0 hits line f path

  hits="$(grep -rnoE '(^|[^-a-zA-Z0-9_./$])docs/[a-z0-9][a-z0-9._/-]*\.md' "$root" \
    --include='*.sh' --include='*.yml' --include='*.yaml' \
    --include='*.py' --include='*.ts' --include='*.tsx' --include='*.md' \
    2>/dev/null \
    | grep -v '/node_modules/' \
    | grep -v '/\.venv/' \
    | grep -v '://' \
    || true)"

  [ -z "$hits" ] && return 0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    f="${line%%:*}"
    is_exempt_source "$f" && continue
    # grep -o output is  <file>:<lineno>:<match>; the match may carry the
    # boundary character the pattern had to consume.
    path="${line#*:}"; path="${path#*:}"
    path="$(printf '%s' "$path" | sed -E 's|^[^d]*||')"
    # Only paths under a published tree name. `docs/field_id_reference.md`
    # belongs to a third-party generator's repo, not ours.
    local t matched=""
    for t in $PUBLISHED_TREES; do
      case "$path" in docs/"$t"/*) matched=1; break ;; esac
    done
    [ -z "$matched" ] && continue
    [ -f "$root/$path" ] && continue
    [ -f "$path" ] && continue
    echo "VIOLATION: ${line%%:*}: cites $path, which does not exist" >&2
    echo "    A pointer an operator or developer follows must resolve. If the"
    echo "    page moved to the published tree, cite"
    echo "    packages/website/src/content/docs/... for a developer reference or"
    echo "    https://docs.trueppm.com/... for anything an operator reads."
    violations=$((violations + 1))
  done <<< "$hits"

  return "$violations"
}

run_scan() { # <docs_root> <website_root> <source_root>
  local docs_root="$1" website_root="$2" source_root="$3" total=0 rc

  rc=0; check_shared_basenames "$docs_root" "$website_root" || rc=$?
  total=$((total + rc))

  rc=0; check_source_pointers "$source_root" || rc=$?
  total=$((total + rc))

  if [ "$total" -gt 0 ]; then
    {
      echo ""
      echo "ERROR: $total docs tree-split violation(s)."
      echo "The published, gated tree is packages/website/src/content/docs/."
      echo "docs/ holds ADRs, specs, audits and design records only."
    } >&2
    return 1
  fi
  echo "OK: no duplicated page basenames, no source pointer at an ungated docs tree."
  return 0
}

self_test() {
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  local fails=0

  _case() { # _case <name> <expect-pass|expect-fail> <dir>
    local name="$1" expect="$2" dir="$3"
    if run_scan "$dir/docs" "$dir/web" "$dir" >/dev/null 2>&1; then
      if [ "$expect" = "expect-pass" ]; then echo "SELF-TEST OK: $name accepted."
      else echo "SELF-TEST FAILED: $name was accepted and should not be." >&2; fails=$((fails+1)); fi
    else
      if [ "$expect" = "expect-fail" ]; then echo "SELF-TEST OK: $name correctly rejected."
      else echo "SELF-TEST FAILED: $name was rejected and should not be." >&2; fails=$((fails+1)); fi
    fi
  }

  # Clean: docs/ holds only artifacts, no shared basename, no bad pointer.
  local d="$tmp/clean"; mkdir -p "$d/docs/adr" "$d/web/administration"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# backup" > "$d/web/administration/backup-restore.md"
  _case "clean-tree" expect-pass "$d"

  # THE defect: the same page in both trees, at DIFFERENT relative paths. A
  # path comparison sees nothing here; that is why the rule is basename.
  d="$tmp/dupe-diff-path"; mkdir -p "$d/docs/administration" "$d/web/features"
  echo "# stale" > "$d/docs/administration/mcp-connect.md"
  echo "# maintained" > "$d/web/features/mcp-connect.md"
  _case "shared-basename-different-paths" expect-fail "$d"

  # Same page, same relative path.
  d="$tmp/dupe-same-path"; mkdir -p "$d/docs/administration" "$d/web/administration"
  echo "# stale" > "$d/docs/administration/retention.md"
  echo "# maintained" > "$d/web/administration/retention.md"
  _case "shared-basename-same-path" expect-fail "$d"

  # An ADR may share a word with a published page -- artifacts are exempt, or
  # the gate would fire on the 335 ADRs and get disabled.
  d="$tmp/adr-collision"; mkdir -p "$d/docs/adr" "$d/web/features"
  echo "# adr" > "$d/docs/adr/retention.md"
  echo "# page" > "$d/web/features/retention.md"
  _case "artifact-subtree-exempt" expect-pass "$d"

  # Rule 2: the pointer that actually reached an operator.
  d="$tmp/bad-pointer"; mkdir -p "$d/docs/adr" "$d/web/administration" "$d/scripts"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# backup" > "$d/web/administration/backup-restore.md"
  printf 'echo "See docs/administration/backup-restore.md."\n' > "$d/scripts/backup.sh"
  _case "source-cites-ungated-tree" expect-fail "$d"

  # The corrected forms must both pass, or the gate has no exit.
  d="$tmp/good-pointer"; mkdir -p "$d/docs/adr" "$d/web/administration" "$d/scripts"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# backup" > "$d/web/administration/backup-restore.md"
  printf 'echo "See https://docs.trueppm.com/administration/backup-restore/."\n' > "$d/scripts/a.sh"
  printf '# packages/website/src/content/docs/administration/backup-restore.md\n' > "$d/scripts/b.sh"
  _case "corrected-pointers-accepted" expect-pass "$d"

  # CHANGELOG.md and ADRs record what was true at a tag; rewriting them to match
  # a later move would falsify the record.
  d="$tmp/historical"; mkdir -p "$d/docs/adr" "$d/web/administration"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# backup" > "$d/web/administration/backup-restore.md"
  printf 'See `docs/administration/retention.md`.\n' > "$d/CHANGELOG.md"
  printf 'Docs: `docs/administration/` SSO page.\n' > "$d/docs/adr/0517-sso.md"
  _case "historical-artifacts-exempt" expect-pass "$d"

  # The two narrowings that keep rule 2 exact. Both were judgement calls made
  # against real hits, so they are pinned rather than left to the next reader.

  # A path with no published-tree prefix belongs to somebody else. This is
  # `docs/field_id_reference.md`, owned by a third-party fixture generator's
  # own repository -- flagging it would demand we fix a file we do not have.
  d="$tmp/foreign-path"; mkdir -p "$d/docs/adr" "$d/web/administration" "$d/pkg"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# backup" > "$d/web/administration/backup-restore.md"
  printf "The generator's \`docs/field_id_reference.md\` is the source of truth.\n" \
    > "$d/pkg/README.md"
  _case "foreign-docs-path-ignored" expect-pass "$d"

  # A design record naming the page an unstarted issue will create is a plan,
  # not a broken link. Rewriting it would falsify the record.
  d="$tmp/design-plan"; mkdir -p "$d/docs/design" "$d/web/features"
  echo "# page" > "$d/web/features/schedule.md"
  printf 'deliverable: docs/features/schedule-export.md (Layout A)\n' \
    > "$d/docs/design/schedule-pdf-export.md"
  _case "design-record-names-planned-page" expect-pass "$d"

  # But the same dead pointer from RUNNING CODE is the defect, not a plan.
  d="$tmp/code-plan"; mkdir -p "$d/docs/adr" "$d/web/features" "$d/pkg"
  echo "# adr" > "$d/docs/adr/0001-thing.md"
  echo "# page" > "$d/web/features/scheduler.md"
  printf 'Add a row to the table in `docs/features/scheduler.md`.\n' > "$d/pkg/CONTRIBUTING.md"
  _case "code-cites-missing-published-page" expect-fail "$d"

  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: $fails case(s) failed." >&2
    return 1
  fi
  echo "SELF-TEST: all cases passed."
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then self_test; return $?; fi
  cd "$REPO_ROOT"
  run_scan "${DOCS_OVERRIDE:-$DOCS_DEFAULT}" "${WEBSITE_OVERRIDE:-$WEBSITE_DEFAULT}" "."
}

main "$@"
