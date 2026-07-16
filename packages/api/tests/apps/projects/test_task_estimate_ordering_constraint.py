"""DB-level guard: a mis-ordered three-point estimate can never be persisted (#2005).

Complements #2002's code-path guards (serializer, velocity accept, MS Project import)
with the airtight backstop: a Postgres CheckConstraint so NO write path — a raw
``bulk_create``, the seed importer, the admin, or a shell — can store a task whose
complete triple violates ``optimistic <= most_likely <= pessimistic`` and then
detonate the next CPM / program-schedule recompute.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.db import IntegrityError, transaction

from trueppm_api.apps.projects.models import Calendar, Project, Task

START = date(2026, 3, 2)


@pytest.fixture
def project(db: object) -> Project:
    cal = Calendar.objects.create(name="Standard")
    return Project.objects.create(name="Core", start_date=START, calendar=cal)


@pytest.mark.django_db
def test_ordered_triple_is_accepted(project: Project) -> None:
    task = Task.objects.create(
        project=project,
        name="Build",
        duration=5,
        optimistic_duration=3,
        most_likely_duration=5,
        pessimistic_duration=8,
    )
    assert task.pk is not None


@pytest.mark.django_db
def test_equal_bounds_triple_is_accepted(project: Project) -> None:
    # opt == ml == pess is degenerate but ordered — allowed (matches the engine).
    task = Task.objects.create(
        project=project,
        name="Fixed",
        duration=2,
        optimistic_duration=2,
        most_likely_duration=2,
        pessimistic_duration=2,
    )
    assert task.pk is not None


@pytest.mark.django_db
@pytest.mark.parametrize(
    "opt,ml,pess",
    [
        (1, 5, 0),  # the "Something" shape: pessimistic below everything
        (9, 5, 3),  # descending
        (3, 2, 8),  # most_likely below optimistic
        (3, 9, 8),  # most_likely above pessimistic
    ],
)
def test_mis_ordered_triple_is_rejected(project: Project, opt: int, ml: int, pess: int) -> None:
    with pytest.raises(IntegrityError), transaction.atomic():
        Task.objects.create(
            project=project,
            name="Bad",
            duration=2,
            optimistic_duration=opt,
            most_likely_duration=ml,
            pessimistic_duration=pess,
        )


@pytest.mark.django_db
@pytest.mark.parametrize(
    "opt,ml,pess",
    [
        (None, None, None),  # no estimate
        (3, None, 8),  # partial — engine ignores under all-or-none
        (None, 5, None),
        (3, 5, None),
    ],
)
def test_partial_triple_is_unconstrained(project: Project, opt, ml, pess) -> None:
    task = Task.objects.create(
        project=project,
        name="Partial",
        duration=2,
        optimistic_duration=opt,
        most_likely_duration=ml,
        pessimistic_duration=pess,
    )
    assert task.pk is not None


@pytest.mark.django_db
def test_bulk_create_of_mis_ordered_triple_is_rejected(project: Project) -> None:
    # The exact bypass that let "Something" in: bulk_create skips serializer + save(),
    # but the DB constraint still holds.
    with pytest.raises(IntegrityError), transaction.atomic():
        Task.objects.bulk_create(
            [
                Task(
                    project=project,
                    name="BulkBad",
                    wbs_path="9",
                    short_id="00000099",
                    duration=2,
                    optimistic_duration=1,
                    most_likely_duration=5,
                    pessimistic_duration=0,
                )
            ]
        )
