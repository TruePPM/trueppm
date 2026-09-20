from importlib.metadata import version as pkg_version

import trueppm_mcp


def test_version_is_derived_from_package_metadata() -> None:
    """``__version__`` must be sourced from the installed package metadata.

    Guards against a hardcoded ``__version__`` literal (``"0.4.0b3"``) that
    would silently diverge from the published wheel version on the next
    release — mirrors ``trueppm_scheduler``'s identical guard, added for the
    same defect class. Deriving it from ``importlib.metadata`` makes the two
    equal by construction, so this assertion fails the moment anyone
    reintroduces a hardcoded literal that differs from what was installed.
    """
    assert trueppm_mcp.__version__ == pkg_version("trueppm-mcp")
    # And the package is actually installed/discoverable (not the source fallback).
    assert trueppm_mcp.__version__ != "0.0.0+unknown"
