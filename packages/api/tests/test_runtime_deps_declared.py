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

import tomllib
from pathlib import Path

from packaging.requirements import Requirement

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_allauth_declares_socialaccount_extra() -> None:
    deps = tomllib.loads(_PYPROJECT.read_text())["project"]["dependencies"]
    allauth = [Requirement(d) for d in deps if Requirement(d).name == "django-allauth"]
    assert len(allauth) == 1
    assert "socialaccount" in allauth[0].extras


def _declared_names() -> set[str]:
    from packaging.utils import canonicalize_name

    deps = tomllib.loads(_PYPROJECT.read_text())["project"]["dependencies"]
    return {canonicalize_name(Requirement(d).name) for d in deps}


def _imported_top_level_modules() -> dict[str, str]:
    """Top-level module -> first ``file:line`` importing it, across all of ``src``.

    Function-level imports are included on purpose: ``ast.walk`` visits every
    node, and a lazy import in a request path is exactly the shape that stays
    invisible until an image boots without the transitive package.
    """
    import ast
    import sys

    src = Path(__file__).resolve().parents[1] / "src"
    found: dict[str, str] = {}
    for path in sorted(src.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module.split(".")[0]]
            else:
                continue
            for name in names:
                if name in sys.stdlib_module_names or name in {"trueppm_api", "__future__"}:
                    continue
                found.setdefault(name, f"{path.relative_to(src)}:{node.lineno}")
    return found


def test_numpy_is_declared_directly() -> None:
    """numpy reaches the API only via trueppm-scheduler today; our own code imports it (#4107)."""
    assert "numpy" in _declared_names()
    assert "numpy" in _imported_top_level_modules()


# Imported by our code but deliberately left to arrive with their parent, because
# each is a hard, version-locked dependency of a package we declare (Django ->
# asgiref, celery -> kombu). Declaring them would add a second pin that can drift
# from the parent's. Do not add to this list to silence a new finding: declare it.
_TRANSITIVE_BY_DESIGN = {"asgiref", "kombu"}


def test_every_third_party_import_in_src_is_a_declared_dependency() -> None:
    """A package imported by our code must be declared, not merely reachable transitively."""
    from importlib.metadata import packages_distributions

    from packaging.utils import canonicalize_name

    declared = _declared_names()
    dists = packages_distributions()
    undeclared = {}
    for module, where in _imported_top_level_modules().items():
        providers = {canonicalize_name(d) for d in dists.get(module, [])}
        if module in _TRANSITIVE_BY_DESIGN:
            continue
        if not providers:
            continue  # optional/enterprise import not installed here; cannot be mapped
        if not providers & declared:
            undeclared[module] = (where, sorted(providers))
    assert not undeclared, f"imported but not declared in pyproject dependencies: {undeclared}"
