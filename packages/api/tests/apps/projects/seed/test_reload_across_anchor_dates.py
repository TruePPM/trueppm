"""A sample reloaded on a later day must import the same as a fresh one (#4339).

The bundled packs author relative dates (ADR-0114), so every reload resolves them
against a different anchor. Calendars are a shared catalog the program teardown
leaves standing, and the importer used to key their exceptions on the *resolved*
range — so the daily ``demo-reset`` CronJob added another "Clara — PTO" beside the
previous day's instead of matching it. The rows piled into a contiguous run of
non-working days, ``snap_forward`` carried a sprint's start and finish across it
onto the same day, and the ``sprint_finish_after_start`` CHECK aborted the import —
failing the Helm post-upgrade hook on an anchor no fresh-database test could hit.

The only full-Atlas import test pins one anchor on an empty database, which is why
none of this was visible: the failure needs *history*. The sweep below is that
history — consecutive daily reloads in one database, covering every weekday twice
and ending on 2026-10-09, the anchor that broke try.trueppm.com.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import IntegrityError

import trueppm_api.apps.projects.seed.importer as importer_module
from trueppm_api.apps.projects.models import Calendar, CalendarException, Sprint
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.reldates import resolve_date
from trueppm_api.apps.projects.seed.samples import SAMPLES, load_sample

pytestmark = pytest.mark.django_db

User = get_user_model()

# The anchor that failed the beta.6 -> beta.7 helm upgrade of try.trueppm.com.
_INCIDENT_ANCHOR = date(2026, 10, 9)
# The swept week: seven consecutive daily reloads ending on the incident anchor, so
# every weekday is an anchor once.
_SWEEP = [_INCIDENT_ANCHOR - timedelta(days=n) for n in range(6, -1, -1)]
# Three weeks of daily resets before the sweep. On the unfixed importer this is the
# history that builds the stale-exception wall the incident sprint collapsed across
# (GTM's ``A-1..A+2`` PTO, re-added each day, tiles Sept 12 .. Oct 4 solid).
_HISTORY = [_SWEEP[0] - timedelta(days=n) for n in range(21, 0, -1)]


def _pin_today(monkeypatch: pytest.MonkeyPatch, today: date) -> None:
    """Freeze the importer's ``date.today()`` — the ADR-0114 anchor source.

    Same technique as ``test_atlas_full_model_coverage._pin_today``: importer.py
    calls stdlib ``date.today()`` against its module-level ``date`` name.
    """

    class _FrozenDate(date):
        @classmethod
        def today(cls) -> _FrozenDate:
            return cls(today.year, today.month, today.day)

    monkeypatch.setattr(importer_module, "date", _FrozenDate)


def _authored_exceptions(sample_key: str, anchor: date) -> dict[str, set[tuple[date, date]]]:
    """Each sample calendar's exceptions as the pack authors them at ``anchor``."""
    import json

    payload = json.loads(SAMPLES[sample_key].path.read_text())
    return {
        cal["name"]: {
            (
                resolve_date(e["exc_start"], anchor=anchor, snap=False),
                resolve_date(e["exc_end"], anchor=anchor, snap=False),
            )
            for e in cal.get("exceptions", [])
        }
        for cal in payload.get("calendars", [])
    }


def _stored_exceptions(calendar_name: str) -> set[tuple[date, date]]:
    cal = Calendar.objects.get(name=calendar_name)
    return {(e.exc_start, e.exc_end) for e in cal.exceptions.all()}


def _assert_sprints_ordered(anchor: date) -> None:
    collapsed = [
        (s.name, s.start_date, s.finish_date)
        for s in Sprint.objects.all()
        if s.finish_date <= s.start_date
    ]
    assert not collapsed, f"anchor {anchor}: sprints with finish <= start: {collapsed}"


