"""Template gallery: ``?source_project=`` (#3316) and the detail ``outline`` (#3084).

``source_project`` replaces a client-side filter over page 1 of the whole gallery,
so the property worth pinning is that it is correct *past* page 1 and that it only
ever narrows the caller's visible pool. ``outline`` is the row names applying a
template writes; the property worth pinning is that it is read off the same frozen
document ``materialize_structure`` writes from, in WBS order, and that it stays off
the list endpoint.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.projects.bundled_templates import stage_gate_delivery
from trueppm_api.apps.projects.models import Calendar, Program, Project, ProjectTemplate
from trueppm_api.apps.projects.project_templates import (
    outline_structure,
    summarize_structure,
)

from ...test_openapi_response_conformance import (
    assert_response_matches_schema,
    load_committed_schema,
)

User = get_user_model()

URL = "/api/v1/project-templates/"


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="gallery-reader", password="pw")


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Std")


def _project(calendar: Calendar, name: str, **kw: Any) -> Project:
    return Project.objects.create(name=name, start_date=date(2026, 4, 1), calendar=calendar, **kw)


def _template(name: str, source: Project | None = None, **kw: Any) -> ProjectTemplate:
    return ProjectTemplate.objects.create(
        name=name,
        structure=kw.pop("structure", {"version": 1, "tasks": []}),
        source_project=source,
        **kw,
    )


# ---------------------------------------------------------------------------
# ?source_project= (#3316)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_source_project_filter_finds_a_project_s_templates_past_page_one(
    client: APIClient, calendar: Calendar
) -> None:
    """The defect: the old client filter only ever saw ``data.results`` of page 1."""
    mine = _project(calendar, "Mine")
    other = _project(calendar, "Other")
    # "z…" names sort after the "a…" filler, so an unfiltered first page cannot hold them.
    for i in range(60):
        _template(f"a-filler-{i:02d}", source=other)
    wanted = {
        str(_template("z-mine-1", source=mine).pk),
        str(_template("z-mine-2", source=mine).pk),
    }

    unfiltered = client.get(URL).json()
    assert not wanted & {row["id"] for row in unfiltered["results"]}, (
        "fixture no longer pushes the project's templates off page 1"
    )

    resp = client.get(URL, {"source_project": str(mine.pk)})
    assert resp.status_code == 200
    body = resp.json()
    assert {row["id"] for row in body["results"]} == wanted
    assert body["count"] == 2


@pytest.mark.django_db
def test_source_project_filter_cannot_widen_past_program_membership(
    client: APIClient, calendar: Calendar
) -> None:
    """It narrows the membership-scoped pool; it is not a second way into it (#4005)."""
    program = Program.objects.create(name="Elsewhere")
    source = _project(calendar, "Program project", program=program)
    _template("Hidden", source=source, program=program)

    resp = client.get(URL, {"source_project": str(source.pk)})
    assert resp.status_code == 200
    assert resp.json()["results"] == []


@pytest.mark.django_db
@pytest.mark.parametrize("param", ["source_project", "program"])
@pytest.mark.parametrize("bad", ["not-a-uuid", "123", "'; DROP TABLE x;--"])
def test_a_malformed_gallery_filter_is_a_400_not_a_500(
    client: APIClient, param: str, bad: str
) -> None:
    """Both filters reach a UUID column; Django's ValidationError there is a 500 (#2785)."""
    resp = client.get(URL, {param: bad})
    assert resp.status_code == 400
    assert param in resp.json()
    assert_response_matches_schema(
        load_committed_schema(), resp, "/api/v1/project-templates/", "get", "400"
    )


# ---------------------------------------------------------------------------
# outline (#3084)
# ---------------------------------------------------------------------------


def test_outline_of_the_stage_gate_starter_names_every_gate_in_wbs_order() -> None:
    structure = stage_gate_delivery()
    outline = outline_structure(structure)

    names = [row["name"] for row in outline]
    gates = [row["name"] for row in outline if row["kind"] == "gate"]
    assert gates == [
        "Gate 1 — approved to plan",
        "Gate 2 — approved to execute",
        "Gate 3 — approved to release",
        "Gate 4 — closed",
    ]
    # Same rows the document carries — no second list, nothing dropped or invented.
    assert sorted(names) == sorted(t["name"] for t in structure["tasks"])
    # The kinds agree with the counts the card's carries line already shows.
    counts = summarize_structure(structure)
    assert sum(1 for r in outline if r["kind"] == "phase") == counts["phase_count"]
    assert len(gates) == counts["gate_count"]
    assert outline[0]["depth"] == 0
    assert all(set(row) == {"name", "kind", "depth"} for row in outline)


def test_outline_sorts_numerically_and_puts_pathless_rows_last() -> None:
    def node(ref: str, path: str | None, **kw: Any) -> dict[str, Any]:
        return {"ref": ref, "name": ref, "wbs_path": path, **kw}

    structure = {
        "tasks": [
            node("loose", None),
            node("p1.10", "1.10"),
            node("p2", "2"),
            node("p1.9", "1.9"),
            node("p1", "1"),
            node("m", "2.1", is_milestone=True),
        ]
    }
    outline = outline_structure(structure)
    assert [r["name"] for r in outline] == ["p1", "p1.9", "p1.10", "p2", "m", "loose"]
    kinds = {r["name"]: r["kind"] for r in outline}
    assert kinds == {
        "p1": "phase",
        "p1.9": "task",
        "p1.10": "task",
        "p2": "phase",
        "m": "milestone",
        "loose": "task",
    }
    assert {r["name"]: r["depth"] for r in outline}["p1.10"] == 1


def test_outline_of_an_empty_or_malformed_document_is_empty() -> None:
    assert outline_structure({}) == []
    assert outline_structure({"tasks": ["not a node", {"ref": "x"}]}) == []


@pytest.mark.django_db
def test_detail_carries_the_outline_and_the_list_does_not(client: APIClient) -> None:
    template = _template("Stage-gate", structure=stage_gate_delivery())

    detail = client.get(f"{URL}{template.pk}/")
    assert detail.status_code == 200
    assert detail.json()["outline"] == outline_structure(stage_gate_delivery())
    # Still never the document itself.
    assert "structure" not in detail.json()

    # The published contract declares this body (ProjectTemplateDetail), so a
    # generated client can read `outline` rather than discover it.
    assert_response_matches_schema(
        load_committed_schema(), detail, "/api/v1/project-templates/{id}/"
    )

    listed = client.get(URL).json()["results"]
    row = next(r for r in listed if r["id"] == str(template.pk))
    assert "outline" not in row
