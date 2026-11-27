"""Share-token redaction in the shipped nginx access logs (#5155).

The response headers of ``/share/*`` are asserted by
``scripts/check-nginx-security-headers.sh``. What that gate cannot say is whether
the redaction regex actually removes a token, so this applies each config's own
``map`` patterns to sample log values.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]

#: Config file -> number of ``default.conf`` renderings it carries.
CONFIGS = {
    "nginx/app.conf.template": 1,
    "nginx/app-http.conf.template": 1,
    "nginx/demo.conf.template": 1,
    "packages/web/nginx.conf": 1,
    "packages/helm/templates/web/configmap.yaml": 3,
}

_MAP_ENTRY = re.compile(
    r'^\s*"~\*(?P<pattern>[^"]+)"\s+"\$trueppm_(?P<kind>req|ref)_head\[redacted\]'
    r'\$trueppm_(?P=kind)_tail";$',
    re.MULTILINE,
)


def _redact(pattern: str, kind: str, value: str) -> str:
    """Apply one nginx map entry (PCRE ``(?<n>)`` spelled Python's way)."""
    match = re.search(pattern.replace("(?<", "(?P<"), value, re.IGNORECASE)
    if not match:
        return value
    return f"{match[f'trueppm_{kind}_head']}[redacted]{match[f'trueppm_{kind}_tail']}"


@pytest.mark.parametrize("rel", CONFIGS)
def test_share_tokens_are_redacted_from_the_access_log(rel: str) -> None:
    text = (REPO_ROOT / rel).read_text(encoding="utf-8")
    entries = _MAP_ENTRY.findall(text)
    assert sorted(kind for _, kind in entries) == sorted(["req", "ref"] * CONFIGS[rel])
    # The format must log the mapped values, never the raw request line or Referer.
    for fmt in re.findall(r"log_format trueppm_redacted [^;]+;", text):
        assert "$trueppm_log_request" in fmt and "$trueppm_log_referer" in fmt
        assert not re.search(r"\$(request|request_uri|http_referer)\b", fmt)
    assert text.count("log_format trueppm_redacted ") == CONFIGS[rel]

    token = "Zr8-secret_TOKEN"
    for pattern, kind in entries:
        for value in (
            f"GET /share/board/{token} HTTP/1.1",
            f"GET /share/status-update/{token}?utm=1 HTTP/1.1",
            f"GET /api/v1/share/schedule/{token}/ HTTP/2.0",
            f"https://pm.example.com/Share/Board/{token}",
        ):
            redacted = _redact(pattern, kind, value)
            assert token not in redacted, f"{rel}: {value!r} -> {redacted!r}"
            assert "[redacted]" in redacted
        for untouched in (
            "GET /api/v1/projects/abc/share-links/ HTTP/1.1",
            "GET /projects/abc/schedule HTTP/1.1",
        ):
            assert _redact(pattern, kind, untouched) == untouched
