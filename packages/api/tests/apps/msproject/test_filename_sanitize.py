"""Filename sanitization tests for msproject uploads (#816).

`UploadedFile.name` is attacker-controlled via the multipart
`Content-Disposition` header — control chars, HTML metacharacters, path
components, and header-injection sequences all pass through to the server.
The provenance list endpoint (#799 / MR !429) surfaces this field in the API
response, so it must be sanitized at write time, not at every read site.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.msproject.views import _sanitize_filename


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Path components stripped.
        ("../../etc/passwd", "passwd"),
        ("/etc/passwd", "passwd"),
        ("subdir/file.xml", "file.xml"),
        # HTML metacharacters substituted.
        ("<img src=x>.xml", "_img src_x_.xml"),
        # os.path.basename keeps only the trailing path component, then ">" is
        # substituted — so a `/` in the middle truncates to the suffix.
        ('"><script>alert(1)</script>.xml', "script_.xml"),
        # Control chars + nulls stripped.
        ("evil\x00.xml", "evil_.xml"),
        ("hello\r\nX-Injected: 1.xml", "hello__X-Injected_ 1.xml"),
        # Plain names preserved.
        ("Project plan (2026).xml", "Project plan (2026).xml"),
        ("my-schedule_v3.xml", "my-schedule_v3.xml"),
        # Empty / whitespace falls back.
        ("", "upload.xml"),
        ("   ", "upload.xml"),
    ],
)
def test_sanitize_filename(raw: str, expected: str) -> None:
    assert _sanitize_filename(raw) == expected


def test_sanitize_filename_caps_length() -> None:
    """Long filenames are truncated at 255 chars to bound storage and headers."""
    raw = ("a" * 300) + ".xml"
    out = _sanitize_filename(raw)
    assert len(out) == 255
