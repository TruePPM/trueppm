"""The one-page status-update PDF and the anonymous share read it pairs with (#4805).

PDF: members only, Letter and A4, drawn from the frozen snapshot, one page for the
longest allowed content, refused when the row no longer matches its seal. Share:
the anonymous read serves the frozen projection, and an unknown or expired token is
the same 404 (no enumeration oracle). Revoked tokens are covered in
``test_status_updates.py``.
"""

from __future__ import annotations

import re
import secrets
import zlib
from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import share_services, status_update_pdf
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.models import (
    SCOPE_MCP_READ,
    ApiToken,
    Calendar,
    Project,
    Task,
)

User = get_user_model()


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    cache.clear()
    yield
    cache.clear()


@pytest.fixture
def project(db: object) -> Project:
    return Project.objects.create(
        name="Riverside",
        code="RIV",
        start_date=date(2026, 1, 5),
        calendar=Calendar.objects.create(name="Standard"),
        public_sharing=True,
    )


def _member(project: Project, username: str, role: int) -> Any:
    user = User.objects.create_user(username=username, password="pw", first_name="Pat")
    ProjectMembership.objects.create(project=project, user=user, role=role)
    return user


def _client(user: Any) -> APIClient:
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def pm_client(project: Project) -> APIClient:
    return _client(_member(project, "pm", Role.ADMIN))


def _post(client: APIClient, project: Project, narrative: str = "Vendor slipped.") -> Any:
    resp = client.post(
        f"/api/v1/projects/{project.pk}/status-updates/",
        {"rag": "amber", "narrative": narrative},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    return resp.json()


def _pdf_url(project: Project, update_id: Any, size: str | None = None) -> str:
    url = f"/api/v1/projects/{project.pk}/status-updates/{update_id}/pdf/"
    return f"{url}?size={size}" if size else url


def _pages(pdf: bytes) -> int:
    return len(re.findall(rb"/Type /Page\b(?!s)", pdf))


def _media_box(pdf: bytes) -> tuple[float, float]:
    m = re.search(rb"/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]", pdf)
    assert m is not None
    return float(m.group(1)), float(m.group(2))


def _text(pdf: bytes) -> bytes:
    m = re.search(rb"stream\n(.*?)\nendstream", pdf, re.S)
    assert m is not None
    return zlib.decompress(m.group(1))


# --- The endpoint --------------------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("size", "box"), [("letter", (612.0, 792.0)), ("a4", (595.28, 841.89)), (None, (612.0, 792.0))]
)
def test_pdf_is_one_page_in_each_size(
    project: Project, pm_client: APIClient, size: str | None, box: tuple[float, float]
) -> None:
    created = _post(pm_client, project)
    resp = pm_client.get(_pdf_url(project, created["id"], size))
    assert resp.status_code == 200
    assert resp["Content-Type"] == "application/pdf"
    assert resp["Cache-Control"] == "private, no-store"
    assert resp["Content-Disposition"].startswith('attachment; filename="RIV-status-update-1-')
    body = resp.content
    assert body.startswith(b"%PDF-1.4")
    assert _pages(body) == 1
    assert _media_box(body) == box
    assert b"/JavaScript" not in body and b"/Annots" not in body and b"/URI" not in body


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("role", "expected"),
    [
        (Role.VIEWER, 200),
        (Role.MEMBER, 200),
        (Role.SCHEDULER, 200),
        (Role.ADMIN, 200),
        (Role.OWNER, 200),
    ],
)
def test_every_member_can_download(
    project: Project, pm_client: APIClient, role: int, expected: int
) -> None:
    created = _post(pm_client, project)
    reader = _client(_member(project, f"r{role}", role))
    assert reader.get(_pdf_url(project, created["id"])).status_code == expected


@pytest.mark.django_db
def test_non_member_and_anonymous_are_refused(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project)
    stranger = _client(User.objects.create_user(username="stranger"))
    assert stranger.get(_pdf_url(project, created["id"])).status_code in (403, 404)
    assert APIClient().get(_pdf_url(project, created["id"])).status_code == 401


@pytest.mark.django_db
def test_update_of_another_project_is_404(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project)
    other = Project.objects.create(name="Other", start_date=date(2026, 1, 5))
    ProjectMembership.objects.create(
        project=other, user=User.objects.get(username="pm"), role=Role.ADMIN
    )
    assert pm_client.get(_pdf_url(other, created["id"])).status_code == 404


@pytest.mark.django_db
def test_unknown_size_is_400(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project)
    resp = pm_client.get(_pdf_url(project, created["id"], "legal"))
    assert resp.status_code == 400
    assert "size" in resp.json()


@pytest.mark.django_db
def test_pdf_prints_the_frozen_snapshot_not_the_live_plan(
    project: Project, pm_client: APIClient
) -> None:
    gate = Task.objects.create(
        project=project,
        name="Gate A",
        duration=0,
        is_milestone=True,
        early_start=date(2026, 3, 2),
        early_finish=date(2026, 3, 2),
    )
    created = _post(pm_client, project)
    Task.objects.filter(pk=gate.pk).update(early_finish=date(2026, 4, 1), name="Renamed")
    text = _text(pm_client.get(_pdf_url(project, created["id"])).content)
    assert b"(Gate A)" in text
    assert b"Mar 2, 2026" in text
    assert b"Renamed" not in text
    assert b"Apr 1, 2026" not in text


