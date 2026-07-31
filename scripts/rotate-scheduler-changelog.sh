#!/usr/bin/env bash
# scripts/rotate-scheduler-changelog.sh — rotate the standalone scheduler
# package CHANGELOG at release time.
#
# Usage:
#   bash scripts/rotate-scheduler-changelog.sh <new_pep440> <prev_pep440> <date> [changelog_path]
#
# Example (cutting 0.3.0a1 over 0.2.0a1 on 2026-06-28):
#   bash scripts/rotate-scheduler-changelog.sh 0.3.0a1 0.2.0a1 2026-06-28
#
# The repo-root CHANGELOG.md is the suite-wide changelog and is rotated by
# scripts/release.sh via scripts/assemble-changelog.sh. The PyPI package
# trueppm-scheduler ships its OWN packages/scheduler/CHANGELOG.md (force-included
# into the wheel), whose [Unreleased] section is hand-maintained during the
# cycle. Nothing rotated it at tag time, so a published wheel would carry a
# perpetual [Unreleased] with no dated section. This script closes that gap:
# release.sh calls it so every scheduler tag ships dated release notes.
#
# What it does, idempotently:
#   1. Rotates "## [Unreleased]" into "## [<new>] - <date>", preserving the
#      ### Added / Changed / Fixed / Security blocks written during the cycle.
#      A cycle that touched nothing library-facing (empty section or the
#      "_Nothing yet._" placeholder) still gets a dated section recording that.
#   2. Leaves a fresh empty "## [Unreleased]" on top for the next cycle.
#   3. Advances the compare-link footer: the [Unreleased] link points at the new
#      tag, and a new "[<new>]: …compare/scheduler-v<prev>...scheduler-v<new>"
#      line is inserted.
#
# Re-running with a <new> that already has a dated section is a no-op, so a
# retried release does not double-rotate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

NEW_VERSION="${1:-}"
PREV_VERSION="${2:-}"
DATE="${3:-}"
CHANGELOG="${4:-packages/scheduler/CHANGELOG.md}"

[[ -n "$NEW_VERSION" && -n "$PREV_VERSION" && -n "$DATE" ]] \
  || { echo "usage: $0 <new_pep440> <prev_pep440> <date> [changelog_path]" >&2; exit 2; }
[[ -f "$CHANGELOG" ]] || { echo "error: $CHANGELOG not found" >&2; exit 1; }
grep -q '^## \[Unreleased\]' "$CHANGELOG" \
  || { echo "error: $CHANGELOG has no '## [Unreleased]' section" >&2; exit 1; }

NEW_VERSION="$NEW_VERSION" PREV_VERSION="$PREV_VERSION" DATE="$DATE" \
python3 - "$CHANGELOG" <<'PY'
import os, re, sys

path = sys.argv[1]
new = os.environ["NEW_VERSION"]
prev = os.environ["PREV_VERSION"]
date = os.environ["DATE"]

text = open(path).read()
lines = text.split("\n")

