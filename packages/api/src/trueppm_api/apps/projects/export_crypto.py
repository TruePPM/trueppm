"""Opt-in encryption of export bundles at rest (ADR-0634 §5, #2400).

The artifact is written in the **age v1** format (age-encryption.org/v1): a text
header of recipient stanzas sealed by an HMAC, then the bundle in 64 KiB
ChaCha20-Poly1305 STREAM chunks. Everything is built from ``cryptography``
primitives (X25519, HKDF-SHA256, ChaCha20-Poly1305, scrypt, HMAC), which the API
already depends on, so this adds no package.

Two modes, and why the passphrase one is not age's own ``scrypt`` stanza:

* **Recipient** — the caller supplies an age public key (``age1…``). The bundle is
  encrypted to it with a standard X25519 stanza, so the operator opens it with
  ``age -d -i <identity file>``. The server only ever sees the public key.
* **Passphrase** — the bundle is built by a Celery worker long after the request
  returns, and age's ``scrypt`` stanza would need the passphrase (or a key derived
  from it) *in the worker*: that means in the broker message and the outbox row,
  which is exactly the retention the issue forbids. Instead the request thread
  derives an X25519 key pair from the passphrase with scrypt over a fresh random
  salt, keeps only the **public** half, and throws the passphrase and the private
  half away before it responds. The worker encrypts to that public key like any
  other recipient, and writes a ``trueppm-scrypt <salt> <log2 N>`` stanza beside it
  so the file says how to re-derive the key. The header HMAC covers that stanza,
  so the salt cannot be swapped. The age CLI does not know the stanza, so a
  passphrase-mode file is opened by TruePPM's program import (passphrase at
  upload) or :func:`decrypt_stream`, not by ``age -d``.

What the server retains for an encrypted job while it builds: the mode, the public
key and, for a passphrase, the salt and work factor. None of it decrypts anything,
but together they let someone with database read access test passphrase guesses
offline (at scrypt 2**17 per guess) and encrypt a forged bundle that opens under
the passphrase, so the worker clears them when the job finishes, and the export
drain fails and clears a job its worker abandoned once it is two hours old
(``tasks.EXPORT_STALE_JOB_MINUTES``). Passphrase mode
therefore gives confidentiality, not authenticity: anyone who learns the public
key can produce a file the passphrase opens. The bundle's integrity manifest
(#2399) is unkeyed, so it does not prove origin either; the job's ``file_sha256``,
read from the API, is the out-of-band check.
"""

from __future__ import annotations

import base64
import hmac
import logging
import os
import re
from dataclasses import dataclass, field
from hashlib import sha256
from typing import IO, Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

logger = logging.getLogger(__name__)

MODE_NONE = "none"
MODE_PASSPHRASE = "passphrase"
MODE_RECIPIENT = "recipient"

#: First line of every age v1 file; an upload starting with it is encrypted.
AGE_MAGIC = b"age-encryption.org/v1\n"
#: Suffix appended to an encrypted bundle's file name, so it never looks like a plain
#: ``.tar.gz``.
ENCRYPTED_SUFFIX = ".age"

#: scrypt work factor for passphrase mode: N = 2**17, r = 8, p = 1 is about 128 MiB
#: and a few hundred ms, the OWASP floor for scrypt. It runs in the request thread,
#: behind the Admin gate, and only after the per-requester in-flight check: a caller
#: who already has an export building is refused with the 409 before any scrypt runs
#: (see :class:`EncryptionRequest`), so one caller can hold at most one derivation
#: per request and cannot queue them up behind a pending build.
SCRYPT_LOG_N = 17
#: The largest work factor a decryptor accepts from a file header. The header is
#: untrusted input at import time, and program import is open to any authenticated
#: account (rate-limited, not role-gated), so a crafted file could otherwise demand
#: an arbitrarily large scrypt allocation from the API pod. It is pinned to the work
#: factor this server writes: nothing legitimate asks for more.
MAX_SCRYPT_LOG_N = SCRYPT_LOG_N
MIN_PASSPHRASE_LENGTH = 12

_CHUNK = 64 * 1024
_TAG = 16
_STANZA_X25519 = "X25519"
_STANZA_SCRYPT = "trueppm-scrypt"
_X25519_INFO = b"age-encryption.org/v1/X25519"
_SCRYPT_SALT_LABEL = b"trueppm-export/v1/scrypt"
_MAX_HEADER_BYTES = 64 * 1024
_BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


class ExportCryptoError(Exception):
    """A recipient, passphrase or encrypted file could not be used.

    The message is safe to show the user: it never contains the passphrase, and a
    wrong passphrase and a damaged file read the same, so the error is no oracle.
    """


