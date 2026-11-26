"""PUT one file to this project's GitLab Generic Package Registry.

Usage: upload_generic_package.py <url> <file> [content-type]

Authenticates with CI_JOB_TOKEN (scoped to this project). Used by scheduler:build
to publish the conformance-corpus tarball and its checksum (#4165); the SBOM upload
beside it predates this helper and is left as it was. Written in Python because the
publish image (python:3.11-slim) ships neither curl nor wget.
"""

import os
import sys
import urllib.error
import urllib.request


def main(argv: list[str]) -> int:
    """Upload ``argv[1]`` to the URL ``argv[0]``; return a process exit code."""
    if len(argv) not in (2, 3):
        sys.stderr.write(__doc__ or "")
        return 2
    url, path = argv[0], argv[1]
    content_type = argv[2] if len(argv) == 3 else "application/octet-stream"
    with open(path, "rb") as fh:
        payload = fh.read()
    req = urllib.request.Request(
        url,
        data=payload,
        method="PUT",
        headers={"JOB-TOKEN": os.environ["CI_JOB_TOKEN"], "Content-Type": content_type},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"published ({resp.status}): {url}")
    except urllib.error.HTTPError as e:
        sys.stderr.write(
            f"Generic Package Registry upload failed: HTTP {e.code} {e.reason}\n"
        )
        sys.stderr.write(e.read().decode("utf-8", "replace") + "\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
