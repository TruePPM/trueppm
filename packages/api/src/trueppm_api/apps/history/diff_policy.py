"""Which tracked fields a history diff shows, hides, and promotes — decided once.

Task field changes reach users through **three** renderers, and until #3435 each
carried its own exclusion list:

* the task drawer's Activity tab — ``apps/projects/views.py`` (``TaskHistoryView``),
  Task-only, FK values resolved to labels;
* the project **Activity** page and the per-object history routes —
  ``apps/history/views.py::_compute_diffs``, every project-scoped historical model,
  raw values;
* the board activity feed — ``apps/projects/board_activity.py``, a curated
  **allow-list** (``_BOARD_DIFF_FIELDS``) rather than allow-by-exclusion.

The first two disagreed on what to hide, and only the first had a label map, so the
project Activity page rendered raw column names for every change the drawer rendered
as prose. Decision (#3435): the two allow-by-exclusion pipelines **converge** on this
module. They stay separate functions because they differ in what they *resolve* (the
drawer batch-resolves FK ids to names; the generic pipeline carries the ids), but
*which* fields are compared, hidden, and promoted is decided here, and both emit the
model **field name** (``assignee``), never the column (``assignee_id``), so one client
label map (``activityFormat.ts::fieldLabel``) serves every surface. The board feed
keeps its allow-list — a board reader wants six fields, not "everything but the
noise" — and is pinned against the privacy set by test rather than by sharing code.

The sets are grouped by the *reason* a field is hidden, because the reasons carry
different obligations. A noise exclusion may be promoted back when it is a record's
only change (#3306); an access-control exclusion never may, and conflating the two
turns a labelling cleanup into a disclosure bug.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TypeVar

T = TypeVar("T")

# django-simple-history's own columns. Present on every ``Historical*`` row and never
# a user change; the drawer never sees them because it iterates the live model's
# fields, but the generic pipeline iterates the historical model's and must drop them.
HISTORY_DIFF_META_COLUMNS: frozenset[str] = frozenset(
    {"history_id", "history_date", "history_change_reason", "history_user", "history_type"}
)

# Engine outputs and sync counters. ``HistoricalTask`` no longer carries any of these
# (``_HISTORY_EXCLUDED_TASK`` strips them at tracking time), but the generic pipeline
# diffs eight other models whose tracking lists differ, so they are named here as well:
# a model that does track them must still never show a recalculation as an edit.
HISTORY_DIFF_ENGINE_AND_SYNC: frozenset[str] = frozenset(
    {
        "early_start",
        "early_finish",
        "late_start",
        "late_finish",
        "total_float",
        "free_float",
        "is_critical",
        "scheduled_start",
        "server_version",
        "sync_seq",
        "deleted_version",
        "deleted_at",
    }
)

# Low-signal bookkeeping hidden from every diff surface (ADR-0096 Part 1, #874). These
# are *display* decisions: the historical model tracks the column, a reader simply
# gains nothing from a row about it. Members of this set — and only this set — are
# eligible for promotion when they are a record's only change.
HISTORY_DIFF_NOISE: frozenset[str] = frozenset(
    {
        "short_id",  # immutable, system-assigned identifier
        "status_changed_at",  # derived bookkeeping timestamp
        "blocked_since",  # derived bookkeeping timestamp
        "sprint_pending",  # transient ADR-0102 scope-injection flag
        # sprint-backlog reorder bookkeeping: drag-reorder rewrites the team's
        # within-sprint sequence on every affected sibling, so surfacing it would
        # flood the timeline with integer noise — mirrors the other rank/bookkeeping
        # exclusions (#1885). Deliberate ordering signals (priority_rank) stay visible.
        "sprint_rank",
        # Promoted back into the diff when it is a record's ONLY change — see
        # ``HISTORY_DIFF_PROMOTED_WHEN_ALONE`` below.
        "parent_governance_inherited",  # internal inheritance bookkeeping
        "recurrence_occurrence_date",  # system-set during recurrence expansion
        "recurrence_rule",  # FK to the rule object; recurrence shown via is_recurring
    }
)

# The one deliberate per-surface difference. A soft delete is a ``~`` row whose only
# tracked change is ``is_deleted`` (``VersionedModel.soft_delete`` saves the flag; a
# hard ``-`` row exists only for the purge task). On a surface scoped to ONE object —
# the task drawer — that flag is not a field change worth a row: a deleted task has no
# drawer to read it in, and a restore re-opens the same drawer to the same task. On the
# cross-object project Activity page the same row is the ONLY record that the delete
# happened at all, so hiding it there would make every soft delete invisible — the
# #3306 "write with no record" shape, for the most consequential write there is.
HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED: frozenset[str] = frozenset({"is_deleted"})

# Excluded for an ACCESS-CONTROL reason, not a noise one, and therefore never
# promotable and never a per-surface judgment call.
#
# ``blocked_reason`` is contributor voice (ADR-0124, #1135 — the "Morgan surveillance
# boundary"): ``TaskSerializer`` read-gates it to the assignee and @-mentioned users
# via ``can_read_blocker_reason()``, while every history endpoint is Viewer+ for every
# project member. ``HistoricalTask`` deliberately still tracks it (it is NOT in
# ``_HISTORY_EXCLUDED_TASK``), so this exclusion is the only thing keeping the reason
# — and every past reason — off a team-readable feed. The structured blocker signal
# (``blocker_type`` / ``blocked_since`` / ``blocked_by`` / ``blocking_task``) is
# team-shareable and stays in the diff.
HISTORY_DIFF_PRIVACY_GATED: frozenset[str] = frozenset({"blocked_reason"})

# Noise exclusions surfaced anyway when they are the ONLY thing a record changed (#3306).
#
# ``parent_governance_inherited`` is genuinely bookkeeping alongside a governance
# change: every ordinary governance write moves the two together, so surfacing both
# would double the diff rows on the highest-frequency case and turn the summary verb
# from "changed governance" into "updated 2 fields". That call stands.
#
# But the bit can also move *alone*, and then the exclusion plus the empty-diff drop
# erase the write entirely. The concrete case is a classification cascade onto a root
# already at the requested ``governance_class`` with ``parent_governance_inherited=True``:
# declaring the class on the root sets the bit to False, which writes the row, bumps
# ``server_version``, records an undo-ledger row and broadcasts ``tasks_bulk_mutated``
# — and left the task's Activity tab showing nothing at all.
#
# Narrowing the drop rule instead (rendering every empty-diff ``~`` record) was
# rejected: that is the bare "Updated" pill issue 874 removed, and it would resurrect
# it for every ``sprint_rank`` reorder and every transient ``sprint_pending`` flip.
# Promotion keeps the exclusion's intent — no noise beside a change the user can
# already read — while guaranteeing that no write is invisible.
HISTORY_DIFF_PROMOTED_WHEN_ALONE: frozenset[str] = frozenset({"parent_governance_inherited"})

# Everything a diff never compares, on any surface. Privacy-gated names are excluded
# here at *compute* time, not at render time, so no pipeline ever holds the value in a
# structure a later refactor could accidentally serialize.
HISTORY_DIFF_HARD_EXCLUDED: frozenset[str] = (
    HISTORY_DIFF_META_COLUMNS | HISTORY_DIFF_ENGINE_AND_SYNC | HISTORY_DIFF_PRIVACY_GATED
)

# What the drawer's routine tuple excludes — the name the drawer has always used.
HISTORY_DIFF_DISPLAY_EXCLUDED: frozenset[str] = (
    HISTORY_DIFF_HARD_EXCLUDED | HISTORY_DIFF_NOISE | HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED
)


def is_compared(name: str, *, object_scoped: bool) -> bool:
    """Whether a pipeline should diff the field at all.

    Hard exclusions never are. Noise is compared only if it is promotable, so a
    promoted field can be rendered when it stands alone; the rest of the noise is
    skipped before comparison rather than filtered afterwards, which is what keeps
    the drawer's FK-id collection from resolving ids nobody will see.
    """
    if name in HISTORY_DIFF_HARD_EXCLUDED:
        return False
    if object_scoped and name in HISTORY_DIFF_OBJECT_SCOPED_EXCLUDED:
        return False
    if name in HISTORY_DIFF_NOISE:
        return name in HISTORY_DIFF_PROMOTED_WHEN_ALONE
    return True


def visible_changes(changes: Iterable[T], field_name: Callable[[T], str]) -> list[T]:
    """Apply the promote-when-alone rule to one record's compared changes.

    Routine changes render as they are. A change in
    :data:`HISTORY_DIFF_PROMOTED_WHEN_ALONE` renders only when the record has no
    routine change to show — it rescues an otherwise invisible write without adding
    a row beside a change the reader can already see. Generic over the change shape
    so the drawer's ``(field, old, new)`` tuples and the generic pipeline's dicts run
    the same rule; ``field_name`` extracts the model field name from either.
    """
    items = list(changes)
    routine = [c for c in items if field_name(c) not in HISTORY_DIFF_PROMOTED_WHEN_ALONE]
    if routine:
        return routine
    return [c for c in items if field_name(c) in HISTORY_DIFF_PROMOTED_WHEN_ALONE]