@dataclass(frozen=True)
class ExportEncryption:
    """The public, retainable description of how one export is encrypted."""

    mode: str
    params: dict[str, Any]


# --------------------------------------------------------------------------- encoding


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9+/]*", text):
        raise ExportCryptoError("The encrypted file's header is damaged.")
    try:
        return base64.b64decode(text + "=" * (-len(text) % 4), validate=True)
    except ValueError as exc:
        raise ExportCryptoError("The encrypted file's header is damaged.") from exc


def _bech32_polymod(values: list[int]) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if (top >> i) & 1 else 0
    return chk


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convert_bits(data: bytes | list[int], frm: int, to: int, *, pad: bool) -> list[int]:
    acc = bits = 0
    out: list[int] = []
    maxv = (1 << to) - 1
    for value in data:
        acc = (acc << frm) | value
        bits += frm
        while bits >= to:
            bits -= to
            out.append((acc >> bits) & maxv)
    if pad and bits:
        out.append((acc << (to - bits)) & maxv)
    elif not pad and (bits >= frm or (acc << (to - bits)) & maxv):
        raise ValueError("invalid padding")
    return out


def bech32_encode(hrp: str, data: bytes) -> str:
    """BIP-173 bech32 (the encoding age uses for ``age1…`` keys)."""
    words = _convert_bits(data, 8, 5, pad=True)
    polymod = _bech32_polymod([*_hrp_expand(hrp), *words, 0, 0, 0, 0, 0, 0]) ^ 1
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_BECH32_CHARSET[w] for w in [*words, *checksum])


def bech32_decode(text: str) -> tuple[str, bytes]:
    """Decode a bech32 string to ``(hrp, data)``; raise ``ValueError`` if invalid."""
    if text.lower() != text and text.upper() != text:
        raise ValueError("mixed case")
    text = text.lower()
    pos = text.rfind("1")
    if pos < 1 or pos + 7 > len(text):
        raise ValueError("no separator")
    hrp, rest = text[:pos], text[pos + 1 :]
    if any(c not in _BECH32_CHARSET for c in rest):
        raise ValueError("bad character")
    words = [_BECH32_CHARSET.index(c) for c in rest]
    if _bech32_polymod([*_hrp_expand(hrp), *words]) != 1:
        raise ValueError("bad checksum")
    return hrp, bytes(_convert_bits(words[:-6], 5, 8, pad=False))


# --------------------------------------------------------------------------- keys


def parse_recipient(text: str) -> bytes:
    """Validate an ``age1…`` public key and return its 32 raw bytes."""
    value = text.strip()
    if value.upper().startswith("AGE-SECRET-KEY-"):
        raise ExportCryptoError(
            "That is an age secret key. Paste the public key (it starts with age1) "
            "and keep the secret key to yourself."
        )
    try:
        hrp, data = bech32_decode(value)
    except ValueError as exc:
        raise ExportCryptoError("Not a valid age public key (it starts with age1).") from exc
    if hrp != "age" or len(data) != 32:
        raise ExportCryptoError("Not a valid age public key (it starts with age1).")
    return data


def recipient_encryption(recipient: str) -> ExportEncryption:
    """Describe an export encrypted to an operator-managed age public key."""
    key = parse_recipient(recipient)
    return ExportEncryption(MODE_RECIPIENT, {"recipient": bech32_encode("age", key)})


@dataclass(frozen=True)
class EncryptionRequest:
    """A validated, not-yet-derived encryption choice from an export request.

    Shape checks (passphrase length, age key syntax) are cheap and run in the
    serializer. The scrypt derivation is not: :meth:`resolve` runs it, and the
    enqueue services call it only after the in-flight de-dupe, so a request that is
    going to be refused with a 409 never spends 128 MiB of scrypt first. The
    passphrase lives only on this in-memory object and is never persisted.
    """

    mode: str
    recipient: str = ""
    passphrase: str = field(default="", repr=False)

    def resolve(self) -> ExportEncryption:
        """Return the public, retainable :class:`ExportEncryption` for this choice."""
        if self.mode == MODE_PASSPHRASE:
            return passphrase_encryption(self.passphrase)
        return ExportEncryption(MODE_RECIPIENT, {"recipient": self.recipient})


def encryption_request(
    mode: str, *, passphrase: str = "", recipient: str = ""
) -> EncryptionRequest:
    """Validate an encryption choice without deriving any key (cheap)."""
    if mode == MODE_PASSPHRASE:
        if len(passphrase) < MIN_PASSPHRASE_LENGTH:
            raise ExportCryptoError(
                f"Use a passphrase of at least {MIN_PASSPHRASE_LENGTH} characters."
            )
        return EncryptionRequest(MODE_PASSPHRASE, passphrase=passphrase)
    return EncryptionRequest(
        MODE_RECIPIENT, recipient=recipient_encryption(recipient).params["recipient"]
    )