def _replay_calendar_phase(sample_key: str, anchor: date, owner: Any) -> None:
    """What an earlier day's reload leaves behind, without paying for the reload.

    The sample teardown deletes the program and everything dated under it; the
    shared calendars (and their exceptions) are the only dated state that survives
    into the next day's import. So the history a daily ``demo-reset`` accumulates is
    exactly the calendar phase, run once per past anchor — the same
    ``_resolve_calendars`` the full import runs first. A full reload costs ~3 s;
    this is what makes three weeks of history affordable in one test.
    """
    import json

    payload = json.loads(SAMPLES[sample_key].path.read_text())
    importer_module._SeedImporter(payload, owner=owner, create_users=False)._resolve_calendars()


def test_daily_demo_reset_never_collapses_a_sprint(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Helm ``demo-seed`` / ``demo-reset`` command, after weeks of daily resets.

    Drives ``load_sample_project`` end to end (the exact command both Helm templates
    run) for each swept anchor, so the sample-load wrapper is in the path too.
    After every reload the calendars must hold exactly what the pack authors at
    *that* anchor — the root invariant — and every sprint must still be ordered,
    which is the CHECK the accumulated rows used to trip.
    """
    root = User.objects.create_superuser("demo-root", "root@example.com", "pw")
    sample = "atlas-platform-launch"
    for anchor in _HISTORY:
        _pin_today(monkeypatch, anchor)
        _replay_calendar_phase(sample, anchor, root)
    # Collected rather than asserted inline, so a failure names *every* anchor that
    # broke — including whether the incident anchor itself is among them — instead
    # of stopping at the first drifted calendar.
    failures: list[str] = []
    for anchor in _SWEEP:
        _pin_today(monkeypatch, anchor)
        try:
            call_command("load_sample_project")
        except IntegrityError as exc:
            failures.append(f"{anchor}: import aborted: {str(exc).splitlines()[0]}")
            continue
        for name, authored in _authored_exceptions(sample, anchor).items():
            if _stored_exceptions(name) != authored:
                failures.append(f"{anchor}: {name!r} carries exceptions from older anchors")
        failures.extend(
            f"{anchor}: sprint {s.name!r} {s.start_date}..{s.finish_date}"
            for s in Sprint.objects.all()
            if s.finish_date <= s.start_date
        )
    assert not failures, "\n".join(failures)

    # The reload history must leave the incident anchor's sprints exactly where a
    # fresh database puts them: the reporter's standalone resolution of the GTM
    # sprint (2026-09-21 .. 2026-10-02) is the fresh-import answer.
    enablement = Sprint.objects.get(name="Enablement 1")
    assert (enablement.start_date, enablement.finish_date) == (
        date(2026, 9, 21),
        date(2026, 10, 2),
    )


@pytest.mark.parametrize("sample_key", sorted(k for k in SAMPLES if k != "atlas-platform-launch"))
def test_every_other_sample_reload_replaces_its_stale_exceptions(
    monkeypatch: pytest.MonkeyPatch, sample_key: str
) -> None:
    """Every bundled pack goes through the same ``_resolve_calendar_exceptions``.

    Two reloads a week apart are enough to tell "matched the old row" from
    "added a second one"; the daily sweep above covers the sprint consequence.
    """
    owner = User.objects.create_user(username=f"owner-{sample_key}", email="o@example.com")
    for anchor in (_INCIDENT_ANCHOR - timedelta(days=7), _INCIDENT_ANCHOR):
        _pin_today(monkeypatch, anchor)
        load_sample(sample_key, owner=owner, create_users=True)
        for name, authored in _authored_exceptions(sample_key, anchor).items():
            assert _stored_exceptions(name) == authored, (
                f"{sample_key} @ {anchor}: calendar {name!r} kept a stale exception"
            )
        _assert_sprints_ordered(anchor)


# --- unit-level: the two mechanisms, on a minimal pack -----------------------------


def _seed(
    *, anchor: str, exceptions: list[dict[str, str]], sprint: tuple[str, str]
) -> dict[str, Any]:
    return {
        "schema_version": "2.0",
        "anchor": anchor,
        "program": {"slug": "drift", "name": "Drift", "methodology": "AGILE", "lead": "alex"},
        "accounts": [
            {"slug": "alex", "username": "drift-alex", "display_name": "Alex", "role": "OWNER"}
        ],
        "calendars": [
            {
                "slug": "std",
                "name": "Drift 5-day",
                "working_days": 31,
                "exceptions": exceptions,
            }
        ],
        "projects": [
            {
                "slug": "core",
                "name": "Core",
                "methodology": "AGILE",
                "start_date": "A-30",
                "calendar": "std",
                "sprints": [
                    {
                        "slug": "s1",
                        "name": "Sprint 1",
                        "state": "PLANNED",
                        "start_date": sprint[0],
                        "finish_date": sprint[1],
                    }
                ],
                "tasks": [],
            }
        ],
    }


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="drift-owner", email="d@example.com")


def test_reload_replaces_only_the_seed_owned_stale_exception(owner: Any) -> None:
    """A later anchor moves the authored row; rows the seed does not own survive.

    The calendar is matched by name, so a user's own calendar can be the one the
    seed lands on. Their rows are not the seed's to delete — neither one with an
    unrelated description, nor one that shares the seed's description but not its
    span (an anchor shift moves a range, it never resizes it).
    """
    pto = [{"exc_start": "A-1", "exc_end": "A+2", "description": "Clara — PTO"}]
    import_seed(
        _seed(anchor="2026-10-01", exceptions=pto, sprint=("A+5", "A+19")),
        owner=owner,
        create_users=True,
    )
    cal = Calendar.objects.get(name="Drift 5-day")
    theirs_unrelated = CalendarException.objects.create(
        calendar=cal, exc_start=date(2026, 12, 25), exc_end=date(2026, 12, 25), description="Xmas"
    )
    theirs_same_desc = CalendarException.objects.create(
        calendar=cal,
        exc_start=date(2026, 11, 2),
        exc_end=date(2026, 11, 13),
        description="Clara — PTO",
    )

    import_seed(
        _seed(anchor="2026-10-09", exceptions=pto, sprint=("A+5", "A+19")),
        owner=owner,
        create_users=True,
        replace=True,
    )

    seed_rows = {
        (e.exc_start, e.exc_end)
        for e in cal.exceptions.exclude(pk__in=[theirs_unrelated.pk, theirs_same_desc.pk])
    }
    assert seed_rows == {(date(2026, 10, 8), date(2026, 10, 11))}
    assert CalendarException.objects.filter(pk=theirs_unrelated.pk).exists()
    assert CalendarException.objects.filter(pk=theirs_same_desc.pk).exists()


def test_sprint_swallowed_by_non_working_days_keeps_one_working_day(owner: Any) -> None:
    """Snapping can collapse an authored start < finish; the importer must not abort.

    Anchor 2026-10-09 is a Friday. The sprint runs A+1 (Sat) .. A+4 (Tue) and a
    holiday covers Mon-Tue, so both ends snap to Wednesday 10-14. The finish moves
    to the next working day after the snapped start instead of tripping the CHECK.
    """
    holiday = [{"exc_start": "A+3", "exc_end": "A+4", "description": "Holiday"}]
    import_seed(
        _seed(anchor="2026-10-09", exceptions=holiday, sprint=("A+1", "A+4")),
        owner=owner,
        create_users=True,
    )
    sprint = Sprint.objects.get(name="Sprint 1")
    assert (sprint.start_date, sprint.finish_date) == (date(2026, 10, 14), date(2026, 10, 15))


def test_sprint_authored_inverted_still_fails_loudly(owner: Any) -> None:
    """The repair is for a collapse the snap caused, never for an authoring error."""
    with pytest.raises(IntegrityError, match="sprint_finish_after_start"):
        import_seed(
            _seed(anchor="2026-10-09", exceptions=[], sprint=("A+5", "A+5")),
            owner=owner,
            create_users=True,
        )
    assert not Sprint.objects.filter(name="Sprint 1").exists()
