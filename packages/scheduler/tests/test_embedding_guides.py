"""The website's Django and FastAPI embedding guides, executed as written (#4725).

Both pages are copy-paste starting points for embedders. This test pulls the fenced
Python out of the Markdown and runs it against the real ``trueppm_scheduler`` API,
so a renamed parameter, a dropped progress input, or a missing error mapping fails
here instead of in a reader's project. Django, Celery, FastAPI and Pydantic are not
test dependencies, so each is replaced by a minimal stand-in; only the snippet
logic that talks to the scheduler runs for real.
"""

from __future__ import annotations

import asyncio
import re
import sys
import types
from contextlib import nullcontext
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import trueppm_scheduler as ts

_DOCS = Path(__file__).resolve().parents[2] / "website/src/content/docs/embedding"


def _python_blocks(page: str) -> list[str]:
    text = (_DOCS / page).read_text()
    blocks = re.findall(r"```python\n(.*?)```", text, flags=re.DOTALL)
    assert blocks, f"no python blocks found in {page}"
    return blocks


def _block_containing(page: str, marker: str) -> str:
    matches = [b for b in _python_blocks(page) if marker in b]
    assert len(matches) == 1, f"{page}: expected one block with {marker!r}"
    return matches[0]


# --------------------------------------------------------------------------- Django


class _Manager:
    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows
        self.updated: list[Any] = []

    def all(self) -> list[Any]:
        return list(self._rows)

    def select_related(self, *_a: str) -> list[Any]:
        return list(self._rows)

    def bulk_update(self, objs: list[Any], fields: list[str]) -> None:
        self.updated = list(objs)
        self.fields = fields


def _django_namespace(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    db = types.ModuleType("django.db")
    db.transaction = SimpleNamespace(atomic=nullcontext)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "django", types.ModuleType("django"))
    monkeypatch.setitem(sys.modules, "django.db", db)
    code = _block_containing("django.md", "def build_scheduler_project")
    # The guide's models live in the reader's app; swap that one import.
    code = code.replace("from .models import Project, Task", "Project = Task = object")
    ns: dict[str, Any] = {}
    exec(compile(code, "django.md", "exec"), ns)
    ns["Task"] = SimpleNamespace(objects=_Manager([]))
    return ns


def _db_task(pk: str, name: str, **kw: Any) -> SimpleNamespace:
    base: dict[str, Any] = {
        "pk": pk,
        "id": pk,
        "name": name,
        "duration": timedelta(days=5),
        "optimistic_duration": None,
        "most_likely_duration": None,
        "pessimistic_duration": None,
        "percent_complete": 0.0,
        "actual_start": None,
        "actual_finish": None,
        "planned_start": None,
        "calendar_id": None,
        "calendar": None,
        "delivery_mode": None,
        "story_points": None,
        "early_finish": None,
        "milestone_at_day_end": False,
    }
    base.update(kw)
    return SimpleNamespace(**base)


def _db_calendar(working_days: int = 0b0011111) -> SimpleNamespace:
    return SimpleNamespace(
        working_days=working_days,
        hours_per_day=8.0,
        timezone="UTC",
        exceptions=_Manager([]),
    )


def test_django_guide_passes_progress_inputs_and_persists_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ns = _django_namespace(monkeypatch)
    seven_day = _db_calendar(0b1111111)
    tasks = [
        _db_task(
            "done",
            "Done",
            actual_start=date(2026, 1, 5),
            actual_finish=date(2026, 1, 9),
            percent_complete=100.0,
        ),
        _db_task("wip", "In progress", percent_complete=40.0, actual_start=date(2026, 1, 12)),
        _db_task("snet", "Not before", planned_start=date(2026, 3, 2)),
        _db_task("cal", "Own calendar", calendar_id="seven", calendar=seven_day),
        _db_task("ms", "Milestone", duration=timedelta(0)),
    ]
    project = SimpleNamespace(
        pk="p1",
        id="p1",
        name="P",
        start_date=date(2026, 1, 5),
        calendar=_db_calendar(),
        tasks=_Manager(tasks),
        dependencies=_Manager(
            [
                SimpleNamespace(
                    predecessor_id="wip", successor_id="ms", dep_type="FS", lag=timedelta(0)
                ),
            ]
        ),
        status_date=date(2026, 1, 14),
        velocity_samples=None,
        sprint_length_days=None,
        project_finish=None,
        save=lambda update_fields: None,
    )

    sp = ns["build_scheduler_project"](project)

    by_id = {t.id: t for t in sp.tasks}
    assert by_id["done"].actual_finish == date(2026, 1, 9)
    assert by_id["wip"].percent_complete == 40.0
    assert by_id["snet"].planned_start == date(2026, 3, 2)
    assert by_id["cal"].calendar_id == "seven"
    assert sp.calendars is not None and "seven" in sp.calendars
    assert sp.status_date == date(2026, 1, 14)

    result = ts.schedule(sp)
    rt = {t.id: t for t in result.tasks}
    snet_start = rt["snet"].early_start
    assert snet_start is not None and snet_start >= date(2026, 3, 2)  # SNET honored
    assert rt["done"].early_finish == date(2026, 1, 9)  # pinned to the actual

    ns["apply_schedule_result"](project, result)
    fields = ns["Task"].objects.fields
    for name in ("scheduled_start", "free_float", "milestone_at_day_end"):
        assert name in fields
        assert all(hasattr(t, name) for t in ns["Task"].objects.updated)
    assert project.project_finish == result.project_finish