def _derive_private_key(passphrase: str, salt: bytes, log_n: int) -> X25519PrivateKey:
    secret = Scrypt(salt=_SCRYPT_SALT_LABEL + salt, length=32, n=2**log_n, r=8, p=1).derive(
        passphrase.encode("utf-8")
    )
    return X25519PrivateKey.from_private_bytes(secret)


def passphrase_encryption(passphrase: str, *, log_n: int | None = None) -> ExportEncryption:
    """Derive the public half of a passphrase key pair; nothing secret is returned.

    Runs in the request thread. The passphrase and the derived private key go out
    of scope when this returns; only the public key, the salt and the work factor
    are kept, and none of them can decrypt the bundle.
    """
    if len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise ExportCryptoError(f"Use a passphrase of at least {MIN_PASSPHRASE_LENGTH} characters.")
    work = SCRYPT_LOG_N if log_n is None else log_n
    salt = os.urandom(16)
    public = _derive_private_key(passphrase, salt, work).public_key().public_bytes_raw()
    return ExportEncryption(
        MODE_PASSPHRASE,
        {"recipient": bech32_encode("age", public), "salt": _b64(salt), "log_n": work},
    )


# --------------------------------------------------------------------------- format


def _hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


def _wrap_lines(body: bytes) -> str:
    text = _b64(body)
    lines = [text[i : i + 64] for i in range(0, len(text), 64)]
    if not lines or len(lines[-1]) == 64:
        lines.append("")
    return "\n".join(lines) + "\n"


def _header(file_key: bytes, encryption: ExportEncryption) -> bytes:
    recipient = parse_recipient(encryption.params["recipient"])
    ephemeral = X25519PrivateKey.generate()
    share = ephemeral.public_key().public_bytes_raw()
    shared = ephemeral.exchange(X25519PublicKey.from_public_bytes(recipient))
    wrap_key = _hkdf(shared, share + recipient, _X25519_INFO)
    body = ChaCha20Poly1305(wrap_key).encrypt(b"\x00" * 12, file_key, None)
    text = AGE_MAGIC.decode() + f"-> {_STANZA_X25519} {_b64(share)}\n" + _wrap_lines(body)
    if encryption.mode == MODE_PASSPHRASE:
        params = encryption.params
        text += f"-> {_STANZA_SCRYPT} {params['salt']} {int(params['log_n'])}\n\n"
    text += "---"
    mac = hmac.new(_hkdf(file_key, b"", b"header"), text.encode(), sha256).digest()
    return (text + f" {_b64(mac)}\n").encode()


def encrypt_stream(src: IO[bytes], dst: IO[bytes], encryption: ExportEncryption) -> None:
    """Encrypt ``src`` to ``dst`` in age v1 format, one 64 KiB chunk in memory at a time."""
    file_key = os.urandom(16)
    dst.write(_header(file_key, encryption))
    nonce = os.urandom(16)
    dst.write(nonce)
    aead = ChaCha20Poly1305(_hkdf(file_key, nonce, b"payload"))
    counter = 0
    chunk = src.read(_CHUNK)
    while True:
        following = src.read(_CHUNK)
        last = not following
        chunk_nonce = counter.to_bytes(11, "big") + (b"\x01" if last else b"\x00")
        dst.write(aead.encrypt(chunk_nonce, chunk, None))
        if last:
            return
        chunk, counter = following, counter + 1


def is_encrypted(head: bytes) -> bool:
    """Whether a file's first bytes are an age v1 header."""
    return head.startswith(AGE_MAGIC)


@dataclass
class _Stanza:
    kind: str
    args: list[str]
    body: bytes


def _read_header(src: IO[bytes]) -> tuple[list[_Stanza], bytes, bytes]:
    """Parse the header; return its stanzas, the MAC'd text, and the MAC."""
    damaged = ExportCryptoError("The encrypted file's header is damaged.")
    consumed = 0

    def line() -> bytes:
        nonlocal consumed
        raw = src.readline(_MAX_HEADER_BYTES)
        consumed += len(raw)
        if not raw.endswith(b"\n") or consumed > _MAX_HEADER_BYTES:
            raise damaged
        return raw

    text = line()
    if text != AGE_MAGIC:
        raise damaged
    stanzas: list[_Stanza] = []
    raw = line()
    while raw.startswith(b"-> "):
        text += raw
        fields = raw[3:-1].decode("ascii", "replace").split(" ")
        body = b""
        while True:
            body_line = line()
            text += body_line
            chunk = body_line[:-1].decode("ascii", "replace")
            body += _unb64(chunk)
            if len(chunk) < 64:
                break
        stanzas.append(_Stanza(fields[0], fields[1:], body))
        raw = line()
    if not raw.startswith(b"--- "):
        raise damaged
    text += b"---"
    return stanzas, text, _unb64(raw[4:-1].decode("ascii", "replace"))


