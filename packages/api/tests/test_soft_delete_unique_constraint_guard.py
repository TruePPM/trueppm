"""Class guard (#3437): no unconditional unique constraint on a soft-deletable model.

Soft delete keeps the row, so an unconditional unique constraint lets a tombstone own
its slot forever and re-creating the same key raises ``IntegrityError`` (a 500). This
was fixed model by model (#3410, ``_reconcile_pair``, ``Label``) with nothing detecting
the next one. This test walks every concrete model carrying ``is_deleted`` and requires
each unique constraint either to be conditional on ``is_deleted`` or to be named in
``ALLOWLIST`` with a reason. A new entry is a claim that the key is deliberate.
"""

from __future__ import annotations

from django.apps import apps
from django.db import models

# (app_label.ModelName, constraint-or-unique_together key) -> why an unconditional
# unique is correct. Seeded from an audit of every soft-deletable model.
_REVIVED = "revoke soft-deletes; re-grant revives the tombstone rather than inserting"
_HARD_DELETED = (
    "no is_deleted=True writer: the viewset hard-deletes (default destroy), so no tombstone "
    "exists to collide"
)
_ONE_TO_ONE = "UNREVIEWED: one-to-one extension row; delete-then-recreate path not traced"
_COUNTER = "short_id comes from a server-side counter, so a value is never re-issued"
# UNREVIEWED entries were enumerated by the audit as carrying an unconditional unique
# but were not individually traced for a delete-then-recreate path. They are allowlisted so the
# guard can ship green and still block the NEXT instance; each needs a human verdict.
_UNREVIEWED = "UNREVIEWED: delete-then-recreate path not traced"

ALLOWLIST: dict[tuple[str, str], str] = {
    ("access.ProjectMembership", "constraint:uniq_project_membership_project_user"): _REVIVED,
    ("access.ProgramMembership", "constraint:uniq_program_membership_program_user"): _REVIVED,
    ("workspace.GroupMembership", "constraint:uniq_group_membership_group_user"): _REVIVED,
    (
        "workspace.WorkspaceMembership",
        "constraint:uniq_workspace_membership_workspace_user",
    ): (
        "no is_deleted=True writer was found (member removal sets status, not is_deleted); "
        "UNREVIEWED: the invite get_or_create is tombstone-blind, so a tombstone would matter"
    ),
    (
        "resources.ProjectResource",
        "constraint:uniq_project_resource_project_resource",
    ): (
        "UNREVIEWED: soft-deleted only by the resource-deactivation cascade "
        "(ResourceViewSet.perform_destroy); restore revives the row; re-add path not traced"
    ),
    ("resources.ResourceSkill", "constraint:uniq_resource_skill_resource_skill"): _HARD_DELETED,
    ("resources.TaskSkillRequirement", "constraint:uniq_task_skill_req_task_skill"): _HARD_DELETED,
    ("projects.Task", "constraint:unique_task_short_id_per_project"): _COUNTER,
    ("projects.Risk", "constraint:unique_risk_short_id_per_project"): _COUNTER,
    ("projects.Sprint", "constraint:unique_sprint_short_id_per_project"): _COUNTER,
    ("projects.Baseline", "constraint:unique_active_baseline_per_project"): (
        "conditional on is_active=True, not is_deleted; UNREVIEWED against soft-deleted active rows"
    ),
    ("projects.ApiToken", "field:token_hash"): (
        "hash of a freshly generated random secret; a value is never re-issued"
    ),
    ("projects.BacklogItem", "field:pulled_task"): _ONE_TO_ONE,
    ("projects.PhaseGateConfig", "field:program"): _ONE_TO_ONE,
    ("projects.ProjectDecisionsPolicy", "field:project"): _ONE_TO_ONE,
    ("projects.ProjectGuardrailPolicy", "field:project"): _ONE_TO_ONE,
    ("projects.ProjectSignalPrivacyPolicy", "field:project"): _ONE_TO_ONE,
    ("projects.SprintRetro", "field:sprint"): _ONE_TO_ONE,
    ("projects.TaskRecurrenceRule", "field:task"): _ONE_TO_ONE,
    ("resources.Skill", "field:normalized_name"): _UNREVIEWED,
    ("projects.Dependency", "constraint:unique_dependency"): (
        "UNREVIEWED: delete-then-re-add returns 400 'must make a unique set' (not a 500) because "
        "DRF's UniqueTogetherValidator ignores soft-deleted state, so a deleted edge cannot be "
        "re-created. The restore code (cascade_project_children_restore, "
        "cascade_task_children_restore) relies on this constraint being non-partial, "
        "so making it conditional needs those paths revisited"
    ),
    ("projects.Program", "constraint:program_code_upper_uniq"): (
        "deliberate never-reuse rule: is_key_taken counts tombstones, so a deleted program's "
        "code is refused with a 400 rather than reaching the index"
    ),
    ("projects.Project", "constraint:project_code_upper_uniq"): (
        "deliberate never-reuse rule: is_key_taken counts tombstones, so a deleted project's "
        "code is refused with a 400 rather than reaching the index"
    ),
    ("projects.ProjectCalendarLayer", "constraint:uniq_project_calendar_layer"): (
        "the only writer (the calendars PUT) hard-deletes the old layer rows before "
        "re-inserting, so no tombstone is left behind"
    ),
    ("projects.Task", "constraint:unique_recurrence_occurrence_per_date"): _UNREVIEWED,
}


