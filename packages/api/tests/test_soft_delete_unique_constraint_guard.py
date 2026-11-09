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
# unique is correct. Seeded from the sites the #3437 audit enumerated.
_REVIVED = "revoke soft-deletes; re-grant revives the tombstone rather than inserting (#3410)"
_NEVER_DELETED = "model is never soft-deleted in practice (#3437 audit)"
_COUNTER = "short_id comes from a server-side counter, so a value is never re-issued (#3437 audit)"
# UNREVIEWED entries were enumerated by the #3437 audit as carrying an unconditional unique
# but were not individually traced for a delete-then-recreate path. They are allowlisted so the
# guard can ship green and still block the NEXT instance; each needs a human verdict.
_UNREVIEWED = "UNREVIEWED: delete-then-recreate path not traced in #3437"

ALLOWLIST: dict[tuple[str, str], str] = {
    ("access.ProjectMembership", "constraint:uniq_project_membership_project_user"): _REVIVED,
    ("access.ProgramMembership", "constraint:uniq_program_membership_program_user"): _REVIVED,
    ("workspace.GroupMembership", "constraint:uniq_group_membership_group_user"): _REVIVED,
    (
        "workspace.WorkspaceMembership",
        "constraint:uniq_workspace_membership_workspace_user",
    ): "UNREVIEWED: get_or_create is tombstone-blind (silently confers nothing); see #3437",
    (
        "resources.ProjectResource",
        "constraint:uniq_project_resource_project_resource",
    ): _NEVER_DELETED,
    ("resources.ResourceSkill", "constraint:uniq_resource_skill_resource_skill"): _NEVER_DELETED,
    ("resources.TaskSkillRequirement", "constraint:uniq_task_skill_req_task_skill"): _NEVER_DELETED,
    ("projects.Task", "constraint:unique_task_short_id_per_project"): _COUNTER,
    ("projects.Risk", "constraint:unique_risk_short_id_per_project"): _COUNTER,
    ("projects.Sprint", "constraint:unique_sprint_short_id_per_project"): _COUNTER,
    ("projects.Baseline", "constraint:unique_active_baseline_per_project"): (
        "conditional on is_active=True, not is_deleted; UNREVIEWED against soft-deleted active rows"
    ),
    ("projects.Dependency", "constraint:unique_dependency"): _UNREVIEWED,
    ("projects.Program", "constraint:program_code_upper_uniq"): _UNREVIEWED,
    ("projects.Project", "constraint:project_code_upper_uniq"): _UNREVIEWED,
    ("projects.ProjectCalendarLayer", "constraint:uniq_project_calendar_layer"): _UNREVIEWED,
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


def _unconditional_uniques(model: type[models.Model]) -> list[str]:
    found = []
    for c in model._meta.constraints:
        if isinstance(c, models.UniqueConstraint) and (
            c.condition is None or "is_deleted" not in str(c.condition)
        ):
            found.append(f"constraint:{c.name}")
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