def _unwrap(stanzas: list[_Stanza], passphrase: str) -> bytes:
    scrypt = [s for s in stanzas if s.kind == _STANZA_SCRYPT]
    if len(scrypt) != 1 or len(scrypt[0].args) != 2:
        raise ExportCryptoError(
            "This bundle was encrypted to an age public key, not a passphrase. "
            "Decrypt it with your age identity (age -d -i <key file>) and upload the "
            ".tar.gz."
        )
    salt_text, log_n_text = scrypt[0].args
    # The length check runs first: int() on a 5,000-digit field raises ValueError
    # (Python's integer-string limit) rather than returning a number to range-check.
    if (
        not log_n_text.isdigit()
        or len(log_n_text) > 2
        or not 1 <= int(log_n_text) <= MAX_SCRYPT_LOG_N
    ):
        raise ExportCryptoError("The encrypted file's header is damaged.")
    identity = _derive_private_key(passphrase, _unb64(salt_text), int(log_n_text))
    ours = identity.public_key().public_bytes_raw()
    for stanza in stanzas:
        if stanza.kind != _STANZA_X25519 or len(stanza.args) != 1:
            continue
        share = _unb64(stanza.args[0])
        if len(share) != 32:
            continue
        try:
            # A low-order share (e.g. 32 zero bytes) makes exchange() raise ValueError.
            # It is reported like a wrong passphrase so the error is not an oracle.
            shared = identity.exchange(X25519PublicKey.from_public_bytes(share))
        except ValueError:
            continue
        try:
            return ChaCha20Poly1305(_hkdf(shared, share + ours, _X25519_INFO)).decrypt(
                b"\x00" * 12, stanza.body, None
            )
        except InvalidTag:
            continue
    raise ExportCryptoError("Wrong passphrase, or the file is damaged.")


def decrypt_stream(src: IO[bytes], dst: IO[bytes], passphrase: str) -> None:
    """Decrypt a passphrase-mode bundle from ``src`` into ``dst``.

    Authenticates the header (HMAC) before any payload is written and every chunk
    as it is read; a truncated file fails on the missing final-chunk flag. A
    failure leaves ``dst`` partially written, so the caller discards it.

    Raises:
        ExportCryptoError: for every way the input can be wrong. The file is
            untrusted upload content, so any parse or primitive error a crafted
            file reaches (``ValueError`` and its ``binascii``/Unicode subclasses,
            ``TypeError``, ``IndexError``, ``KeyError``, ``OverflowError``) is
            mapped to the same generic error a wrong passphrase gets: the
            caller answers 400, never 500, and the message is not an oracle.
    """
    try:
        _decrypt_stream(src, dst, passphrase)
    except ExportCryptoError:
        raise
    except (ValueError, TypeError, IndexError, KeyError, OverflowError) as exc:
        logger.warning(
            "decrypt_stream: %s mapped to ExportCryptoError", type(exc).__name__, exc_info=True
        )
        raise ExportCryptoError("Wrong passphrase, or the file is damaged.") from exc


def _decrypt_stream(src: IO[bytes], dst: IO[bytes], passphrase: str) -> None:
    stanzas, text, mac = _read_header(src)
    file_key = _unwrap(stanzas, passphrase)
    expected = hmac.new(_hkdf(file_key, b"", b"header"), text, sha256).digest()
    if not hmac.compare_digest(expected, mac):
        raise ExportCryptoError("Wrong passphrase, or the file is damaged.")
    nonce = src.read(16)
    if len(nonce) != 16:
        raise ExportCryptoError("The encrypted file is truncated.")
    aead = ChaCha20Poly1305(_hkdf(file_key, nonce, b"payload"))
    counter = 0
    chunk = src.read(_CHUNK + _TAG)
    while True:
        following = src.read(_CHUNK + _TAG)
        last = not following
        chunk_nonce = counter.to_bytes(11, "big") + (b"\x01" if last else b"\x00")
        try:
            dst.write(aead.decrypt(chunk_nonce, chunk, None))
        except InvalidTag as exc:
            raise ExportCryptoError("The encrypted file is truncated or damaged.") from exc
        if last:
            return
        chunk, counter = following, counter + 1
