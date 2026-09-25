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
