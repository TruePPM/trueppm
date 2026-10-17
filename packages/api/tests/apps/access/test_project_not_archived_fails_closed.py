"""``IsProjectNotArchived.has_object_permission`` fails CLOSED on unresolvable scope (#3587).

Split out of #3570, which fixed one instance (``TaskSkillRequirement``) and
deliberately did not touch the class itself. Eleven of the thirteen callers of
``_get_project_id_from_obj`` already fail closed (``return False``) when it cannot
resolve a project; ``IsProjectMember`` is the one documented exception (an org-level
``Calendar`` object, where authentication alone is sufficient — see its own
docstring). ``IsProjectNotArchived`` used to be the *undocumented* second exception:
``return True`` on an unresolvable object, which is the shape #2745/#3414/#3570 kept
recurring in, because declaring the permission class reads as a fix in review while
this branch quietly waved every unresolvable object through.

No database is touched: every assertion here is a plain object graph, not a model row
— the one case that does need a real ``Project`` row still never queries, because
``has_object_permission`` reads the in-memory ``is_archived`` flag directly for a
``Project`` instance rather than re-fetching it.

The route-table invariant in ``test_route_table_invariants.py``
(``test_residual_object_hop_resolves_or_never_fires`` and its siblings) proves this
flip does not 403 any of the ~88 real routes where the class is effective and the
view carries no class-level ``queryset``. This file proves the unit the flip changed.
"""

from __future__ import annotations

from datetime import date
from typing import Any

import pytest
from rest_framework.request import Request
from rest_framework.test import APIRequestFactory
from rest_framework.views import APIView

from trueppm_api.apps.access.permissions import IsProjectNotArchived


class _Opaque:
    """No ``project_id``, ``project``, or ``predecessor_id`` attribute at all.

    The exact shape ``_get_project_id_from_obj`` cannot resolve — not a nullable FK
    (which the resolver would still see via ``hasattr``), genuinely nothing to walk.
    """


def _request(method: str = "POST") -> Request:
    return Request(APIRequestFactory().generic(method, "/"))


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_unsafe_methods_fail_closed_on_an_unresolvable_object(method: str) -> None:
    """The fix: an unsafe write against an object with no project hop is now refused.

    Before #3587 this returned ``True`` — the permission layer could not tell what
    project the write touched and permitted it anyway, the one fail-open survivor of
    the shape #2745/#3414/#3570 closed on its eleven siblings.
    """
    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request(method), view, _Opaque()) is False


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_still_pass_regardless_of_resolution(method: str) -> None:
    """Reads are unaffected — the SAFE_METHODS branch returns True before resolution
    is ever attempted, exactly as it did before this fix."""
    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request(method), view, _Opaque()) is True


def test_the_project_lifecycle_bypass_actions_still_pass_regardless() -> None:
    """``unarchive``/``destroy``/``archive``/``restore`` on ``ProjectViewSet`` itself
    bypass before project-id resolution is ever reached — unaffected by this fix,
    and still the escape hatch that lets an Owner unarchive a project at all."""
    from trueppm_api.apps.projects.views import ProjectViewSet

    view = ProjectViewSet()
    view.action = "unarchive"
    assert IsProjectNotArchived().has_object_permission(_request("POST"), view, _Opaque()) is True


@pytest.mark.django_db
def test_a_resolvable_live_project_object_still_permits_a_write() -> None:
    """The common, correct path is unchanged: a resolvable, non-archived project
    still permits the write — this fix only changes the *unresolvable* branch."""
    from trueppm_api.apps.projects.models import Calendar, Project

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Live", start_date=date(2026, 3, 1), calendar=calendar)
    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request("POST"), view, project) is True


@pytest.mark.django_db
def test_a_resolvable_archived_project_object_still_refuses() -> None:
    """Likewise, the archived-and-resolvable path is unchanged by this fix."""
    from trueppm_api.apps.projects.models import Calendar, Project

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(
        name="Archived", start_date=date(2026, 3, 1), calendar=calendar, is_archived=True
    )
    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request("POST"), view, project) is False


@pytest.mark.parametrize(
    ("model_path", "build"),
    [
        (
            "trueppm_api.apps.projects.models.TaskAttachment",
            lambda m, task: m(task=task),
        ),
        (
            "trueppm_api.apps.projects.models.TaskComment",
            lambda m, task: m(task=task),
        ),
        (
            "trueppm_api.apps.projects.models.TaskNote",
            lambda m, task: m(task=task),
        ),
        (
            "trueppm_api.apps.integrations.models.TaskLink",
            lambda m, task: m(task=task),
        ),
    ],
)
@pytest.mark.django_db
def test_task_scoped_models_with_a_project_id_property_still_resolve(
    model_path: str, build: Any
) -> None:
    """The established remedy (#3414) for a task-scoped model the resolver cannot
    otherwise walk is a ``project_id`` property, not a resolver widening.

    Every model here is one of the residual routes audited for #3587
    (``test_route_table_invariants.test_residual_object_hop_resolves_or_never_fires``'s
    ``comment``/``task`` expressions resolve to the PARENT task directly, but these
    properties are what makes the model resolve in its own right if a future route
    ever hands the row itself to ``has_object_permission``). A regression here —
    someone deleting the property rather than widening the shared resolver — would
    silently flip this model's writes from enforced back to the #3587 fail-open gap,
    now expressed as a hard 403 instead, on an object that should have resolved.
    """
    import importlib

    module_path, _, name = model_path.rpartition(".")
    model = getattr(importlib.import_module(module_path), name)

    from trueppm_api.apps.projects.models import Calendar, Project, Task

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Live", start_date=date(2026, 3, 1), calendar=calendar)
    task = Task.objects.create(project=project, name="T", duration=1)
    instance = build(model, task)

    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request("POST"), view, instance) is True


@pytest.mark.django_db
def test_comment_reaction_project_id_property_still_resolves() -> None:
    """``CommentReaction`` is the same #3414 shape, one hop further: it has no
    ``task``, only a ``comment`` — ``CommentReaction.project_id`` walks
    ``comment.task.project_id``. Pinned here, not in the parametrize list above,
    because building one needs a ``TaskComment`` first rather than a bare ``task``.

    This is one of the ``_GET_OBJECT_AUDITED_CLASSES`` entries in
    ``test_route_table_invariants.py`` (``CommentReactionViewSet.destroy`` has no
    ``get_object`` override, so DRF's own default is what actually calls
    ``has_object_permission`` with the row itself) — this test is the proof that
    the model it is audited against really does resolve.
    """
    from trueppm_api.apps.projects.models import (
        Calendar,
        CommentReaction,
        Project,
        Task,
        TaskComment,
    )

    calendar = Calendar.objects.create(name="Standard")
    project = Project.objects.create(name="Live", start_date=date(2026, 3, 1), calendar=calendar)
    task = Task.objects.create(project=project, name="T", duration=1)
    comment = TaskComment(task=task)
    reaction = CommentReaction(comment=comment)

    view = APIView()
    assert IsProjectNotArchived().has_object_permission(_request("POST"), view, reaction) is True
