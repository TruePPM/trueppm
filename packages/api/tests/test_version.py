from importlib.metadata import version as pkg_version

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
