import importlib
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version

import pytest

import trueppm_api


def test_version_is_derived_from_package_metadata() -> None:
    """``__version__`` must be sourced from the installed package metadata.

    Guards against a hardcoded ``__version__`` literal (``"0.1.0"``) that
    silently diverged from the published wheel version (``0.4.0-beta.3`` by the
    time it was noticed) — mirrors ``trueppm_scheduler``'s identical guard,
    added for the same defect class. Deriving it from ``importlib.metadata``
    makes the two equal by construction, so this assertion fails the moment
    anyone reintroduces a hardcoded literal that differs from what was
    installed.
    """
    assert trueppm_api.__version__ == pkg_version("trueppm-api")
    # And the package is actually installed/discoverable (not the source fallback).
    assert trueppm_api.__version__ != "0.0.0.dev0"


def test_version_falls_back_when_package_metadata_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A source checkout that was never ``pip install -e``'d gets a dev sentinel.

    Exercises the ``except PackageNotFoundError`` branch, which the
    installed-package test above never reaches in CI (the package is always
    installed there).
    """

    def raise_not_found(_name: str) -> str:
        raise PackageNotFoundError

    # Patch the underlying importlib.metadata function, not the module-level
    # name trueppm_api imported: reloading the module re-runs its `from
    # importlib.metadata import ... version` statement, which would otherwise
    # rebind straight back to the real function before the patched one is used.
    monkeypatch.setattr("importlib.metadata.version", raise_not_found)
    try:
        importlib.reload(trueppm_api)
        assert trueppm_api.__version__ == "0.0.0.dev0"
    finally:
        importlib.reload(trueppm_api)
