"""ADR-1477 §7: every task-writing route is classified, or this test fails.

The ADR's second top risk is a structural write path that never records an
amendment, so a committed plan changes shape with no entry and no reason. The
mitigation is this enumeration: it walks the URL resolver, finds every route
whose view can write a ``Task`` row, and requires each to be named in exactly
one map below. A new route that writes tasks fails here until someone decides
which kind of write it is — and a STRUCTURAL route must call into ``amend``.

What makes a route a candidate is a static read of its view's source (a write
handler plus a reference to a task-writing symbol). It over-collects on
purpose: an UNRELATED entry is a recorded decision, a missing one is silence.
"""

from __future__ import annotations

import importlib
import inspect
import re
from typing import Any

from django.urls import URLPattern, URLResolver, get_resolver

_A = "trueppm_api.apps"

#: Adds, deletes, moves or undoes tasks in the plan's shape: must call ``amend``.
#: The value names where the call lives when it is not the handler itself.
STRUCTURAL: dict[str, str] = {
    "views.TaskViewSet.create": "",
    "views.TaskViewSet.destroy": "",
    "views.TaskViewSet.split": "",
    # Undelete: the undo of a delete, so it retracts that delete's entry.
    "views.TaskViewSet.restore": "",
    "views.TaskBulkView.post": "",
    "views.TaskIndentView.post": "",
    "views.TaskOutdentView.post": "",
    "views.TaskReorderView.post": "",
    "views.TaskReparentView.post": "",
    "views.TaskGroupView.post": f"{_A}.projects.views._TaskGroupingViewBase",
    "views.TaskUngroupView.post": f"{_A}.projects.views._TaskGroupingViewBase",
    "views.PhaseViewSet.create": "",
    "views.PhaseViewSet.destroy": "",
    "views.SprintViewSet.promote_action_item": "",
    "views.SprintViewSet.pull_action_item_to_sprint": "",
    "backlog_views.BacklogItemViewSet.pull": "",
    "views.ProjectSyncView.post": f"{_A}.sync.upload.apply_task_changes",
    "views.MsProjectImportView.post": f"{_A}.msproject.tasks.import_msproject",
    "batch_operation_views.PasteManyOperationViewSet.undo": (
        f"{_A}.projects.task_batch_services.undo_paste_many_operation"
    ),
    "template_views.TemplateApplicationViewSet.undo": (
        f"{_A}.projects.template_services.undo_template_application"
    ),
    "structural_operation_views.StructuralOperationViewSet.undo": (
        f"{_A}.projects.structural_operation_services.undo_structural_operation"
    ),
    # Structural by the ADR's rules but not yet recording; see PENDING.
    "views.TaskSyncView.post": "",
    "views.SprintViewSet.promote_to_milestone": "",
    "views.PhaseReorderView.patch": "",
    "template_views.ProjectTemplateViewSet.apply": "",
}

#: Structural routes classified but not yet recording an amendment. This set may
#: only shrink: an entry that starts calling ``amend`` fails until removed here.
PENDING: set[str] = {
    "views.TaskSyncView.post",  # inbound task push: an add
    "views.SprintViewSet.promote_to_milestone",  # creates the sprint's milestone task
    "template_views.ProjectTemplateViewSet.apply",  # async apply adds the template's rows
}

#: Writes task fields or ordering outside the plan's WBS shape.
NON_STRUCTURAL: dict[str, str] = {
    "views.TaskViewSet.reorder": "Kanban rank within a status column, not WBS order",
    "views.ProjectViewSet.product_backlog_reorder": "backlog rank, not WBS order",
    "views.ProjectViewSet.queue_reorder": "queue rank, not WBS order",
    "views.SprintViewSet.reorder": "sprint rank, not WBS order",
    "views.SprintViewSet.demo_list_reorder": "demo list order",
    "views.SprintViewSet.close": "sprint membership of existing tasks",
    "views.GitWebhookIngestView.post": "status from git events",
}

#: Names a task-writing symbol but does not write the tasks of a committed plan.
UNRELATED: dict[str, str] = {
    "baseline_decision_views.ChangesetEntryReasonView.patch": "the entry's reason, not a task",
    "views.CreateProjectFromMsProjectView.post": "a new project is a draft",
    "views.SprintTaskOutcomeViewSet.flag_for_backlog": "program BacklogItem, not a Task",
    "views.CommentReactionViewSet.create": "reactions",
    "views.ProjectMembershipViewSet.create": "membership",
    "views.ProjectResourceViewSet.destroy": "resource rows",
    "views.FailedTaskViewSet.drop": "Celery task records",
    "views.SsoProviderCollectionView.post": "SSO config",
    "views.ProjectViewSet.export": "read-only export",
    "program_views.ProgramViewSet.export": "read-only export",
}

