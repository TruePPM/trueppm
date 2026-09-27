"""Every shipped sample seed's projects must carry an explicit ``code`` (#4149).

Under #4148 / ADR-1237 a project's ``code`` becomes its key — shown in every URL
and object reference (``PLAT-T-12``, ``PLAT-R-7``). Before this, none of the five
bundled sample seeds set one, so demo projects loaded with a blank code and every
qualified reference silently fell back to the unqualified form. This guards two
things: every project in every committed fixture declares a code shaped like a
real project key, and no two projects across the whole bundle collide on one —
a portfolio view that loads more than one sample at a time must be able to tell
them apart.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed import import_seed

User = get_user_model()

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)
_SEED_FILES = sorted(_SEEDS_DIR.glob("*.json"))

_CODE_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_bundled_seeds_exist() -> None:
    """A regression guard for the guard: fail loudly if the glob finds nothing."""
    assert len(_SEED_FILES) == 5, f"expected 5 bundled sample seeds, found {_SEED_FILES}"


@pytest.mark.parametrize("path", _SEED_FILES, ids=lambda p: p.name)
def test_every_project_in_every_seed_has_a_code(path: Path) -> None:
    payload = _load(path)
    projects = payload.get("projects", [])
    assert projects, f"{path.name} declares no projects"
    for project in projects:
        code = project.get("code")
        assert code, f"{path.name}: project {project.get('slug')!r} has no code"
        assert _CODE_RE.match(code), (
            f"{path.name}: project {project.get('slug')!r} has code {code!r}, "
            f"which does not match {_CODE_RE.pattern}"
        )


def test_project_codes_are_unique_across_every_bundled_seed() -> None:
    seen: dict[str, str] = {}
    for path in _SEED_FILES:
        payload = _load(path)
        for project in payload.get("projects", []):
            code = project["code"]
            if code in seen:
                pytest.fail(
                    f"code {code!r} used by both {seen[code]} and "
                    f"{path.name}:{project['slug']} — codes must be unique across "
                    "every sample so a portfolio loading more than one stays "
                    "unambiguous"
                )
            seen[code] = f"{path.name}:{project['slug']}"


@pytest.mark.django_db
def test_imported_sample_project_code_matches_the_seed() -> None:
    """The importer must actually persist the seed's ``code``, not just accept it."""
    owner = User.objects.create_user(username="seed-code-owner", email="o@example.com")
    payload = _load(_SEEDS_DIR / "atlas-platform-launch.json")
    program = import_seed(payload, owner=owner, create_users=True, is_sample=True)

    for project_data in payload["projects"]:
        project = Project.objects.get(program=program, name=project_data["name"])
        assert project.code == project_data["code"]
