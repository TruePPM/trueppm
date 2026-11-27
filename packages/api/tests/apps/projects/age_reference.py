"""An independent age v1 X25519 decryptor, written from the spec for tests (#2400).

https://age-encryption.org/v1 — deliberately shares no code with
``trueppm_api.apps.projects.export_crypto``: it parses the header with its own
rules, recomputes the X25519 wrap key and the header MAC, and decrypts the
STREAM payload itself. A recipient-mode bundle that this opens is one the
format's definition opens, not merely one our own reader agrees with.

It is still a reimplementation, not the ``age``/``rage`` binaries.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

CHUNK = 64 * 1024
TAG = 16


def _b64decode_strict(text: bytes) -> bytes:
    # The spec: canonical base64 without padding.
    assert b"=" not in text
    return base64.b64decode(text + b"=" * (-len(text) % 4), validate=True)


def _hkdf(ikm: bytes, salt: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(ikm)


def decrypt(blob: bytes, identity: X25519PrivateKey) -> bytes:
    """Decrypt an age v1 file with an X25519 identity, or raise."""
    header_end = blob.index(b"\n--- ") + 1
    mac_line_end = blob.index(b"\n", header_end) + 1
    header_lines = blob[:header_end].split(b"\n")[:-1]
    mac_line = blob[header_end : mac_line_end - 1]
    assert header_lines[0] == b"age-encryption.org/v1"

    stanzas: list[tuple[list[bytes], bytes]] = []
    i = 1
    while i < len(header_lines):
        line = header_lines[i]
        assert line.startswith(b"-> ")
        args = line[3:].split(b" ")
        body = b""
        i += 1
        while True:
            body_line = header_lines[i]
            i += 1
            assert len(body_line) <= 64
            body += _b64decode_strict(body_line)
            if len(body_line) < 64:
                break
        stanzas.append((args, body))

    ours = identity.public_key().public_bytes_raw()
    file_key = None
    for args, body in stanzas:
        if args[0] != b"X25519":
            continue
        share = _b64decode_strict(args[1])
        shared = identity.exchange(X25519PublicKey.from_public_bytes(share))
        wrap = _hkdf(shared, share + ours, b"age-encryption.org/v1/X25519")
        file_key = ChaCha20Poly1305(wrap).decrypt(b"\x00" * 12, body, None)
        break
    assert file_key is not None and len(file_key) == 16

    mac_input = blob[: header_end + 3]  # through "---", excluding the space and MAC
    expected = hmac.new(_hkdf(file_key, b"", b"header"), mac_input, hashlib.sha256).digest()
    assert hmac.compare_digest(expected, _b64decode_strict(mac_line[4:]))

    payload = blob[mac_line_end:]
    nonce, ciphertext = payload[:16], payload[16:]
    key = _hkdf(file_key, nonce, b"payload")
    out = b""
    starts = range(0, max(len(ciphertext), 1), CHUNK + TAG)
    for counter, start in enumerate(starts):
        chunk = ciphertext[start : start + CHUNK + TAG]
        last = start + CHUNK + TAG >= len(ciphertext)
        flag = b"\x01" if last else b"\x00"
        out += ChaCha20Poly1305(key).decrypt(counter.to_bytes(11, "big") + flag, chunk, None)
    return out
