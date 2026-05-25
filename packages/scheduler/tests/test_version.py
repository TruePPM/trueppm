from importlib.metadata import version as pkg_version

import trueppm_scheduler


def test_version_is_derived_from_package_metadata() -> None:
    """``__version__`` must be sourced from the installed package metadata.

    Guards against the regression this issue fixed: a hardcoded ``__version__``
    literal (``"0.1.0"``) that silently diverged from the published wheel
    version (``0.1.0a1``). Deriving it from ``importlib.metadata`` makes the two
    equal by construction, so this assertion fails the moment anyone reintroduces
    a hardcoded literal that differs from what was installed.
    """
    assert trueppm_scheduler.__version__ == pkg_version("trueppm-scheduler")
    # And the package is actually installed/discoverable (not the source fallback).
    assert trueppm_scheduler.__version__ != "0.0.0+unknown"
