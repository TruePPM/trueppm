# ruff: noqa: F811
"""``?search=`` / ``?ordering=`` must not run against a detail route's pk lookup (#3451).

``GenericAPIView.get_object()`` resolves through ``filter_queryset()``, so every
viewset declaring ``search_fields`` 404'd a detail route whose object did not match the
term. The fix is one shared mixin; these tests derive the viewsets from the live URL
conf so a viewset added later is covered without anyone editing a list.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from django.urls import URLPattern, URLResolver, get_resolver
from rest_framework.generics import GenericAPIView

from trueppm_api.apps.projects.models import Calendar, Label, Program, Project, Risk, Task
from trueppm_api.apps.resources.models import Resource, Skill
from trueppm_api.core.detail_lookup import DetailLookupIgnoresSearchMixin

from .test_mcp_team_opt_out import (  # noqa: F401  (fixtures)  # noqa: F401
    _agent,
    _human,
    _opt_out,
    calendar,
    other_project,
    owner,
    program,
    project,
)


def _walk(patterns: list[Any]) -> Iterator[URLPattern]:
    for p in patterns:
        if isinstance(p, URLResolver):
            yield from _walk(p.url_patterns)
        else:
            yield p


def _search_viewsets() -> list[type]:
    found: dict[str, type] = {}
    for p in _walk(get_resolver().url_patterns):
        cls = getattr(p.callback, "cls", None)
        if cls is not None and getattr(cls, "search_fields", None):
            found[f"{cls.__module__}.{cls.__qualname__}"] = cls
    return [found[k] for k in sorted(found)]


SEARCH_VIEWSETS = _search_viewsets()


def test_registry_has_a_nonzero_denominator() -> None:
    # The 8 known today: Calendar, Project, Task, Risk, Label, Skill, Resource, Program.
    assert len(SEARCH_VIEWSETS) >= 8, [c.__name__ for c in SEARCH_VIEWSETS]


@pytest.mark.parametrize("view", SEARCH_VIEWSETS, ids=lambda c: c.__name__)
def test_every_search_viewset_uses_the_detail_lookup_mixin(view: type) -> None:
    assert issubclass(view, DetailLookupIgnoresSearchMixin), (
        f"{view.__name__} declares search_fields but its detail routes will 404 on a "
        "non-matching ?search= — add DetailLookupIgnoresSearchMixin first in its bases"
    )
    # It must precede GenericAPIView or its get_object() is shadowed by DRF's.
    mro = view.__mro__
    assert mro.index(DetailLookupIgnoresSearchMixin) < mro.index(GenericAPIView), (
        f"{view.__name__}: DetailLookupIgnoresSearchMixin must precede the viewset bases"
    )


@pytest.fixture
def detail_urls(
    project: Project, program: Program, calendar: Calendar, owner: Any
) -> dict[str, str]:
    task = Task.objects.create(project=project, name="Pour foundation")
    risk = Risk.objects.create(project=project, title="Rain", probability=2, impact=3)
    label = Label.objects.create(project=project, name="blocked")
    skill = Skill.objects.create(name="Welding", normalized_name="welding")
    resource = Resource.objects.create(name="Dana")
    return {
        "CalendarViewSet": f"/api/v1/calendars/{calendar.pk}/",
        "ProjectViewSet": f"/api/v1/projects/{project.pk}/",
        "TaskViewSet": f"/api/v1/tasks/{task.pk}/",
        "RiskViewSet": f"/api/v1/projects/{project.pk}/risks/{risk.pk}/",
        "LabelViewSet": f"/api/v1/projects/{project.pk}/labels/{label.pk}/",
        "SkillViewSet": f"/api/v1/skills/{skill.pk}/",
        "ResourceViewSet": f"/api/v1/resources/{resource.pk}/",
        "ProgramViewSet": f"/api/v1/programs/{program.pk}/",
    }


@pytest.mark.django_db
@pytest.mark.parametrize(
    "name",
    [
        "CalendarViewSet",
        "ProjectViewSet",
        "TaskViewSet",
        "RiskViewSet",
        "LabelViewSet",
        "SkillViewSet",
        "ResourceViewSet",
        "ProgramViewSet",
    ],
)
@pytest.mark.parametrize("query", ["?search=zzz-no-match", "?ordering=-name"])
# The ?ordering= cases are smoke-only: every ordering_fields entry is a concrete column,
# so ordering never filtered a pk lookup and a no-op mixin still passes them. Only the
# ?search= cases can fail without the mixin.
def test_detail_get_ignores_search_and_ordering(
    name: str, query: str, detail_urls: dict[str, str], owner: Any
) -> None:
    assert name in {c.__name__ for c in SEARCH_VIEWSETS}
    client = _human(owner)
    url = detail_urls[name]
    assert client.get(url).status_code == 200
    resp = client.get(url + query)
    assert resp.status_code == 200, (url, resp.status_code)


@pytest.mark.django_db
def test_list_search_still_narrows(project: Project, other_project: Project, owner: Any) -> None:
    resp = _human(owner).get("/api/v1/projects/?search=QuokkaOpenProj")
    assert resp.status_code == 200
    names = {r["name"] for r in resp.data["results"]}
    assert other_project.name in names or project.name in names
    resp = _human(owner).get("/api/v1/projects/?search=zzz-no-match")
    assert resp.data["results"] == []


@pytest.mark.django_db
def test_mcp_opt_out_still_enforced_on_detail_with_search(
    project: Project, other_project: Project, owner: Any
) -> None:
    """The opted-out child 404s for an agent even when ``?search=`` is sent.

    ``other_project`` stays opted in, so ``mcp_visible_project_ids`` is a real set and
    not ``None`` (#3022) — otherwise the narrowing is skipped and the assertion is
    vacuous. A human is unaffected.
    """
    _opt_out(project)
    agent = _agent(owner)
    for suffix in ("", "?search=zzz-no-match", f"?search={project.name}"):
        denied = agent.get(f"/api/v1/projects/{project.pk}/{suffix}")
        assert denied.status_code in (403, 404), (suffix, denied.status_code)
    allowed = agent.get(f"/api/v1/projects/{other_project.pk}/?search=zzz-no-match")
    assert allowed.status_code == 200, allowed.status_code
    assert _human(owner).get(f"/api/v1/projects/{project.pk}/?search=zzz").status_code == 200


@pytest.mark.django_db
def test_mcp_program_denial_still_enforced_with_search(
    project: Project, program: Program, owner: Any
) -> None:
    program.mcp_enabled = False
    program.save(update_fields=["mcp_enabled"])
    agent = _agent(owner)
    for suffix in ("", "?search=zzz-no-match", f"?search={program.name}"):
        r = agent.get(f"/api/v1/programs/{program.pk}/{suffix}")
        assert r.status_code in (403, 404), (suffix, r.status_code)
