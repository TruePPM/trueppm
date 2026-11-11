"""Guard: the ungated velocity readers are the unusual, declared path (#2993).

Seven issues (#981, #949, #1957, #932, #2895, #2982, …) were the same defect at
different sinks: a response read the raw velocity band and the ADR-0104 gate was a
second line its author forgot to write. The safe and the unsafe call looked
identical at the call site.

Now the raw accessor is named ``velocity_summary_unfiltered``, the ordinary one is
``signal_privacy_services.velocity_summary_for(request, project_id)`` (gated), and
this test walks the API source tree: every reference to a raw or velocity-derived
reader must carry a ``# velocity-unfiltered-ok: <reason>`` comment on its line or
within the :data:`_WINDOW` lines above it. A new sink that reaches for the raw
numbers fails here, by name, instead of shipping a silent leak.

The derived readers are listed, not only the raw summary, because the leaks that
actually shipped were scalars copied out of the band into another payload shape
(#2982's ``velocity_low``/``velocity_high``, #981's ``sprints_to_complete_*``). A
function that returns velocity-derived values to a caller is in :data:`GUARDED`.

Coverage is by NAME, and only what a name can see. ``SprintSerializer``'s
``completed_points`` / ``completion_ratio_points`` / ``completed_task_count`` are
plain ModelSerializer fields: they are per-sprint velocity series served by a field
list, not a call to a named reader, so this guard cannot see them. That is a known
blind spot, not a clean bill.

A marker acknowledges only the first guarded reference after it, and is read from a
real comment (a string containing the marker text does not count). ``getattr(x,
"<name>")`` and ``x.__dict__["<name>"]`` with a constant guarded name are flagged.

What this does not prove: that the acknowledged sink gates correctly. The comment
is a declaration, not a check — it removes the silence, and the per-sink tests in
``test_signal_privacy.py`` and its siblings prove the behavior.
"""

from __future__ import annotations

import ast
import io
import tokenize
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects import services
from trueppm_api.apps.projects.models import Project, Sprint, SprintState
from trueppm_api.apps.projects.signal_privacy_services import velocity_summary_for

SRC_ROOT = Path(__file__).resolve().parents[3] / "src" / "trueppm_api"
MARKER = "velocity-unfiltered-ok:"
_WINDOW = 3

# Readers that return the raw velocity band, or values derived from it, without
# applying the ADR-0104 read gate. Add a function here when it returns such values
# to a caller that is expected to gate them.
GUARDED = frozenset(
    {
        "velocity_summary_unfiltered",
        "velocity_bands_for_projects_unfiltered",
        "_velocity_block",
        "project_forecast",
        "sprint_forecast",
        "reforecast_preview",
        "reforecast_bound_milestone",
        "velocity_eligible_sprints",
        "capacity_hint",
    }
)


def _markers(source: str) -> list[int]:
    """Line numbers of real ``# velocity-unfiltered-ok: <reason>`` comments.

    Read from tokenize COMMENT tokens, so marker text inside a string literal or
    docstring does not count as a declaration.
    """
    found: list[int] = []
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type != tokenize.COMMENT:
            continue
        pos = tok.string.find(MARKER)
        if pos != -1 and tok.string[pos + len(MARKER) :].strip():
            found.append(tok.start[0])
    return found


def _guarded_references(tree: ast.AST) -> list[tuple[int, int]]:
    """``(line, col)`` of every load of a :data:`GUARDED` name, in source order."""
    hits: set[tuple[int, int]] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id in GUARDED:
                hits.add((node.lineno, node.col_offset))
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
            if node.attr in GUARDED:
                hits.add((node.lineno, node.col_offset))
        elif isinstance(node, ast.ImportFrom):
            # An alias hides the name from every later grep; refuse it outright.
            for alias in node.names:
                if alias.name in GUARDED and alias.asname and alias.asname != alias.name:
                    hits.add((node.lineno, node.col_offset))
        elif isinstance(node, ast.Call):
            # getattr(obj, "<GUARDED name>") reaches the reader with a constant name.
            if (
                isinstance(node.func, ast.Name)
                and node.func.id == "getattr"
                and len(node.args) >= 2
                and isinstance(node.args[1], ast.Constant)
                and node.args[1].value in GUARDED
            ):
                hits.add((node.lineno, node.col_offset))
        elif (
            # <obj>.__dict__["<GUARDED name>"] likewise.
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Attribute)
            and node.value.attr == "__dict__"
            and isinstance(node.slice, ast.Constant)
            and node.slice.value in GUARDED
        ):
            hits.add((node.lineno, node.col_offset))
    return sorted(hits)


def unacknowledged_references(source: str, filename: str = "<src>") -> list[str]:
    """Every guarded reference with no marker of its own.

    A marker acknowledges exactly ONE reference: the first one at or after it,
    within :data:`_WINDOW` lines. A second guarded reference under the same marker
    is reported, so a declared site cannot silently shelter a neighbour.
    """
    tree = ast.parse(source, filename=filename)
    unused = _markers(source)
    offenders: list[str] = []
    for lineno, _col in _guarded_references(tree):
        match = next((m for m in reversed(unused) if 0 <= lineno - m <= _WINDOW), None)
        if match is None:
            offenders.append(f"{filename}:{lineno}")
        else:
            unused.remove(match)
    return offenders


