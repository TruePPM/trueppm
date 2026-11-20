"""The API image must not depend on a transitive accident for `requests`.

`allauth.socialaccount.providers.openid_connect` does ``import requests`` at
``django.setup()``, but django-allauth only declares requests under its
``socialaccount`` extra. The Docker build resolves with pip and ignores
``uv.lock``, so when the OTLP HTTP exporter (the only runtime path that pulled
requests in) moved to urllib3, every image stopped booting while every
dev/test environment — which still has requests via dev dependencies — stayed
green. This pins the declaration, since no test environment can show the gap.
"""

from __future__ import annotations

import ast
import importlib.metadata
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_allauth_declares_socialaccount_extra() -> None:
    deps = tomllib.loads(_PYPROJECT.read_text())["project"]["dependencies"]
    allauth = [Requirement(d) for d in deps if Requirement(d).name == "django-allauth"]
    assert len(allauth) == 1
    assert "socialaccount" in allauth[0].extras


_SRC = Path(__file__).resolve().parents[1] / "src" / "trueppm_api"

# Import names that ship inside a distribution we already declare under another
# name, or that are our own first-party roots. Keep this empty-handed: every
# entry is a dependency the tree uses without declaring.
_FIRST_PARTY = {"trueppm_api", "trueppm_scheduler"}


def _declared_distributions() -> set[str]:
    deps = tomllib.loads(_PYPROJECT.read_text())["project"]["dependencies"]
    return {canonicalize_name(Requirement(d).name) for d in deps}


def _third_party_imports() -> dict[str, set[str]]:
    """Map each third-party top-level import name to the files importing it.

    Walks the whole AST, not just module top level, because function-level
    imports (``import numpy as np`` inside a service function) are exactly the
    ones a ``grep '^import'`` audit misses.
    """
    found: dict[str, set[str]] = {}
    for path in sorted(_SRC.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                root = name.split(".")[0]
                if root in sys.stdlib_module_names or root in _FIRST_PARTY:
                    continue
                found.setdefault(root, set()).add(str(path.relative_to(_SRC)))
    return found


def test_every_third_party_import_is_a_declared_dependency() -> None:
    """An import of a package only reachable transitively breaks on re-resolve.

    ``numpy`` was imported at five sites of ``projects/services.py`` while only
    ``trueppm-scheduler`` pulled it in (#4107) — the same class as the
    ``requests`` boot crash above.
    """
    declared = _declared_distributions()
    module_to_dists = importlib.metadata.packages_distributions()
    undeclared: dict[str, set[str]] = {}
    for module, files in _third_party_imports().items():
        dists = {canonicalize_name(d) for d in module_to_dists.get(module, [])}
        if not dists:
            # Not installed here (or not a distribution): compare by import name.
            dists = {canonicalize_name(module)}
        if not dists & declared:
            undeclared[module] = files
    assert not undeclared, (
        "imported by trueppm_api but missing from [project].dependencies "
        f"(declare them, do not rely on a transitive): {undeclared}"
    )
