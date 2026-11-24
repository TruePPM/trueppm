"""Frozen copies of logic the profiles data migrations run (CLAUDE.md migration rule 3).

A migration must never import live services: a later edit to the service would silently
change what an already-written migration does on a fresh install. These functions are
snapshots, deliberately not kept in sync with ``services.py``.
"""

from __future__ import annotations

from typing import Any

#: Batch size for the ``hidden_views`` → ``ProjectViewState`` backfill.
BATCH_SIZE = 500


def backfill_project_view_states(apps: Any, schema_editor: Any) -> None:
    """Copy each non-empty ``UserProfile.hidden_views`` into per-project ``user`` entries.

    ADR-1478 §6 step 1: for every profile with hides and every live project the user is
    a member of, create a ``ProjectViewState`` whose entries are ``source: "user"`` with
    ``seeded_at`` null. Nothing reappears (every hide carries over) and nothing is
    re-seeded: ``seeded_lens`` records the user's ``role_context`` at migration time,
    which marks the row "already resolved" under that lens, so the first read after the
    upgrade neither applies a lens seed on top nor offers that lens's suggestions.

    Idempotent on the ``(user, project)`` unique constraint: an existing row is left
    alone and ``ignore_conflicts`` skips a concurrent duplicate, so a re-run or a
    partially applied run converges.
    """

    UserProfile = apps.get_model("profiles", "UserProfile")
    ProjectMembership = apps.get_model("access", "ProjectMembership")
    ProjectViewState = apps.get_model("profiles", "ProjectViewState")
    hideable = {
        "schedule", "grid", "calendar", "product-backlog", "sprints", "board",
        "today", "risk", "reports", "activity", "assets", "resources",
    }  # fmt: skip

    profiles = UserProfile.objects.exclude(hidden_views=[]).only(
        "user_id", "hidden_views", "role_context"
    )
    batch: list[Any] = []
    for profile in profiles.iterator(chunk_size=BATCH_SIZE):
        keys = sorted({k for k in (profile.hidden_views or []) if k in hideable})
        if not keys:
            continue
        project_ids = ProjectMembership.objects.filter(
            user_id=profile.user_id, is_deleted=False, project__is_deleted=False
        ).values_list("project_id", flat=True)
        existing = set(
            ProjectViewState.objects.filter(user_id=profile.user_id).values_list(
                "project_id", flat=True
            )
        )
        for project_id in project_ids:
            if project_id in existing:
                continue
            batch.append(
                ProjectViewState(
                    user_id=profile.user_id,
                    project_id=project_id,
                    seeded_lens=profile.role_context or "unified",
                    hides=[
                        {"view": k, "hidden": True, "source": "user", "lens": None, "at": None}
                        for k in keys
                    ],
                )
            )
            if len(batch) >= BATCH_SIZE:
                ProjectViewState.objects.bulk_create(batch, ignore_conflicts=True)
                batch = []
    if batch:
        ProjectViewState.objects.bulk_create(batch, ignore_conflicts=True)
