#!/usr/bin/env bash
# Every ```mermaid fence in the docs must reach dist/ as a rendered inline <svg>
# — and the build log must be free of content-loader errors (#2797).
#
# WHY THIS IS A SEPARATE GATE FROM check-playwright-pins.sh:
# rehype-mermaid renders fences at build time by driving a headless browser
# (ADR-0198). When that browser cannot launch, Astro's starlight-docs-loader
# CATCHES the error, logs `[ERROR] Failed to parse Markdown file …`, drops the
# ENTIRE page body, still emits an index.html, and `astro build` exits 0.
#
# So a page that loses 100% of its content is indistinguishable from success at
# the exit-code level. Three pages published as bare navigation chrome (99 chars
# of body text, one <h2> instead of eleven) for 19 days across green pipelines.
#
# Pinning the Playwright version closes the cause we know about. This closes the
# SILENCE, which is what let it run for 19 days — any future cause (a malformed
# fence, a renderer upgrade, an OOM in the headless browser) now fails the
# pipeline instead of quietly publishing a blank page.
#
# Modes:
#   bash scripts/check-mermaid-rendered.sh [build-log]   # run AFTER npm run build
#   bash scripts/check-mermaid-rendered.sh --self-test   # prove the check can fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOCS_REL="packages/website/src/content/docs"
DIST_REL="packages/website/dist"

# run_check <docs-dir> <dist-dir> [build-log]
run_check() {
  local docs="$1" dist="$2" log="${3:-}" fail=0 found_any=0

  if [ ! -d "$dist" ]; then
    echo "ERROR: $dist does not exist — run 'npm run build' in packages/website first" >&2
    return 2
  fi
  if [ ! -d "$docs" ]; then
    echo "ERROR: docs directory not found: $docs" >&2
    echo "       If it moved, update DOCS_REL in $0 — do not delete the guard." >&2
    return 2
  fi

  # 1. Every fence must have become a rendered diagram.
  #
  # Mermaid stamps exactly one `aria-roledescription` per diagram it renders
  # (flowchart-v2, sequence, …), so the count is 1:1 with fences. Starlight's own
  # UI icons are plain <svg> with no roledescription, so a bare '<svg' count would
  # match ~50 per page and prove nothing.
  local md rel fences slug html rendered ids
  while IFS= read -r md; do
    found_any=1
    rel="${md#"$docs"/}"
    # `|| true` on every count: under `set -e` + `pipefail`, grep exits 1 on ZERO
    # matches — precisely the failing case this gate must report. Without the
    # guard the script dies mid-loop and exits 1 having printed NOTHING, which is
    # barely an improvement on the silent build it was written to catch.
    fences="$(grep -c '^```mermaid' "$md" || true)"

    # src/content/docs/a/b.md -> dist/a/b/index.html ; index.md -> dist/a/index.html
    slug="${rel%.md}"
    if [ "$slug" = "index" ]; then
      html="$dist/index.html"
    elif [ "${slug%/index}" != "$slug" ]; then
      html="$dist/${slug%/index}/index.html"
    else
      html="$dist/$slug/index.html"
    fi

    if [ ! -f "$html" ]; then
      echo "  VIOLATION: $rel has $fences mermaid fence(s) but ${html#"$dist"/} was not emitted"
      fail=1
      continue
    fi

    rendered="$(grep -o 'aria-roledescription' "$html" | wc -l | tr -d ' ' || true)"
    if [ "$rendered" -lt "$fences" ]; then
      ids="$(grep -o 'id="mermaid' "$html" | wc -l | tr -d ' ' || true)"
      echo "  VIOLATION: $rel has $fences mermaid fence(s) but only $rendered rendered diagram(s) in ${html#"$dist"/} (mermaid ids: $ids)"
      fail=1
    fi
  done < <(grep -rl '^```mermaid' "$docs" || true)

  if [ "$found_any" -eq 0 ]; then
    # Matching nothing is not success — it is a gate that can no longer fail.
    echo 'ERROR: no ```mermaid fences found under '"$docs" >&2
    echo "       Either the docs stopped using Mermaid (delete this gate) or the" >&2
    echo "       path drifted. A gate matching nothing catches nothing." >&2
    return 2
  fi

  # 2. The build log must be clean. Catches the same silent-drop class for causes
  #    that have nothing to do with Mermaid.
  if [ -n "$log" ]; then
    if [ ! -f "$log" ]; then
      echo "ERROR: build log not found: $log" >&2
      return 2
    fi
    if grep -q '\[ERROR\]' "$log"; then
      echo "  VIOLATION: the website build logged [ERROR] lines despite exiting 0:"
      grep '\[ERROR\]' "$log" | head -20 | sed 's/^/      /'
      fail=1
    fi
  fi

  if [ "$fail" -ne 0 ]; then
    cat <<'EOF'

The docs site built "successfully" but lost content.

`astro build` exits 0 even when starlight-docs-loader drops a whole page body,
so the exit code is not evidence. Look for `[ERROR] Failed to parse Markdown
file` in the build output.

Most likely cause: the Playwright npm version no longer matches the browsers
baked into the CI image, so rehype-mermaid cannot launch a browser. Run:

    bash scripts/check-playwright-pins.sh
EOF
    return 1
  fi

  echo '✅ every ```mermaid fence rendered to an inline <svg>; build log clean'
  return 0
}