_HTTP_WRITES = ("post", "put", "patch", "delete")
_PERFORM = {
    "create": "perform_create",
    "update": "perform_update",
    "partial_update": "perform_update",
    "destroy": "perform_destroy",
}
_TASK_WRITE = re.compile(
    r"amend\.|TaskSerializer\(|Task\.objects\.(create|bulk_create)\(|\bTask\(|bulk_create_tasks|"
    r"soft_delete_task|apply_task_changes|enqueue_import|paste_many|undo_paste_many|"
    r"apply_template|promote_retro_action_item|split_story|pull_to_project_backlog|"
    r"flag_outcome_for_backlog|promote_sprint_to_milestone|_create_milestone_for_sprint|"
    r"_spawn_occurrence|enqueue_template_apply|indent|outdent|reparent|reorder|group_tasks|ungroup|duplicate|"
    r"[Tt]emplate[Aa]pplication|apply_\w*template|[Ii]nbound[Tt]ask|ingest_\w*task|structural_operation"
)


def _walk(patterns: list[Any], prefix: str = "") -> list[tuple[str, Any]]:
    out: list[tuple[str, Any]] = []
    for p in patterns:
        if isinstance(p, URLResolver):
            out.extend(_walk(p.url_patterns, prefix + str(p.pattern)))
        elif isinstance(p, URLPattern):
            out.append((prefix + str(p.pattern), p.callback))
    return out


def _view_class(callback: Any) -> Any:
    return getattr(callback, "cls", None) or getattr(callback, "view_class", None)


def _method_source(cls: Any, name: str) -> str:
    fn = getattr(cls, name, None)
    if fn is None:
        return ""
    try:
        return inspect.getsource(fn) if fn.__module__.startswith("trueppm_api") else ""
    except (OSError, TypeError, AttributeError):
        return ""


def _class_source(cls: Any) -> str:
    out = []
    for klass in cls.__mro__:
        if klass.__module__.startswith("trueppm_api"):
            try:
                out.append(inspect.getsource(klass))
            except (OSError, TypeError):
                continue
    return "\n".join(out)


def _candidates() -> dict[str, str]:
    """``{"<module>.<View>.<handler>": handler source}`` for every task-writing route.

    One key per write handler, not per view: a viewset's ``indent`` and its
    ``partial_update`` are different kinds of write.
    """
    found: dict[str, str] = {}
    for _route, callback in _walk(get_resolver().url_patterns):
        cls = _view_class(callback)
        if cls is None or not cls.__module__.startswith("trueppm_api"):
            continue
        actions = getattr(callback, "actions", None)
        if actions:
            handlers = {a for m, a in actions.items() if m in _HTTP_WRITES}
        else:
            handlers = {m for m in _HTTP_WRITES if hasattr(cls, m)}
        for h in handlers:
            src = _method_source(cls, h) + _method_source(cls, _PERFORM.get(h, ""))
            # A plain APIView may delegate to a shared base's helper, so its
            # whole class counts; a viewset's other actions must not leak in.
            whole = "" if actions else _class_source(cls)
            if not _TASK_WRITE.search(src) and "amend." not in whole:
                continue
            module = cls.__module__.rsplit(".", 1)[-1]
            found[f"{module}.{cls.__name__}.{h}"] = src
    return found


def test_every_task_writing_route_is_classified() -> None:
    found = _candidates()
    maps = (STRUCTURAL, NON_STRUCTURAL, UNRELATED)
    classified = set().union(*maps)
    unclassified = sorted(set(found) - classified)
    assert not unclassified, (
        "task-writing routes not classified for ADR-1477 §7 (add each to STRUCTURAL, "
        f"NON_STRUCTURAL or UNRELATED): {unclassified}"
    )
    overlap = [k for k in classified if sum(k in m for m in maps) > 1]
    assert not overlap, f"classified twice: {overlap}"


def test_no_stale_classification() -> None:
    stale = sorted(set().union(STRUCTURAL, NON_STRUCTURAL, UNRELATED) - set(_candidates()))
    assert not stale, f"classified views no longer route a task write: {stale}"


def _recorder_source(key: str, found: dict[str, str]) -> str:
    target = STRUCTURAL[key]
    if not target:
        return found.get(key, "")
    module, name = target.rsplit(".", 1)
    return inspect.getsource(getattr(importlib.import_module(module), name))


def test_every_structural_route_records_an_amendment() -> None:
    found = _candidates()
    missing = sorted(
        k for k in STRUCTURAL if k not in PENDING and "amend." not in _recorder_source(k, found)
    )
    assert not missing, f"structural routes that never call amend: {missing}"


def test_pending_only_shrinks() -> None:
    found = _candidates()
    assert set(STRUCTURAL) >= PENDING
    now_recording = sorted(k for k in PENDING if "amend." in _recorder_source(k, found))
    assert not now_recording, f"remove from PENDING, they record now: {now_recording}"