def _soft_deletable_models() -> list[type[models.Model]]:
    return [
        m
        for m in apps.get_models()
        if not m._meta.abstract
        and not m._meta.proxy
        and any(f.name == "is_deleted" for f in m._meta.get_fields())
        and not m.__name__.startswith("Historical")
    ]


def _excludes_deleted(condition: models.Q | None) -> bool:
    """True only for a condition that keeps tombstones out of the index.

    ``Q(is_deleted=True)`` mentions the field but does the opposite, so the check is
    on the literal ``(is_deleted, False)`` child, not on the field name.
    """
    return condition is not None and ("is_deleted", False) in _flatten(condition)


def _flatten(q: models.Q) -> list[object]:
    out: list[object] = []
    if q.connector != models.Q.AND or q.negated:
        return out  # an OR / NOT does not guarantee tombstones are excluded
    for child in q.children:
        if isinstance(child, models.Q):
            out.extend(_flatten(child))
        else:
            out.append(child)
    return out


def _unconditional_uniques(model: type[models.Model]) -> list[str]:
    """Every uniqueness rule a tombstone could still occupy.

    Covers ``UniqueConstraint``, ``unique_together``, and field-level ``unique=True`` /
    ``OneToOneField`` (the latter two are an unconditional unique index that no
    ``Meta`` entry shows). The primary key is excluded.
    """
    found = []
    for c in model._meta.constraints:
        if isinstance(c, models.UniqueConstraint) and not _excludes_deleted(c.condition):
            found.append(f"constraint:{c.name}")
    for f in model._meta.concrete_fields:
        if f.primary_key or not f.unique:
            continue
        # Skip parent-link one-to-ones created by multi-table inheritance.
        if isinstance(f, models.OneToOneField) and f.remote_field.parent_link:
            continue
        found.append(f"field:{f.name}")
    for fields in model._meta.unique_together:
        found.append("unique_together:" + ",".join(fields))
    return found


def test_guard_walks_a_non_trivial_set_of_models() -> None:
    soft = _soft_deletable_models()
    assert len(soft) >= 20, f"denominator collapsed: only {len(soft)} soft-deletable models"
    assert any(m.__name__ == "Label" for m in soft)


def test_label_name_constraint_is_conditional() -> None:
    from trueppm_api.apps.projects.models import Label

    assert "constraint:uniq_label_name_per_project" not in _unconditional_uniques(Label)


def test_every_unconditional_unique_on_a_soft_deletable_model_is_allowlisted() -> None:
    offenders = []
    seen_keys = set()
    for model in _soft_deletable_models():
        for key in _unconditional_uniques(model):
            k = (model._meta.label, key)
            seen_keys.add(k)
            if k not in ALLOWLIST:
                offenders.append(k)
    assert not offenders, (
        "Unconditional unique on a soft-deletable model (tombstone blocks re-creation). "
        "Add condition=Q(is_deleted=False) or allowlist with a reason:\n"
        + "\n".join(f"  {m} {key}" for m, key in sorted(offenders))
    )
    stale = set(ALLOWLIST) - seen_keys
    assert not stale, f"Stale allowlist entries (constraint gone or now conditional): {stale}"


def test_condition_check_rejects_a_condition_that_keeps_tombstones() -> None:
    assert _excludes_deleted(models.Q(is_deleted=False))
    assert _excludes_deleted(models.Q(is_deleted=False) & models.Q(project__isnull=False))
    assert not _excludes_deleted(models.Q(is_deleted=True))
    assert not _excludes_deleted(models.Q(is_deleted=False) | models.Q(name=""))
    assert not _excludes_deleted(None)