def test_django_guide_hands_back_milestone_edge(monkeypatch: pytest.MonkeyPatch) -> None:
    ns = _django_namespace(monkeypatch)
    ms = _db_task(
        "ms", "M", duration=timedelta(0), early_finish=date(2026, 1, 9), milestone_at_day_end=True
    )
    project = SimpleNamespace(
        pk="p",
        name="P",
        start_date=date(2026, 1, 5),
        calendar=_db_calendar(),
        tasks=_Manager([ms]),
        dependencies=_Manager([]),
        status_date=None,
        velocity_samples=None,
        sprint_length_days=None,
    )
    sp = ns["build_scheduler_project"](project)
    assert sp.tasks[0].live_day_end_on == date(2026, 1, 9)
    assert sp.status_date is not None  # null status date resolved to today


# -------------------------------------------------------------------------- FastAPI


class _BaseModel:
    """Pydantic stand-in: class-level defaults, keyword init, no validation."""

    def __init__(self, **kw: Any) -> None:
        for name in getattr(type(self), "__annotations__", {}):
            if name in kw:
                setattr(self, name, kw.pop(name))
        for klass in type(self).__mro__:
            for name in getattr(klass, "__annotations__", {}):
                if not hasattr(self, name) and hasattr(klass, name):
                    setattr(self, name, getattr(klass, name))
        for k, v in kw.items():
            setattr(self, k, v)


class _FieldDefault:
    def __init__(self, default: Any = None, **kw: Any) -> None:
        self.default, self.constraints = default, kw


def _fastapi_namespace(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    handlers: dict[type, Any] = {}

    class _App:
        def __init__(self, **_k: Any) -> None:
            self.handlers = handlers

        def post(self, *_a: Any, **_k: Any) -> Any:
            return lambda fn: fn

        def exception_handler(self, exc_type: type) -> Any:
            def deco(fn: Any) -> Any:
                handlers[exc_type] = fn
                return fn

            return deco

    class _JSONResponse:
        def __init__(self, status_code: int, content: Any) -> None:
            self.status_code, self.content = status_code, content

    def _field(default: Any = None, **kw: Any) -> Any:
        return _FieldDefault(default, **kw).default

    fa = types.ModuleType("fastapi")
    fa.FastAPI = _App  # type: ignore[attr-defined]
    resp = types.ModuleType("fastapi.responses")
    resp.JSONResponse = _JSONResponse  # type: ignore[attr-defined]
    pyd = types.ModuleType("pydantic")
    pyd.BaseModel = _BaseModel  # type: ignore[attr-defined]
    pyd.Field = _field  # type: ignore[attr-defined]
    for name, mod in (("fastapi", fa), ("fastapi.responses", resp), ("pydantic", pyd)):
        monkeypatch.setitem(sys.modules, name, mod)

    page = "fastapi.md"
    ns: dict[str, Any] = {}
    # Sections 1, 3 and 4 compose into one app; section 2 restates a fragment.
    for marker in ("def _run_offthread", "class MCRequest", "scheduler_error_handler"):
        exec(compile(_block_containing(page, marker), page, "exec"), ns)
    ns["_handlers"] = handlers
    return ns


def _req(ns: dict[str, Any], tasks: int = 2, **kw: Any) -> Any:
    return ns["MCRequest"](
        project_id="p",
        start_date=date(2026, 1, 5),
        tasks=[ns["TaskIn"](id=f"t{i}", name=f"T{i}", duration_days=3) for i in range(tasks)],
        dependencies=kw.pop("dependencies", []),
        **kw,
    )


def test_fastapi_guide_runs_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    ns = _fastapi_namespace(monkeypatch)
    req = _req(
        ns,
        runs=50,
        dependencies=[
            ns["DependencyIn"](predecessor_id="t0", successor_id="t1"),
        ],
    )
    sched = asyncio.run(ns["schedule_project"](req))
    assert sched.project_finish >= date(2026, 1, 5)
    mc = asyncio.run(ns["run_monte_carlo"](req))
    assert mc.runs == 50


def test_fastapi_guide_monte_carlo_passes_caps(monkeypatch: pytest.MonkeyPatch) -> None:
    ns = _fastapi_namespace(monkeypatch)
    # A caller who slips past the request model still hits the engine's own caps.
    with pytest.raises(ts.SimulationCapExceeded):
        asyncio.run(ns["run_monte_carlo"](_req(ns, runs=ns["MAX_RUNS"] + 1)))
    with pytest.raises(ts.SimulationCapExceeded):
        asyncio.run(ns["run_monte_carlo"](_req(ns, tasks=ns["MAX_TASKS"] + 1, runs=1)))


def test_fastapi_guide_maps_scheduler_errors_to_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ns = _fastapi_namespace(monkeypatch)
    handler = ns["_handlers"][ts.SchedulerError]

    cyc = _req(
        ns,
        dependencies=[
            ns["DependencyIn"](predecessor_id="t0", successor_id="t1"),
            ns["DependencyIn"](predecessor_id="t1", successor_id="t0"),
        ],
    )
    with pytest.raises(ts.CyclicDependencyError) as caught:
        asyncio.run(ns["schedule_project"](cyc))
    out = asyncio.run(handler(None, caught.value))
    assert out.status_code == 422
    assert out.content["detail"]["error"] == "cyclic_dependency"

    capped = ts.SimulationCapExceeded("too many runs")
    out = asyncio.run(handler(None, capped))
    assert out.status_code == 422 and "too many runs" in out.content["detail"]["message"]


def test_fastapi_guide_timeout_returns_504(monkeypatch: pytest.MonkeyPatch) -> None:
    ns = _fastapi_namespace(monkeypatch)
    ns["REQUEST_TIMEOUT_SECONDS"] = 0.01
    import time

    with pytest.raises(TimeoutError):
        asyncio.run(ns["_run_offthread"](lambda: time.sleep(0.3)))
    out = asyncio.run(ns["_handlers"][TimeoutError](None, TimeoutError()))
    assert out.status_code == 504
