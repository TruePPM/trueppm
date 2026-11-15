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

import gzip
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
# Decompression-bomb bounds for verification. The upload cap (SEED_MAX_UPLOAD_MB)
# limits only the *compressed* bytes, and gzip reaches ~1000:1, so a few MB can
# inflate to gigabytes that this scan would hash inside the request thread. The
# total inflated bytes are therefore capped at max(factor * upload cap, floor): a
# real bundle (JSON, ~10:1) sits far below it, a bomb far above. The member count
# bounds tar-header churn, which costs CPU without costing inflated bytes.
_DECOMPRESSED_FACTOR = 64
_MIN_DECOMPRESSED_BYTES = 256 * 1024 * 1024
_MAX_MEMBERS = 10_000


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


class _Budget:
    """Running total of decompressed bytes; raises once ``limit`` is exceeded."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.used = 0

    def spend(self, n: int) -> None:
        self.used += n
        if self.used > self.limit:
            raise ArchiveIntegrityError("Archive expands beyond the allowed decompressed size.")


class _CountingReader:
    """Read-only file wrapper that charges every inflated byte to a :class:`_Budget`.

    Counting at the source (rather than per member) is what makes the cap total: tar
    skips the data of a directory, link, or unknown-typeflag entry by *reading and
    discarding* it, and a PAX/GNU extended header is read whole, so neither ever
    reaches the per-member hashing loop. Every one of them pulls through ``read``.
    ``read`` is clamped to one chunk so a header declaring a huge size cannot make
    gzip inflate it in a single call before the budget is consulted.
    """

    def __init__(self, raw: gzip.GzipFile, budget: _Budget) -> None:
        self._raw = raw
        self._budget = budget

    def read(self, size: int, /) -> bytes:
        if size < 0 or size > _CHUNK:
            size = _CHUNK
        data = self._raw.read(size)
        self._budget.spend(len(data))
        return data


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
    fileobj: IO[bytes], seed_max_bytes: int | None, max_decompressed_bytes: int
) -> tuple[dict[str, str], dict[str, Any] | None, bytes | None]:
    """One streaming pass: ``(member digests, parsed manifest, seed bytes)``."""
    actual: dict[str, str] = {}
    manifest: dict[str, Any] | None = None
    seed: bytes | None = None
    budget = _Budget(max_decompressed_bytes)
    members_seen = 0
    try:
        counted = _CountingReader(gzip.GzipFile(fileobj=fileobj, mode="rb"), budget)
        # typeshed types fileobj as a seekable r/w protocol; stream mode only reads.
        with tarfile.open(fileobj=counted, mode="r|") as tar:  # type: ignore[call-overload]
            for info in tar:
                members_seen += 1
                if members_seen > _MAX_MEMBERS:
                    raise ArchiveIntegrityError(f"Archive holds more than {_MAX_MEMBERS} members.")
                if not info.isfile():
                    continue
                if info.issparse():
                    # tarfile synthesizes a sparse hole as NUL bytes without pulling
                    # anything from the stream, so the decompression budget never sees
                    # them and a tiny archive could pin a worker hashing terabytes of
                    # zeros. TruePPM exports are never sparse.
                    raise ArchiveIntegrityError(
                        "Archive contains a sparse member, which is not allowed."
                    )
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


def verify_archive(
    fileobj: IO[bytes],
    *,
    seed_max_bytes: int | None = None,
    max_decompressed_bytes: int | None = None,
) -> ArchiveVerification:
    """Verify a ``.tar.gz`` bundle's integrity manifest in one streaming pass.

    The manifest is the last member, so the archive is read once in stream mode,
    hashing each member as it goes (never buffering a member), and compared against
    the manifest at the end. Raises :class:`ArchiveIntegrityError` on a bad digest,
    a member missing from or absent in the manifest, a duplicated member name, or an
    archive that cannot be read to its end (truncation). An archive whose manifest
    is absent or carries no ``manifest_sha256`` is returned ``verified=False``.

    ``seed_max_bytes`` asks for ``seed.json`` to be captured (and bounds it). Total
    decompressed bytes are capped at ``max_decompressed_bytes`` (default
    ``max(64 * seed_max_bytes, 256 MiB)``) and members at 10,000, so a
    decompression bomb is an :class:`ArchiveIntegrityError`, not hours of hashing.
    """
    if max_decompressed_bytes is None:
        max_decompressed_bytes = max(
            _DECOMPRESSED_FACTOR * (seed_max_bytes or 0), _MIN_DECOMPRESSED_BYTES
        )
    actual, manifest, seed = _scan(fileobj, seed_max_bytes, max_decompressed_bytes)
    recorded = manifest.get("manifest_sha256") if manifest is not None else None
    if manifest is None or not isinstance(recorded, str):
        return ArchiveVerification(verified=False, seed_bytes=seed)
    _check_manifest(manifest, recorded, actual)
    return ArchiveVerification(verified=True, seed_bytes=seed)