@pytest.mark.django_db
def test_tampered_row_is_not_printed(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project)
    with connection.cursor() as cur:
        cur.execute(
            "UPDATE projects_statusupdate SET narrative = 'Rewritten' WHERE id = %s",
            [created["id"]],
        )
    resp = pm_client.get(_pdf_url(project, created["id"]))
    assert resp.status_code == 409


@pytest.mark.django_db
def test_pdf_is_cached_per_update_and_follows_a_rename(
    project: Project, pm_client: APIClient
) -> None:
    created = _post(pm_client, project)
    first = pm_client.get(_pdf_url(project, created["id"])).content
    assert pm_client.get(_pdf_url(project, created["id"])).content == first
    Project.objects.filter(pk=project.pk).update(name="Riverside Phase 2")
    renamed = pm_client.get(_pdf_url(project, created["id"])).content
    assert b"Riverside Phase 2" in _text(renamed)


@pytest.mark.django_db
def test_mcp_read_token_can_download(project: Project, pm_client: APIClient, settings: Any) -> None:
    settings.TRUEPPM_MCP_ENABLED = True
    created = _post(pm_client, project)
    owner = User.objects.get(username="pm")
    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    ApiToken.objects.create(
        owner=owner,
        name="reader",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=owner,
        scopes=[SCOPE_MCP_READ],
        expires_at=timezone.now() + timedelta(days=30),
    )
    agent = APIClient()
    agent.credentials(HTTP_AUTHORIZATION=f"Bearer {raw}")
    resp = agent.get(_pdf_url(project, created["id"]))
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF-1.4")


# --- One page for the longest allowed content --------------------------------------


def _longest_facts() -> status_update_pdf.PdfFacts:
    def metric(value: Any) -> dict[str, Any]:
        return {
            "value": value,
            "as_of": "2026-11-25T12:00:00+00:00",
            "definition": "A long definition sentence that wraps across the page. " * 12,
        }

    long = "W" * 200
    snapshot = {
        "as_of": "2026-11-25T12:00:00+00:00",
        "previous_seq": 41,
        "forecast": {
            "p50": metric("2027-01-04"),
            "p80": metric("2027-02-15"),
            "cpm_finish": metric("2027-01-11"),
            "baseline_finish": "2026-12-20",
            "baseline_finish_variance_days": metric(-12),
        },
        "milestones": [
            {
                "task_id": str(i),
                "name": long,
                "cpm_finish": "2027-01-01",
                "baseline_finish": "2026-12-01",
                "variance_days": 22,
            }
            for i in range(50)
        ],
        "milestones_truncated": True,
        "counts": {
            "completed_since_previous": metric(999),
            "slipped_since_previous": metric(50),
        },
        "risks": [
            {"title": long, "probability": 5, "impact": 5, "severity": 25, "owner": long}
            for _ in range(3)
        ],
        "decisions": [{"title": long, "due_date": "2027-01-01", "owner": long} for _ in range(10)],
    }
    return status_update_pdf.PdfFacts(
        project_name=long,
        project_code="ABCDEFGHIJ",
        seq=42,
        rag="red",
        narrative="",
        posted_at="2026-11-25T12:00:00+00:00",
        author=long,
        computed_health="critical",
        snapshot=snapshot,
    )


#: The narrative is the only text drawn in regular 10pt ink.
_NARRATIVE_OP = re.compile(
    rb"/F1 10\.00 Tf 0\.110 0\.120 0\.140 rg [\d.]+ [\d.]+ Td \((.*?)\) Tj ET"
)


def _drawn_narrative(text: bytes) -> str:
    """Every character the page drew for the narrative, in order, without whitespace."""
    drawn = [
        re.sub(rb"\\(.)", rb"\1", m.group(1)).decode("latin-1")
        for m in _NARRATIVE_OP.finditer(text)
    ]
    return "".join("".join(drawn).split())


def _widest_lines(chars: int) -> str:
    """Lines of '@' (the widest glyph) just too wide for two to share a run-in line."""
    return (("@" * 25 + "\n") * 30)[:chars]


