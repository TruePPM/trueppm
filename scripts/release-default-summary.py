#!/usr/bin/env python3
"""Print the default release summary: the prose under ``## [Unreleased]``.

Used by ``scripts/release.sh``. The summary is everything between the
``## [Unreleased]`` heading and the first ``###`` category (or the next
``## [`` section), trimmed of surrounding blank lines.

The ``_Nothing yet._`` placeholder that every release rotation leaves under a
fresh ``[Unreleased]`` is not prose, so it is dropped. Without that, the
placeholder is a non-empty default summary: ``--yes`` cuts the release with it
and ``release:create`` publishes it on the GitLab Release page. With it dropped,
an untouched ``[Unreleased]`` yields an empty summary and release.sh fails
closed asking for one.

Usage: release-default-summary.py CHANGELOG.md
"""

import sys

PLACEHOLDER = "_Nothing yet._"


def default_summary(text: str) -> str:
    buf: list[str] = []
    found = False
    for line in text.split("\n"):
        if line.strip() == "## [Unreleased]":
            found = True
            continue
        if found and (line.startswith("### ") or line.startswith("## [")):
            break
        if found and line.strip() != PLACEHOLDER:
            buf.append(line)
    return "\n".join(buf).strip("\n")


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(default_summary(fh.read()))
