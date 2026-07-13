"""Tests for the ``project_notification_matrix`` schema_version surface (#1916).

#645 built the ADR-0086 / ADR-0204 forward-migration registry and converted
``BoardSavedView.config``, but ``ProjectNotificationPreference.matrix`` (#522)
was never added to the surface sweep. This covers the registry registration
directly (pure, no DB — never importing the Django migration module, per the
issue's explicit test constraint) and the read-time upgrade wired into
``ProjectNotificationPreferenceSerializer``, mirroring
``tests/apps/projects/test_schema_migrations.py``'s ``board_saved_view``
coverage.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.notifications.models import (
    PROJECT_NOTIFICATION_DEFAULT_MATRIX,
    ProjectNotificationChannel,
    ProjectNotificationEventType,
    ProjectNotificationPreference,
)
from trueppm_api.apps.notifications.schema_migrations import (
    SURFACE_PROJECT_NOTIFICATION_MATRIX,
)
from trueppm_api.apps.notifications.serializers import ProjectNotificationPreferenceSerializer
from trueppm_api.apps.projects import schema_migrations as sm
from trueppm_api.apps.projects.models import Calendar, Project

User = get_user_model()


# ---------------------------------------------------------------------------
# Generic registry (pure, no DB)
# ---------------------------------------------------------------------------


def test_matrix_surface_registered_at_version_one() -> None:
    assert sm.current_version(SURFACE_PROJECT_NOTIFICATION_MATRIX) == 1


def test_matrix_v0_backfills_missing_event_and_channel() -> None:
    """A pre-convention (v0) matrix gains any missing event type / channel."""
    stale = {
        ProjectNotificationEventType.TASK_ASSIGNED.value: {
            ProjectNotificationChannel.IN_APP.value: True,
        },
        # every other event type entirely absent
    }

    result, version = sm.migrate_payload(SURFACE_PROJECT_NOTIFICATION_MATRIX, stale)

    assert version == 1
    assert result["schema_version"] == 1
    # Existing value preserved
    assert (
        result[ProjectNotificationEventType.TASK_ASSIGNED.value][
            ProjectNotificationChannel.IN_APP.value
        ]
        is True
    )
    # A missing sibling channel on an existing row is backfilled with its default
    assert (
        result[ProjectNotificationEventType.TASK_ASSIGNED.value][
            ProjectNotificationChannel.EMAIL.value
        ]
        == PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.TASK_ASSIGNED][
            ProjectNotificationChannel.EMAIL
        ]
    )
    # A wholly-missing event type is backfilled in full
    assert result[ProjectNotificationEventType.SPRINT_END.value] == dict(
        PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.SPRINT_END]
    )


def test_matrix_current_payload_unchanged() -> None:
    current = {evt: dict(chans) for evt, chans in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items()}
    current[ProjectNotificationEventType.TASK_OVERDUE.value][
        ProjectNotificationChannel.EMAIL.value
    ] = False
    current["schema_version"] = 1

    result, version = sm.migrate_payload(SURFACE_PROJECT_NOTIFICATION_MATRIX, current)

    assert version == 1
    assert result == current


# ---------------------------------------------------------------------------
# Serializer read path (DB) — read-time upgrade + schema_version field
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="SM Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def alice(db: object) -> object:
    return User.objects.create_user(username="alice-sm", password="pw")


def test_new_row_defaults_schema_version_to_one(project: Project, alice: object) -> None:
    row = ProjectNotificationPreference.objects.create(project=project, user=alice)
    assert row.schema_version == 1


def test_serializer_upgrades_stale_matrix_and_stamps_schema_version(
    project: Project, alice: object
) -> None:
    """A matrix stored at schema_version=0, missing keys, is forward-migrated to
    the current shape on read via ``migrate_payload`` — independent of the
    view-layer ``_merge_matrix`` overlay, which is a distinct legacy-garbage
    -stripping concern (#675) covered in ``test_project_preferences.py``.
    """
    row = ProjectNotificationPreference.objects.create(
        project=project,
        user=alice,
        matrix={
            ProjectNotificationEventType.TASK_ASSIGNED.value: {
                ProjectNotificationChannel.IN_APP.value: True,
            },
        },
        schema_version=0,
    )

    data = ProjectNotificationPreferenceSerializer(row).data

    assert data["schema_version"] == 1
    assert set(data["matrix"].keys()) == {c.value for c in ProjectNotificationEventType}
    # Existing value preserved
    assert (
        data["matrix"][ProjectNotificationEventType.TASK_ASSIGNED.value][
            ProjectNotificationChannel.IN_APP.value
        ]
        is True
    )
    # A missing sibling channel on the same event is backfilled
    assert (
        data["matrix"][ProjectNotificationEventType.TASK_ASSIGNED.value][
            ProjectNotificationChannel.EMAIL.value
        ]
        == PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.TASK_ASSIGNED][
            ProjectNotificationChannel.EMAIL
        ]
    )
    # A wholly-missing event type is backfilled with its full default row
    assert data["matrix"][ProjectNotificationEventType.SPRINT_END.value] == dict(
        PROJECT_NOTIFICATION_DEFAULT_MATRIX[ProjectNotificationEventType.SPRINT_END]
    )
    # schema_version is a sibling field, not mixed into the matrix grid
    assert "schema_version" not in data["matrix"]


def test_serializer_leaves_current_matrix_row_untouched(project: Project, alice: object) -> None:
    """A row already at the current schema_version round-trips unchanged."""
    custom = {evt: dict(chans) for evt, chans in PROJECT_NOTIFICATION_DEFAULT_MATRIX.items()}
    custom[ProjectNotificationEventType.TASK_OVERDUE.value][
        ProjectNotificationChannel.EMAIL.value
    ] = False
    row = ProjectNotificationPreference.objects.create(
        project=project,
        user=alice,
        matrix=custom,
        schema_version=1,
    )

    data = ProjectNotificationPreferenceSerializer(row).data

    assert data["schema_version"] == 1
    assert data["matrix"] == custom