# Idempotency guard: if this version was already rotated in, do nothing. The
# rotated heading is "## [<new>] - <date>", so match on the bracketed prefix
# (the trailing "]" prevents 0.3.0a1 from matching 0.3.0a10).
#
# BUT a no-op here is only safe when the version was genuinely released. A dated
# section for a version with no tag means someone hand-wrote the heading ahead of
# the release — and then every entry written afterwards accumulates under
# [Unreleased], where this guard silently leaves it. The wheel ships with the new
# work filed under "Unreleased" and the version's own section describing an older
# state. That is how 0.4.0b1 came to hold a dated section from 2026-07-18 while
# the BREAKING Calendar.exceptions change sat above it in [Unreleased] (#2605),
# and PyPI releases are not retractable.
#
# So: no-op quietly only if the tag exists (a genuine retry). Otherwise refuse.
if any(l.startswith(f"## [{new}]") for l in lines):
    import subprocess

    tag = f"scheduler-v{new}"
    tag_exists = (
        subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}"],
            capture_output=True,
        ).returncode
        == 0
    )
    if tag_exists:
        print(f"  {path}: [{new}] already present and {tag} exists — retry, skipping rotation.")
        sys.exit(0)

    unreleased_body = text.split("## [Unreleased]", 1)[-1].split("\n## [", 1)[0]
    has_content = any(
        ln.strip().startswith(("-", "*"))
        for ln in unreleased_body.split("\n")
        if "_Nothing yet._" not in ln
    )
    print(
        f"error: {path} has a dated '## [{new}]' section but no {tag} tag.\n"
        f"       The heading was written before the release, so this rotation would\n"
        f"       be a no-op"
        + (
            " and the entries still under [Unreleased] would ship\n"
            "       filed as unreleased in the published wheel.\n"
            if has_content
            else ".\n"
        )
        + f"       Fix: merge the '## [{new}]' section's entries back up into\n"
        f"       [Unreleased] and delete the premature heading, then re-run. The\n"
        f"       release is what dates a section — never write the heading by hand.",
        file=sys.stderr,
    )
    sys.exit(1)

# --- Rotate the [Unreleased] heading + body into a dated section ----------
out, i, n = [], 0, len(lines)
rotated = False
while i < n:
    if lines[i].strip() == "## [Unreleased]":
        # Body runs until the next "## [" heading (or EOF). The footer link
        # definitions start with "[" but never "## [", so they are untouched.
        j = i + 1
        body = []
        while j < n and not lines[j].startswith("## ["):
            body.append(lines[j])
            j += 1
        # Trim surrounding blank lines from the captured body.
        while body and body[0].strip() == "":
            body.pop(0)
        while body and body[-1].strip() == "":
            body.pop()
        # A cycle that recorded nothing (empty or the placeholder) still gets a
        # dated section so every release has a traceable entry.
        if not body or [b.strip() for b in body] == ["_Nothing yet._"]:
            body = ["_No library-facing changes in this release._"]
        out += [
            "## [Unreleased]", "",
            "_Nothing yet._", "",
            f"## [{new}] - {date}", "",
            *body, "",
        ]
        i = j
        rotated = True
        continue
    out.append(lines[i])
    i += 1

if not rotated:
    sys.exit("error: [Unreleased] heading not found while rotating")

# --- Advance the compare-link footer --------------------------------------
# Reuse the existing [Unreleased] link's URL prefix (everything up to and
# including "/compare/") so the host/path is never hard-coded here. Fall back to
# the canonical GitLab compare URL if the footer link is missing.
DEFAULT_PREFIX = "https://gitlab.com/trueppm/trueppm/-/compare/"
prefix = DEFAULT_PREFIX
unreleased_idx = None
link_re = re.compile(r"^\[Unreleased\]:\s*(?P<prefix>.*/compare/)scheduler-v\S+\.\.\.\S+\s*$")
for idx, l in enumerate(out):
    m = link_re.match(l)
    if m:
        prefix = m.group("prefix")
        unreleased_idx = idx
        break

new_unreleased_link = f"[Unreleased]: {prefix}scheduler-v{new}...main"
new_version_link = f"[{new}]: {prefix}scheduler-v{prev}...scheduler-v{new}"

if unreleased_idx is not None:
    out[unreleased_idx] = new_unreleased_link
    out.insert(unreleased_idx + 1, new_version_link)
else:
    # No recognizable footer — append a fresh link block.
    if out and out[-1].strip() != "":
        out.append("")
    out += [new_unreleased_link, new_version_link]

# Collapse runs of blank lines to a single blank, end with exactly one newline.
cleaned, blank = [], False
for l in out:
    b = (l.strip() == "")
    if b and blank:
        continue
    cleaned.append(l)
    blank = b
open(path, "w").write("\n".join(cleaned).rstrip("\n") + "\n")
print(f"  {path}: [Unreleased] -> [{new}] - {date}")
PY