def test_every_ungated_velocity_reader_is_acknowledged() -> None:
    offenders: list[str] = []
    scanned = 0
    for path in sorted(SRC_ROOT.rglob("*.py")):
        if "migrations" in path.parts:
            continue
        scanned += 1
        offenders += unacknowledged_references(
            path.read_text(encoding="utf-8"), str(path.relative_to(SRC_ROOT))
        )
    assert scanned > 100, f"scanned only {scanned} files under {SRC_ROOT} — wrong root?"
    assert not offenders, (
        "These references read velocity values with no ADR-0104 gate applied. Use "
        "signal_privacy_services.velocity_summary_for(request, project_id) in a "
        f"response path, or declare the site with '# {MARKER} <reason>':\n  "
        + "\n  ".join(offenders)
    )


def test_guard_rejects_an_undeclared_sink() -> None:
    """Negative control: the scanner must flag the shape every past leak had."""
    src = (
        "from trueppm_api.apps.projects.services import velocity_summary_unfiltered\n"
        "def get(request, pk):\n"
        "    return velocity_summary_unfiltered(pk)\n"
    )
    assert unacknowledged_references(src) == ["<src>:3"]


def test_guard_rejects_a_derived_sink_and_an_alias() -> None:
    src = (
        "from x import project_forecast as pf\n"
        "def get(pk):\n"
        "    return services.project_forecast(pk)['velocity']\n"
    )
    assert unacknowledged_references(src) == ["<src>:1", "<src>:3"]


def test_guard_accepts_a_declared_site_and_rejects_an_empty_reason_or_far_marker() -> None:
    declared = "# velocity-unfiltered-ok: snapshot write\nvelocity_summary_unfiltered(pk)\n"
    assert unacknowledged_references(declared) == []
    empty = "# velocity-unfiltered-ok:\nvelocity_summary_unfiltered(pk)\n"
    assert unacknowledged_references(empty) == ["<src>:2"]
    far = "# velocity-unfiltered-ok: x\n" + "pass\n" * _WINDOW + "velocity_summary_unfiltered(pk)\n"
    assert unacknowledged_references(far) == [f"<src>:{_WINDOW + 2}"]


def test_marker_acknowledges_only_the_first_reference_after_it() -> None:
    """Negative control: a declared site must not shelter the unmarked calls below it."""
    src = (
        "# velocity-unfiltered-ok: snapshot write\n"
        "a = velocity_summary_unfiltered(pk)\n"
        "b = velocity_summary_unfiltered(pk)\n"
        "c = project_forecast(pk)\n"
        "d = sprint_forecast(pk)\n"
    )
    assert unacknowledged_references(src) == ["<src>:3", "<src>:4", "<src>:5"]


def test_each_marker_pays_for_one_reference() -> None:
    src = (
        "# velocity-unfiltered-ok: one\n"
        "# velocity-unfiltered-ok: two\n"
        "a = project_forecast(pk)\n"
        "b = sprint_forecast(pk)\n"
        "c = reforecast_preview(pk)\n"
    )
    assert unacknowledged_references(src) == ["<src>:5"]


def test_guard_flags_getattr_and_dunder_dict_with_a_constant_name() -> None:
    src = (
        "a = getattr(services, 'velocity_summary_unfiltered')\n"
        "b = services.__dict__['project_forecast']\n"
        "c = getattr(services, name)\n"
    )
    assert unacknowledged_references(src) == ["<src>:1", "<src>:2"]
    declared = "# velocity-unfiltered-ok: x\nv = getattr(s, 'capacity_hint')\n"
    assert unacknowledged_references(declared) == []


def test_marker_text_inside_a_string_is_not_a_declaration() -> None:
    src = (
        "NOTE = '# velocity-unfiltered-ok: pretend'\n"
        '"""# velocity-unfiltered-ok: also pretend"""\n'
        "velocity_summary_unfiltered(pk)\n"
    )
    assert unacknowledged_references(src) == ["<src>:3"]


def test_old_ungated_name_is_gone() -> None:
    """An old-habit ``from services import velocity_summary`` must fail loudly."""
    assert not hasattr(services, "velocity_summary")
    assert not hasattr(services, "velocity_bands_for_projects")


@pytest.mark.django_db
def test_velocity_summary_for_applies_the_gate() -> None:
    """Member (TEAM band) reads the series; PM (ADMIN) is suppressed at the default."""
    user_model = get_user_model()
    project = Project.objects.create(name="P", start_date=date(2026, 1, 1))
    base = date(2026, 1, 6)
    for i in range(2):
        Sprint.objects.create(
            project=project,
            name=f"S{i}",
            start_date=base + timedelta(days=14 * i),
            finish_date=base + timedelta(days=14 * i + 10),
            state=SprintState.COMPLETED,
            completed_points=20 + i,
            completed_task_count=5,
            closed_at=timezone.now() - timedelta(days=14 * (2 - i)),
        )

    def _request(username: str, role: int) -> Any:
        user = user_model.objects.create_user(username=username, password="pw")
        ProjectMembership.objects.create(project=project, user=user, role=role)
        req = Request(APIRequestFactory().get("/"))
        req.user = user
        return req

    member = velocity_summary_for(_request("dev", Role.MEMBER), project.pk)
    assert len(member["sprints"]) == 2
    assert "velocity_suppressed" not in member

    pm = velocity_summary_for(_request("pm", Role.ADMIN), project.pk)
    assert pm["velocity_suppressed"] is True
    assert pm["sprints"] == []
    assert pm["forecast_range_low"] is None
