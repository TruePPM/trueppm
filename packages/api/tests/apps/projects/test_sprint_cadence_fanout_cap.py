"""Pin the sprint-cadence fan-out cap (#4286)."""

from __future__ import annotations

from trueppm_api.apps.projects.sprint_cadence import MAX_GENERATED_SPRINTS


def test_generated_sprint_cap_has_not_grown_unreviewed() -> None:
    """The cadence endpoint broadcasts one ``sprint_created`` per row, and each call
    persists a ``BoardEvent`` replay row post-commit (ADR-0158). That per-row choice
    is only cheap at this cap. Raising it means revisiting ``_announce_created`` in
    ``projects/views.py`` (a batched event) -- then update this bound deliberately.
    """
    assert MAX_GENERATED_SPRINTS <= 52
