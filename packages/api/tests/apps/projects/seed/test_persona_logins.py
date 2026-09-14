"""Every persona the samples and the docs name can actually sign in (#3603).

Two failures this guards, both of which shipped before: a persona the evaluation
guide tells a reader to sign in as whose password the loader never applied (#1760,
#3484), and a docs page naming a username no fixture defines — a walkthrough that
dead-ends on its first step.

The login test goes through the real endpoint the web app posts to, not
``force_authenticate`` and not a minted token, so a regression anywhere between the
loader's password handling and the JWT view fails it.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from rest_framework.test import APIClient

from trueppm_api.apps.projects.seed.samples import SAMPLES, load_sample, sample_accounts

User = get_user_model()

_PASSWORD = "persona-login-3603"
_DOCS = Path(__file__).resolve().parents[6] / "packages" / "website" / "src" / "content" / "docs"
_USERNAME = re.compile(r"\b(?:atlas|aurora|bayside|ga|helios)-[a-z]+\b")


@pytest.mark.django_db
@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_sample_persona_logs_in_through_the_token_endpoint(key: str) -> None:
    owner = User.objects.create_superuser("persona-login-owner", "owner@example.com", "x")
    load_sample(key, owner=owner, create_users=True, persona_password=_PASSWORD)

    failures: dict[str, Any] = {}
    for account in sample_accounts(key):
        # The login endpoint is scope-throttled on a shared LocMem cache; fifteen
        # sign-ins in a row would 429 on the throttle, not on the password.
        cache.clear()
        resp = APIClient().post(
            "/api/v1/auth/token/",
            {"username": account["username"], "password": _PASSWORD},
            format="json",
        )
        if resp.status_code != 200 or "access" not in resp.data:
            failures[account["username"]] = (resp.status_code, resp.content[:200])
    assert not failures, f"{key}: personas that cannot sign in: {failures}"


def _fixture_usernames() -> set[str]:
    return {a["username"] for key in SAMPLES for a in sample_accounts(key)}


def _is_sample_key_fragment(token: str) -> bool:
    """``ga-launch`` and ``atlas-platform`` (from ``atlas-platform-launch``) are keys."""
    return any(key == token or key.startswith(f"{token}-") for key in SAMPLES)


def test_every_username_the_docs_name_exists_in_a_fixture() -> None:
    known = _fixture_usernames()
    dangling: dict[str, list[str]] = {}
    pages = sorted(_DOCS.rglob("*.md")) + sorted(_DOCS.rglob("*.mdx"))
    assert pages, f"no docs found under {_DOCS}"
    for page in pages:
        for token in set(_USERNAME.findall(page.read_text(encoding="utf-8"))):
            if token in known or _is_sample_key_fragment(token):
                continue
            dangling.setdefault(token, []).append(str(page.relative_to(_DOCS)))
    assert not dangling, f"docs name persona usernames no fixture defines: {dangling}"
