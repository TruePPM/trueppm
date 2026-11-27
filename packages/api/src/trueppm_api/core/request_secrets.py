"""Strip secret fields from a raw request body before anything hashes it (#2400).

Two places persist a digest of a request body: the idempotency claim row
(``IdempotencyKey.request_hash``) and the agent audit chain
(``AgentAction.payload_hash``, written when an MCP-token request is refused). Both
are plain, unsalted SHA-256. When the body carries a passphrase — the opt-in
export encryption field, and the passphrase sent beside an encrypted bundle on
program import — that digest is a fast offline oracle for the passphrase: guess,
rebuild the body, compare. The agent chain is immutable, so a leak there cannot
be cleaned up afterwards.

So every body is passed through :func:`redact_secret_fields` first. A body that
holds none of :data:`SECRET_BODY_FIELDS` comes back byte-for-byte unchanged, so
no existing idempotency key changes its hash. A body that does hold one comes
back with that field removed (re-serialized canonically), which means two
requests that differ only in the passphrase hash the same: a retry under one
Idempotency-Key with a different passphrase replays the first response instead
of returning 422. That is the price of never storing anything derived from the
passphrase, and the export endpoints' own in-flight de-dupe still refuses to hand
a passphrase request a build keyed to an earlier one.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode

#: Body field names whose value must never reach a stored digest, at any depth.
SECRET_BODY_FIELDS: frozenset[str] = frozenset({"passphrase"})

_BOUNDARY_RE = re.compile(r'boundary="?([^";]+)"?', re.IGNORECASE)
_PART_NAME_RE = re.compile(rb'content-disposition:[^\r\n]*?\bname="([^"]*)"', re.IGNORECASE)


def _strip(value: Any) -> tuple[Any, bool]:
    if isinstance(value, dict):
        found = False
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in SECRET_BODY_FIELDS:
                found = True
                continue
            out[key], hit = _strip(item)
            found = found or hit
        return out, found
    if isinstance(value, list):
        items = [_strip(item) for item in value]
        return [item for item, _ in items], any(hit for _, hit in items)
    return value, False


def _redact_json(body: bytes) -> bytes:
    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    stripped, found = _strip(parsed)
    if not found:
        return body
    return json.dumps(stripped, sort_keys=True, separators=(",", ":")).encode()


def _redact_form(body: bytes) -> bytes:
    try:
        pairs = parse_qsl(body.decode("latin-1"), keep_blank_values=True)
    except ValueError:
        return body
    kept = [(k, v) for k, v in pairs if k not in SECRET_BODY_FIELDS]
    if len(kept) == len(pairs):
        return body
    return urlencode(kept).encode("latin-1")


def _redact_multipart(body: bytes, content_type: str) -> bytes:
    match = _BOUNDARY_RE.search(content_type)
    if match is None:
        return body
    delimiter = b"--" + match.group(1).encode("latin-1")
    parts = body.split(delimiter)
    kept = []
    for part in parts:
        headers = part.split(b"\r\n\r\n", 1)[0]
        name = _PART_NAME_RE.search(headers)
        if name is not None and name.group(1).decode("latin-1") in SECRET_BODY_FIELDS:
            continue
        kept.append(part)
    if len(kept) == len(parts):
        return body
    return delimiter.join(kept)


def redact_secret_fields(body: bytes, content_type: str) -> bytes:
    """Return ``body`` with every :data:`SECRET_BODY_FIELDS` field removed.

    Handles the three body encodings DRF parses (JSON, urlencoded form,
    multipart). Any other encoding, an unparseable body, or a body without a
    secret field is returned unchanged.
    """
    if not body:
        return body
    media = (content_type or "").split(";", 1)[0].strip().lower()
    if media == "application/json" or media.endswith("+json"):
        return _redact_json(body)
    if media == "application/x-www-form-urlencoded":
        return _redact_form(body)
    if media == "multipart/form-data":
        return _redact_multipart(body, content_type)
    return body
