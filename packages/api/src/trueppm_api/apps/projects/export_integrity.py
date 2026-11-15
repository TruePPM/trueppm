"""Integrity manifest for export bundles (ADR-0634 §5, #2399).

A bundle's ``manifest.json`` carries ``members`` (``{archive path: sha256 hex}`` for
every other member) and ``manifest_sha256``. The digest detects *corruption and
casual editing*; it is not a signature, so someone who can rewrite the archive can
also rewrite the manifest (ADR-0634 rejects signing: a self-hosted deployment has no
key-distribution story).

**Canonical form** (what ``manifest_sha256`` covers) — the manifest object with the
``manifest_sha256`` key removed, serialized as UTF-8 JSON with ``sort_keys=True``,
``separators=(",", ":")`` (no insignificant whitespace) and ``ensure_ascii=True``.
The digest is the lowercase hex SHA-256 of those bytes. ``members`` is *inside* the
canonical form, so the manifest digest transitively covers every member digest.
A verifier must re-canonicalize the *parsed* manifest rather than hash the file's
bytes: ``manifest.json`` is pretty-printed for humans and its raw bytes are not
what was hashed.

This module is pure (no ORM, no Django imports) so import paths can use it without
dragging in the export builder.
"""

from __future__ import annotations

import hashlib
import json
import tarfile
import zlib
from dataclasses import dataclass
from typing import IO, Any

MANIFEST_NAME = "manifest.json"
DIGEST_ALGORITHM = "sha256"
_CHUNK = 1024 * 1024
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024


class ArchiveIntegrityError(Exception):
    """The archive is unreadable or its recorded digests do not match its content."""


@dataclass(frozen=True)
class ArchiveVerification:
    """Outcome of :func:`verify_archive`.

    ``verified`` is True only when the manifest carried a digest and every check
    passed; a legacy archive (no manifest, or one without digests) is
    ``verified=False`` and still importable. ``seed_bytes`` is ``seed.json`` when
    the caller asked for it.
    """

    verified: bool
    seed_bytes: bytes | None


def canonical_manifest_bytes(manifest: dict[str, Any]) -> bytes:
    """Return the canonical bytes ``manifest_sha256`` is computed over."""
    body = {k: v for k, v in manifest.items() if k != "manifest_sha256"}
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(
        "utf-8"
    )


def seal_manifest(manifest: dict[str, Any], digests: dict[str, str]) -> dict[str, Any]:
    """Return ``manifest`` plus ``members`` and ``manifest_sha256``.

    ``manifest`` is round-tripped through JSON first so values the encoder converts
    (datetimes) are already the strings a verifier will parse back out.
    """
    from django.core.serializers.json import DjangoJSONEncoder

    base: dict[str, Any] = json.loads(json.dumps(manifest, cls=DjangoJSONEncoder))
    base["digest_algorithm"] = DIGEST_ALGORITHM
    base["members"] = dict(sorted(digests.items()))
    base["manifest_sha256"] = hashlib.sha256(canonical_manifest_bytes(base)).hexdigest()
    return base


def sha256_stream(fileobj: IO[bytes]) -> str:
    """Hex SHA-256 of ``fileobj`` from its current position, read in 1 MiB chunks."""
    digest = hashlib.sha256()
    while chunk := fileobj.read(_CHUNK):
        digest.update(chunk)
    return digest.hexdigest()


def _read_manifest(src: IO[bytes]) -> dict[str, Any]:
    raw = src.read(_MAX_MANIFEST_BYTES + 1)
    if len(raw) > _MAX_MANIFEST_BYTES:
        raise ArchiveIntegrityError("manifest.json is too large.")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ArchiveIntegrityError("manifest.json is not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ArchiveIntegrityError("manifest.json is not a JSON object.")
    return parsed


def _hash_member(src: IO[bytes], keep_max: int | None) -> tuple[str, bytes | None]:
    """Stream ``src`` through SHA-256; also keep its bytes when ``keep_max`` is set."""
    digest = hashlib.sha256()
    buf = bytearray()
    while chunk := src.read(_CHUNK):
        digest.update(chunk)
        if keep_max is not None:
            buf += chunk
            if len(buf) > keep_max:
                raise ArchiveIntegrityError("seed.json inside the archive is too large.")
    return digest.hexdigest(), (bytes(buf) if keep_max is not None else None)


def _scan(
    fileobj: IO[bytes], seed_max_bytes: int | None
) -> tuple[dict[str, str], dict[str, Any] | None, bytes | None]:
    """One streaming pass: ``(member digests, parsed manifest, seed bytes)``."""
    actual: dict[str, str] = {}
    manifest: dict[str, Any] | None = None
    seed: bytes | None = None
    try:
        with tarfile.open(fileobj=fileobj, mode="r|gz") as tar:
            for info in tar:
                if not info.isfile():
                    continue
                name = info.name
                if name in actual or (name == MANIFEST_NAME and manifest is not None):
                    raise ArchiveIntegrityError(f"Archive lists member {name!r} more than once.")
                src = tar.extractfile(info)
                if src is None:
                    continue
                if name == MANIFEST_NAME:
                    manifest = _read_manifest(src)
                    continue
                keep = seed_max_bytes if name == "seed.json" else None
                actual[name], kept = _hash_member(src, keep)
                if kept is not None:
                    seed = kept
    except ArchiveIntegrityError:
        raise
    except (tarfile.TarError, EOFError, zlib.error, OSError) as exc:
        raise ArchiveIntegrityError(f"Archive is truncated or unreadable: {exc}") from exc
    return actual, manifest, seed


def _check_manifest(manifest: dict[str, Any], recorded: str, actual: dict[str, str]) -> None:
    if hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest() != recorded:
        raise ArchiveIntegrityError("manifest.json does not match its manifest_sha256.")
    members = manifest.get("members")
    if not isinstance(members, dict):
        raise ArchiveIntegrityError("manifest.json carries a digest but no members map.")
    for name, want in members.items():
        if name not in actual:
            raise ArchiveIntegrityError(f"Member {name!r} is listed in the manifest but missing.")
        if actual[name] != want:
            raise ArchiveIntegrityError(f"Member {name!r} does not match its recorded SHA-256.")
    extra = sorted(set(actual) - set(members))
    if extra:
        raise ArchiveIntegrityError(f"Member {extra[0]!r} is not listed in the manifest.")


def verify_archive(fileobj: IO[bytes], *, seed_max_bytes: int | None = None) -> ArchiveVerification:
    """Verify a ``.tar.gz`` bundle's integrity manifest in one streaming pass.

    The manifest is the last member, so the archive is read once in stream mode,
    hashing each member as it goes (never buffering a member), and compared against
    the manifest at the end. Raises :class:`ArchiveIntegrityError` on a bad digest,
    a member missing from or absent in the manifest, a duplicated member name, or an
    archive that cannot be read to its end (truncation). An archive whose manifest
    is absent or carries no ``manifest_sha256`` is returned ``verified=False``.

    ``seed_max_bytes`` asks for ``seed.json`` to be captured (and bounds it).
    """
    actual, manifest, seed = _scan(fileobj, seed_max_bytes)
    recorded = manifest.get("manifest_sha256") if manifest is not None else None
    if manifest is None or not isinstance(recorded, str):
        return ArchiveVerification(verified=False, seed_bytes=seed)
    _check_manifest(manifest, recorded, actual)
    return ArchiveVerification(verified=True, seed_bytes=seed)
