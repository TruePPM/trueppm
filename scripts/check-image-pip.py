#!/usr/bin/env python3
"""Regression tripwire: fail if pip is (re)introduced into a published image.

Run it inside a built runtime image, once per interpreter (the venv one and the
system one), e.g. ``docker run --rm -i IMAGE /venv/bin/python - < scripts/check-image-pip.py``.

The published api image ships NO pip: the runtime stage uninstalls it and deletes
the base image's bundled ensurepip wheel. pip trusts its own vendored certifi, so
an old pip still trusts the emSign roots (#4642). This check passes when pip is
absent, so it is a tripwire against pip coming back, NOT proof of a version
floor; the 26.2.2 floor for the builder-stage pip is asserted by a RUN step in
the Dockerfiles. A present pip below 26.2.2, or any leftover bundled pip wheel
(``python -m ensurepip`` would resurrect it), fails.
"""

from __future__ import annotations

import sys
from importlib import metadata, util
from pathlib import Path

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


def bundled_pip_wheels() -> list[str]:
    """Return pip wheels left in the stdlib's ensurepip/_bundled directory."""
    spec = util.find_spec("ensurepip")
    if spec is None or not spec.submodule_search_locations:
        return []
    return sorted(
        str(w)
        for loc in spec.submodule_search_locations
        for w in (Path(loc) / "_bundled").glob("pip-*.whl")
    )


def main() -> int:
    if "--self-test" in sys.argv:
        assert verdict(None)[0]
        assert verdict("26.2.2")[0]
        assert verdict("27.0")[0]
        assert not verdict("26.2.1")[0]
        assert not verdict("25.3")[0]
        assert isinstance(bundled_pip_wheels(), list)
        print("self-test: OK")
        return 0
    try:
        version: str | None = metadata.version("pip")
    except metadata.PackageNotFoundError:
        version = None
    ok, msg = verdict(version)
    print(f"{sys.executable}: {msg}")
    leftovers = bundled_pip_wheels()
    for wheel in leftovers:
        print(f"FAIL: bundled pip wheel remains: {wheel}")
    return 0 if ok and not leftovers else 1


if __name__ == "__main__":
    sys.exit(main())