@pytest.mark.parametrize("size", ["letter", "a4"])
@pytest.mark.parametrize(
    "narrative",
    [
        ("Wide words like MMMMMMMM make the longest wrap. " * 13)[:600],
        "a\n" * 300,  # the most lines 600 characters can ask for
        "a\n\n" * 200,  # the most lines and paragraph gaps
        "W" * 600,  # one unbroken word
        "@" * 600,  # the widest glyph, unbroken
        _widest_lines(600),
    ],
    ids=["wide-words", "300-lines", "200-paragraphs", "600-W", "600-at", "widest-lines"],
)
def test_longest_content_fits_one_page(size: str, narrative: str) -> None:
    """Any legal narrative prints in full, with every list at its longest, on one page."""
    assert len(narrative) <= 600
    facts = _longest_facts()
    facts = status_update_pdf.PdfFacts(**{**facts.__dict__, "narrative": narrative})
    page = status_update_pdf.layout_status_update(facts, size)
    width, height = status_update_pdf.PAGE_SIZES[size]
    # The definitions must overrun the footer cap, or the worst case is not tested.
    definition = facts.snapshot["forecast"]["p80"]["definition"]
    inner = width - 2 * status_update_pdf.MARGIN
    assert (
        len(status_update_pdf.wrap(f"P80: {definition}", inner, 7))
        > status_update_pdf.MAX_FOOTER_PARAGRAPH_LINES
    )
    assert page.body_bottom < page.footer_top, "body runs into the footer"
    assert page.lowest <= height - status_update_pdf.MARGIN + 10
    pdf = status_update_pdf.render_pdf(facts, size)
    assert _pages(pdf) == 1
    # Every character of the narrative is on the page; a run-in narrative adds only
    # the break marks.
    drawn = _drawn_narrative(_text(pdf))
    assert drawn.replace("/", "") == "".join(narrative.split())


def test_run_in_only_when_the_line_breaks_cannot_fit() -> None:
    facts = status_update_pdf.PdfFacts(**{**_longest_facts().__dict__, "narrative": "a\n" * 300})
    text = _text(status_update_pdf.render_pdf(facts, "letter"))
    assert b"(a / a / a" in text
    fits = status_update_pdf.PdfFacts(**{**facts.__dict__, "narrative": TWENTY_BULLETS})
    assert b" / " not in b"".join(
        m.group(1) for m in _NARRATIVE_OP.finditer(_text(status_update_pdf.render_pdf(fits, "a4")))
    )
    assert status_update_pdf.run_in("one\r\n\n  two \nthree") == "one / two / three"


#: Twenty bulleted lines of 29 characters each (579 characters with the breaks): legal,
#: and taller than the narrative's share of the page while every list is full.
TWENTY_BULLETS = "\n".join(f"- Bullet {i:02d} of the update xxxx"[:29] for i in range(20))


@pytest.mark.parametrize("size", ["letter", "a4"])
def test_a_many_line_narrative_prints_in_full_and_lists_give_way(size: str) -> None:
    assert len(TWENTY_BULLETS) <= 600
    assert all(len(ln) == 29 for ln in TWENTY_BULLETS.split("\n"))
    facts = status_update_pdf.PdfFacts(**{**_longest_facts().__dict__, "narrative": TWENTY_BULLETS})
    page = status_update_pdf.layout_status_update(facts, size)
    assert page.body_bottom < page.footer_top, "body runs into the footer"
    text = _text(status_update_pdf.render_pdf(facts, size))
    for line in TWENTY_BULLETS.split("\n"):
        assert status_update_pdf._pdf_string(line) + b" Tj" in text, line
    # The milestone rows gave way first, and their count line still names them all.
    assert b"(50+ milestones in TruePPM)" in text or b"more milestones in TruePPM" in text


def test_text_is_escaped_and_out_of_range_characters_are_replaced() -> None:
    assert status_update_pdf._pdf_string("a(b)c\\") == b"(a\\(b\\)c\\\\)"
    assert status_update_pdf._pdf_string("Zoë — 中") == b"(Zo\xeb \x97 ?)"


def test_wrap_splits_a_word_wider_than_the_line() -> None:
    lines = status_update_pdf.wrap("W" * 100, 100, 10)
    assert len(lines) > 1
    assert all(status_update_pdf.text_width(ln, 10) <= 100 for ln in lines)


# --- The anonymous share read the web render uses ----------------------------------


@pytest.mark.django_db
def test_anonymous_share_read_and_uniform_404(project: Project, pm_client: APIClient) -> None:
    created = _post(pm_client, project, "First paragraph.\n\nSecond paragraph.")
    minted = pm_client.post(
        f"/api/v1/projects/{project.pk}/share-links/",
        {"content_kind": "status_update", "status_update": created["id"]},
        format="json",
    ).json()
    listed = pm_client.get(f"/api/v1/projects/{project.pk}/share-links/").json()
    assert [(r["content_kind"], r["status_update_seq"]) for r in listed] == [("status_update", 1)]
    anon = APIClient()
    ok = anon.get(f"/api/v1/share/status-update/{minted['token']}/")
    assert ok.status_code == 200
    assert ok.json()["narrative"] == "First paragraph.\n\nSecond paragraph."
    assert ok["Referrer-Policy"] == "no-referrer"

    unknown = anon.get("/api/v1/share/status-update/not-a-real-token/")
    link = share_services.resolve_share_link(minted["token"], "status_update")
    assert link is not None
    link.expires_at = timezone.now() - timedelta(minutes=1)
    link.save(update_fields=["expires_at"])
    expired = anon.get(f"/api/v1/share/status-update/{minted['token']}/")
    assert unknown.status_code == expired.status_code == 404
    assert unknown.json() == expired.json()
