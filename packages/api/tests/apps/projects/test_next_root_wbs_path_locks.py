"""``_next_root_wbs_path`` reads the root level under a real lock (#3071).

Its docstring has always claimed the number is "counted under the same lock as the
INSERT". Postgres refuses ``FOR UPDATE`` alongside an aggregate, so the previous
``.count()`` form could not have carried one — the concurrency claim in the docstring
was not a property the query had. Reading the labels back instead is what makes it true,
and that is a side effect of the #3071 fix worth pinning rather than leaving to a
comment.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.db import connection, reset_queries, transaction
from django.test import override_settings

from trueppm_api.apps.projects.models import Calendar, Project, Task
from trueppm_api.apps.projects.views import _next_root_wbs_path

pytestmark = pytest.mark.django_db


@override_settings(DEBUG=True)
def test_the_root_scan_actually_carries_for_update() -> None:
    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Lock", start_date=date(2026, 1, 1), calendar=calendar)
    Task.objects.create(project=project, name="One", duration=1, wbs_path="1")

    with transaction.atomic():
        reset_queries()
        assert _next_root_wbs_path(project) == "2"
        statements = [q["sql"] for q in connection.queries]

    assert statements, "the helper issued no query at all"
    assert any("FOR UPDATE" in sql for sql in statements), (
        f"the root scan must lock the level it is about to number past — got: {statements}"
    )
