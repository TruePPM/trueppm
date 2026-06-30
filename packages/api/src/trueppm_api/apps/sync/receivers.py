"""Maintain ``Project.last_sync_version`` from synced-row saves (ADR-0142, #822).

The sync pull watermark (the response ``timestamp``) is ``MAX(server_version)``
over a project's synced rows. Computing it per pull was a 13-table ``UNION ALL``
(``ProjectSyncView._snapshot_max_version``); instead it is cached on
``Project.last_sync_version`` and kept current here by a ``post_save`` receiver on
each of the **exactly thirteen** models that union reads.

Each receiver bumps the owning project(s):

    Project.objects.filter(pk__in=<owner ids>).update(
        last_sync_version=Greatest(F("last_sync_version"), Value(instance.server_version))
    )

``Greatest``/``F`` make it atomic under concurrent writes (the project row lock
serializes them) and it runs inside the same transaction as the triggering save,
so a rollback rolls the watermark back too. The watermark is therefore monotonic:
a hard delete of the current-max row leaves it unchanged (safe — a too-high
watermark only makes a client re-pull; the sync protocol soft-deletes anyway).

**The model set here must mirror ``_snapshot_max_version`` one-for-one.** A
conformance test asserts ``Project.last_sync_version == _snapshot_max_version``
after touching each model; if the union gains a table, that test fails until a
receiver is added.

Deliberately *not* covered:

* ``Dependency`` — the union tracks dependencies via the *predecessor task's*
  ``server_version`` (``MAX(t.server_version)``), never ``dependency.server_version``,
  so a dependency-only change must not move the watermark.
* Every other ``VersionedModel`` outside the union (``PulseResponse``,
  ``RetroBoardItem``, ``BacklogItem``, ``ApiToken``, resources, teams, …).

CPM output writes use ``bulk_update`` (ADR-0091): no ``post_save``, no
``server_version`` bump — so recompute leaves the watermark untouched, matching
the union. The MS Project importer ``bulk_create``s tasks at ``server_version=0``,
which neither the union nor the column counts.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from django.db import models
from django.db.models import F, Value
from django.db.models.functions import Greatest
from django.db.models.signals import post_save

#: A resolver maps a saved instance to the project ids whose watermark it bumps.
#: Returns either a list of ids or a queryset of ids (used as a SQL subquery, so
#: the indirection costs no extra round-trip).
Resolver = Callable[[Any], Iterable[Any]]


def _bump(project_ids: Iterable[Any], server_version: int) -> None:
    from trueppm_api.apps.projects.models import Project

    Project.objects.filter(pk__in=project_ids).update(
        last_sync_version=Greatest(F("last_sync_version"), Value(server_version))
    )


def register_watermark_receivers() -> None:
    """Connect the per-model ``post_save`` receivers. Called from ``SyncConfig.ready``."""
    from trueppm_api.apps.access.models import ProjectMembership
    from trueppm_api.apps.integrations.models import TaskLink
    from trueppm_api.apps.projects.models import (
        Calendar,
        Project,
        RetroActionItem,
        Risk,
        Sprint,
        SprintRetro,
        Task,
        TaskRecurrenceRule,
        TaskSuggestedAssignee,
    )
    from trueppm_api.apps.timetracking.models import TimeEntry

    # Owner-id resolvers. Direct FKs read the id off the instance (no query);
    # indirect ones return a queryset that becomes an IN-subquery in the UPDATE.
    resolvers: dict[type[models.Model], Resolver] = {
        Project: lambda i: [i.pk],
        Task: lambda i: [i.project_id],
        ProjectMembership: lambda i: [i.project_id],
        Risk: lambda i: [i.project_id],
        Sprint: lambda i: [i.project_id],
        # A calendar may be shared by several projects — bump all of them.
        Calendar: lambda i: Project.objects.filter(calendar_id=i.pk).values_list("pk", flat=True),
        SprintRetro: lambda i: Sprint.objects.filter(pk=i.sprint_id).values_list(
            "project_id", flat=True
        ),
        RetroActionItem: lambda i: SprintRetro.objects.filter(pk=i.retro_id).values_list(
            "sprint__project_id", flat=True
        ),
        TaskSuggestedAssignee: lambda i: Task.objects.filter(pk=i.task_id).values_list(
            "project_id", flat=True
        ),
        TaskLink: lambda i: Task.objects.filter(pk=i.task_id).values_list("project_id", flat=True),
        TaskRecurrenceRule: lambda i: Task.objects.filter(pk=i.task_id).values_list(
            "project_id", flat=True
        ),
        # A time entry's owning project is reached through its task (ADR-0185 §6).
        # Any user's entry bumps the project watermark; the per-user sync filter
        # lives in the delta query, not here — a too-high watermark only makes a
        # client re-pull, which is safe (the entry won't be in its filtered delta).
        TimeEntry: lambda i: Task.objects.filter(pk=i.task_id).values_list("project_id", flat=True),
    }

    for model, resolver in resolvers.items():

        def _make_handler(resolve: Resolver) -> Callable[..., None]:
            def _handler(sender: type, instance: Any, **kwargs: Any) -> None:
                # ``raw`` saves (loaddata) bypass app logic; the DB may be
                # mid-fixture-load, so skip — the backfill migration / a later
                # real save establishes the value.
                if kwargs.get("raw"):
                    return
                _bump(resolve(instance), instance.server_version)

            return _handler

        post_save.connect(
            _make_handler(resolver),
            sender=model,
            dispatch_uid=f"sync_watermark_{model._meta.label}",
            weak=False,
        )
