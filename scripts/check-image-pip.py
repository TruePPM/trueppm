#!/usr/bin/env python3
"""Fail if the Python interpreter running this script carries pip < 26.2.2.

Run it inside a built image, once per interpreter (the venv one and the system
one), e.g. ``docker run --rm -i IMAGE /venv/bin/python - < scripts/check-image-pip.py``.

pip always trusts its own vendored certifi bundle, so a pip older than 26.2.2
still trusts the emSign roots that certifi dropped (#4642). A published image
that carries no pip at all is fine and passes: the runtime stages uninstall it.
"""

from __future__ import annotations

import sys
from importlib import metadata

MIN_PIP = (26, 2, 2)


def verdict(version: str | None) -> tuple[bool, str]:
    """Return (ok, message) for an installed pip version, or None if absent."""
    if version is None:
        return True, "pip not installed (ok)"
    parts = []
    for piece in version.split(".")[:3]:
        digits = "".join(ch for ch in piece if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    ok = tuple(parts) >= MIN_PIP
    need = ".".join(map(str, MIN_PIP))
    return ok, f"pip {version} ({'ok' if ok else f'FAIL: need >= {need}'})"


def main() -> int:
    if "--self-test" in sys.argv:
        assert verdict(None)[0]
        assert verdict("26.2.2")[0]
        assert verdict("27.0")[0]
        assert not verdict("26.2.1")[0]
        assert not verdict("25.3")[0]
        print("self-test: OK")
        return 0
    try:
        version: str | None = metadata.version("pip")
    except metadata.PackageNotFoundError:
        version = None
    ok, msg = verdict(version)
    print(f"{sys.executable}: {msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