# The failure this gate exists for produces a GREEN build, so "it passed on a
# good tree" proves nothing about it. These cases are the shapes actually
# observed on #2797: a page emitted with its diagram (and body) gone, a page not
# emitted at all, and a build that logged [ERROR] while exiting 0.
self_test() {
  local tmp docs dist log status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  docs="$tmp/docs"; dist="$tmp/dist"; log="$tmp/build.log"
  mkdir -p "$docs/architecture" "$dist/architecture/overview"

  # shellcheck disable=SC2016  # the backticks are a literal markdown fence, not a subshell
  printf '# Overview\n\n```mermaid\nflowchart TD\n  A --> B\n```\n' \
    > "$docs/architecture/overview.md"
  printf 'clean build\n' > "$log"

  _rendered() {
    printf '<html><body><svg aria-roledescription="flowchart-v2" id="mermaid-0"></svg></body></html>\n' \
      > "$dist/architecture/overview/index.html"
  }

  # Case 1: the fence rendered. Must pass.
  _rendered
  status=0; run_check "$docs" "$dist" "$log" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a correctly rendered diagram was reported as missing (exit $status)" >&2
    return 1
  fi

  # Case 2: #2797 exactly — page emitted, body and diagram silently dropped.
  printf '<html><body><a>Edit page</a></body></html>\n' \
    > "$dist/architecture/overview/index.html"
  status=0; run_check "$docs" "$dist" "$log" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: an emitted-but-empty page was not caught (exit $status)" >&2
    return 1
  fi

  # Case 3: the page was not emitted at all.
  rm "$dist/architecture/overview/index.html"
  status=0; run_check "$docs" "$dist" "$log" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a missing output page was not caught (exit $status)" >&2
    return 1
  fi

  # Case 4: diagrams fine, but the build logged [ERROR] and still exited 0.
  _rendered
  printf '08:10:07 [ERROR] [starlight-docs-loader] Error rendering features/foo.md\n' >> "$log"
  status=0; run_check "$docs" "$dist" "$log" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: an [ERROR] line in a zero-exit build was not caught (exit $status)" >&2
    return 1
  fi

  # Case 5: no fences at all must ERROR, not pass — a gate that matches nothing
  # would have reported success throughout the entire 19-day outage.
  printf 'clean build\n' > "$log"
  rm "$docs/architecture/overview.md"
  status=0; run_check "$docs" "$dist" "$log" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 2 ]; then
    echo "SELF-TEST FAIL: zero matched fences exited $status, expected 2" >&2
    return 1
  fi

  echo "SELF-TEST OK: rendered passes; emptied page, missing page, [ERROR]-on-exit-0, and a gate matching nothing all caught."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT/$DOCS_REL" "$REPO_ROOT/$DIST_REL" "${1:-}"
fi
