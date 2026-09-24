#!/bin/sh
# scripts/release-page-summary.sh — print a CHANGELOG section's summary prose
#
# Usage: sh scripts/release-page-summary.sh <version> [CHANGELOG.md]
#
# Prints the text between "## [<version>]" and its first "### " category (or
# the next "## [" section): the summary that release.sh writes at the top of
# every dated section. release:create publishes it on the GitLab Release page.
#
# Leading and trailing blank lines are dropped and runs of blank lines collapse
# to one, but a single blank line between paragraphs is KEPT. Markdown needs it:
# without it the paragraphs render as one block, which is how the bolded
# upgrade warning in a summary disappeared into the paragraph before it (#4041).
#
# POSIX sh + awk only: release:create runs in the release-cli image, which has
# no bash or python.

set -eu

version="${1:?usage: release-page-summary.sh <version> [CHANGELOG.md]}"
changelog="${2:-CHANGELOG.md}"

awk -v heading="## [${version}]" '
  index($0, heading) == 1 { found = 1; next }
  found && (/^## \[/ || /^### /) { exit }
  !found { next }
  /^[ \t\r]*$/ { if (started) pending = 1; next }
  { if (pending) print ""; print; started = 1; pending = 0 }
' "$changelog"
