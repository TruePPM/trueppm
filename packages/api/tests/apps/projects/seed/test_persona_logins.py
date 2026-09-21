"""Every persona the samples and the docs name can actually sign in (#3603, #3751).

Failures this guards, all of which shipped before: a persona the evaluation guide
tells a reader to sign in as whose password the loader never applied (#1760,
#3484); a docs page naming a username no fixture defines — a walkthrough that
dead-ends on its first step; and a sign-in table of bare names like ``maya`` that
no sample creates. That last one sat in README.md, which the username scan did not
read and whose bare names its prefixed pattern could not match (#3750).

The login test goes through the real endpoint the web app posts to, not
``force_authenticate`` and not a minted token, so a regression anywhere between the
loader's password handling and the JWT view fails it.

The roster test ties the published persona list and The Story's cast to
``.claude/personas.md``, the canonical roster: the overview kept a persona the
2026-07 revision retired, and The Story ran a second cast that gave a roster name
a different role, with nothing to notice either.
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
_REPO = Path(__file__).resolve().parents[6]
_DOCS = _REPO / "packages" / "website" / "src" / "content" / "docs"
_ROOT_PAGES = ("README.md", "CONTRIBUTING.md")
_PERSONAS = _REPO / ".claude" / "personas.md"
_USERNAME = re.compile(r"\b(?:atlas|aurora|bayside|ga|helios)-[a-z]+\b")
_SIGN_IN_HEADER = re.compile(r"^(?:username|sign in as)$", re.IGNORECASE)


@pytest.mark.django_db
@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_sample_persona_logs_in_through_the_token_endpoint(key: str) -> None:
    owner = User.objects.create_superuser("persona-login-owner", "owner@example.com", "x")
    load_sample(key, owner=owner, create_users=True, persona_password=_PASSWORD)

    failures: dict[str, Any] = {}
    for account in sample_accounts(key):
        # The login endpoint is scope-throttled on a shared LocMem cache; a pack's
        # worth of sign-ins in a row would 429 on the throttle, not on the password.
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


def _pages() -> list[Path]:
    """Every published docs page, plus the repository pages a new user reads first."""
    pages = sorted(_DOCS.rglob("*.md")) + sorted(_DOCS.rglob("*.mdx"))
    return pages + [_REPO / name for name in _ROOT_PAGES]


def _sign_in_usernames(text: str) -> list[str]:
    """Backticked names in the column a table's header calls ``Username`` or ``Sign in as``.

    A bare name in that column is a claim that the account exists, whatever it looks
    like — so unlike the prefixed-username scan, this does not care about the shape
    of the token.
    """
    found: list[str] = []
    column: int | None = None
    in_table = False
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            in_table, column = False, None
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not in_table:
            in_table = True
            column = next((i for i, cell in enumerate(cells) if _SIGN_IN_HEADER.match(cell)), None)
            continue
        if column is None or column >= len(cells) or set(cells[column]) <= set("-: "):
            continue
        found += re.findall(r"`([^`]+)`", cells[column])
    return found


def _section(path: Path, heading: str) -> str:
    text = path.read_text(encoding="utf-8")
    start = text.index(heading)
    end = text.find("\n## ", start + len(heading))
    return text[start : end if end != -1 else len(text)]


def _canonical_persona_names() -> list[str]:
    """First names of Personas 1-8 in .claude/personas.md; specialists are not in the roster."""
    text = _PERSONAS.read_text(encoding="utf-8")
    names = []
    for number in range(1, 9):
        section = re.search(rf"^## Persona {number} —.*?^\*\*Name\*\*:\s*(\S+)", text, re.M | re.S)
        assert section, f"personas.md has no Persona {number} with a **Name** line"
        names.append(section.group(1))
    return names


def test_every_username_the_docs_name_exists_in_a_fixture() -> None:
    known = _fixture_usernames()
    dangling: dict[str, list[str]] = {}
    pages = _pages()
    assert len(pages) > len(_ROOT_PAGES), f"no docs found under {_DOCS}"
    for page in pages:
        for token in set(_USERNAME.findall(page.read_text(encoding="utf-8"))):
            if token in known or _is_sample_key_fragment(token):
                continue
            dangling.setdefault(token, []).append(str(page.relative_to(_REPO)))
    assert not dangling, f"docs name persona usernames no fixture defines: {dangling}"


def test_every_sign_in_table_names_an_account_a_sample_creates() -> None:
    known = _fixture_usernames()
    dangling: dict[str, list[str]] = {}
    tables = 0
    for page in _pages():
        names = _sign_in_usernames(page.read_text(encoding="utf-8"))
        tables += bool(names)
        for name in names:
            if name not in known:
                dangling.setdefault(name, []).append(str(page.relative_to(_REPO)))
    # A scan that finds no sign-in table is not a pass: the README, the Quickstart
    # and the evaluation guide all carry one.
    assert tables >= 3, f"expected at least 3 sign-in tables, found {tables}"
    assert not dangling, f"sign-in tables name accounts no sample creates: {dangling}"


def test_sign_in_table_scan_catches_a_bare_name() -> None:
    """The #3750 shape: a README table of names with no sample prefix."""
    table = "| Username | Role |\n|---|---|\n| `maya` | Scrum Master |\n| `atlas-alex` | PM |\n"
    assert _sign_in_usernames(table) == ["maya", "atlas-alex"]
    assert _sign_in_usernames("| Who | Role |\n|---|---|\n| `maya` | SM |\n") == []


def test_docs_persona_roster_matches_personas_md() -> None:
    canonical = _canonical_persona_names()
    roster_section = _section(_DOCS / "overview" / "index.md", "## The eight personas")
    roster = re.findall(r"^\| \*\*(\w+)\*\* \|", roster_section, re.M)
    assert sorted(roster) == sorted(canonical), (
        f"overview/index.md lists {sorted(roster)}; "
        f".claude/personas.md Personas 1-8 are {sorted(canonical)}"
    )
    story_section = _section(_DOCS / "the-story.md", "## The six personas")
    cast = re.findall(r"^### (\w+) — ", story_section, re.M)
    assert len(cast) == 6, f"the-story.md should introduce six personas, found {cast}"
    stray = sorted(set(cast) - set(canonical))
    assert not stray, f"the-story.md casts personas that are not in .claude/personas.md: {stray}"
