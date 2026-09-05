"""Structural invariants of the shared history-diff policy (#3435).

The behavioral tests in ``test_history.py`` and ``test_changelog.py`` each prove
one surface. These pin the relations that make "one policy" true — the properties
a future edit to a single set would silently break without failing any per-surface
test — and pin the third, allow-list renderer (the board feed) against the privacy
set, since it shares no code with the other two.
"""

from __future__ import annotations

import pytest

from trueppm_api.apps.history.diff_policy import (
    HISTORY_DIFF_DISPLAY_EXCLUDED,
    HISTORY_DIFF_HARD_EXCLUDED,
    HISTORY_DIFF_NOISE,
    HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED,
    HISTORY_DIFF_PRIVACY_GATED,
    HISTORY_DIFF_PROMOTED_WHEN_ALONE,
    is_compared,
    visible_changes,
)
from trueppm_api.apps.projects.board_activity import _BOARD_DIFF_FIELDS
from trueppm_api.apps.projects.models import Task


def test_privacy_gated_fields_are_never_compared_on_any_surface() -> None:
    """The gate acts at compute time: no pipeline ever holds the value."""
    assert HISTORY_DIFF_PRIVACY_GATED, "the set going empty would pass every other test"
    for name in HISTORY_DIFF_PRIVACY_GATED:
        assert name in HISTORY_DIFF_HARD_EXCLUDED
        assert not is_compared(name, object_scoped=True)
        assert not is_compared(name, object_scoped=False)


def test_privacy_gated_fields_are_tracked_so_the_policy_is_load_bearing() -> None:
    """``blocked_reason`` is deliberately NOT stripped at tracking time.

    If the historical model stopped carrying it, the exclusion would become dead
    and a future reader might remove it as such — while a re-tracked field would
    then leak. The test states the dependency the policy comment describes.
    """
    tracked = {f.name for f in Task.history.model._meta.fields}  # type: ignore[attr-defined]
    assert tracked >= HISTORY_DIFF_PRIVACY_GATED


def test_promotion_is_an_escape_hatch_out_of_noise_only() -> None:
    assert HISTORY_DIFF_PROMOTED_WHEN_ALONE <= HISTORY_DIFF_NOISE
    assert HISTORY_DIFF_PROMOTED_WHEN_ALONE.isdisjoint(HISTORY_DIFF_PRIVACY_GATED)
    assert HISTORY_DIFF_PROMOTED_WHEN_ALONE.isdisjoint(HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED)
    for name in HISTORY_DIFF_PROMOTED_WHEN_ALONE:
        assert is_compared(name, object_scoped=True)
    for name in HISTORY_DIFF_NOISE - HISTORY_DIFF_PROMOTED_WHEN_ALONE:
        assert not is_compared(name, object_scoped=False)


def test_object_scoped_exclusion_is_the_only_per_surface_difference() -> None:
    for name in HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED:
        assert not is_compared(name, object_scoped=True)
        assert is_compared(name, object_scoped=False)
    assert HISTORY_DIFF_DISPLAY_EXCLUDED == (
        HISTORY_DIFF_HARD_EXCLUDED | HISTORY_DIFF_NOISE | HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED
    )


@pytest.mark.django_db
def test_drawer_and_changelog_compare_the_same_task_fields() -> None:
    """The convergence claim itself: both pipelines diff one field set for a Task.

    The drawer pre-filters the live model's concrete fields; the generic pipeline
    filters the historical model's fields through ``is_compared``. If either grows
    a local exclusion again, the two sets diverge and this fails.
    """
    from trueppm_api.apps.projects.views import (
        _history_diff_fields,
        _history_promoted_diff_fields,
    )

    drawer = {f.name for f in _history_diff_fields()} | {
        f.name for f in _history_promoted_diff_fields()
    }
    historical = Task.history.model  # type: ignore[attr-defined]
    generic = {
        f.name
        for f in historical._meta.fields
        if is_compared(f.name, object_scoped=True) and f.name not in {"id", "project"}
    }
    assert drawer == generic


def test_board_allow_list_cannot_name_a_privacy_gated_field() -> None:
    """The third renderer is an allow-list, so it is pinned rather than shared."""
    board = {name.removesuffix("_id") for name in _BOARD_DIFF_FIELDS}
    assert board.isdisjoint(HISTORY_DIFF_PRIVACY_GATED)


def test_visible_changes_promotes_only_when_alone() -> None:
    promoted = next(iter(HISTORY_DIFF_PROMOTED_WHEN_ALONE))
    alone = [{"field": promoted}]
    beside = [{"field": promoted}, {"field": "name"}]
    key = lambda c: str(c["field"])  # noqa: E731
    assert visible_changes(alone, key) == alone
    assert visible_changes(beside, key) == [{"field": "name"}]
    assert visible_changes([], key) == []
