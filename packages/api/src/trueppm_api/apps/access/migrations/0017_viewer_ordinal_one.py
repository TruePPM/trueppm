"""ADR-0072 Amendment 1 (#2489): move the VIEWER ordinal from 0 to 1.

Every other ordinal is unchanged, so the reserved Enterprise bands survive intact —
the read-augmented band between VIEWER and MEMBER simply becomes 2–99.

Why the value moves at all: the ordinal is a client-visible wire value (membership
payloads, invite responses, SSO auto-create defaults, MCP reads) and JavaScript treats
``0`` as falsy. One ``role || DEFAULT`` in any consumer silently promotes a Viewer to
whatever the default is — a widening of access that fails silently. Making every
ordinal truthy removes the failure mode rather than relying on every consumer to
remember ``??``. ``0`` is now permanently unassigned; "no membership" is expressed as
``None``, a distinct type, never an ordinal.

Five columns carry a ``Role`` ordinal and are all moved in one atomic RunPython:

  - ``access.ProjectMembership.role``
  - ``access.ProgramMembership.role``
  - ``projects.Project.default_member_role``       (choices are a deferred callable,
  - ``projects.HistoricalProject.default_member_role``  so neither needs an AlterField)
  - ``workspace.GroupProject.role``

``sso.SsoProviderPolicy.default_role`` is deliberately absent: it is a ``WorkspaceRole``
(MEMBER/ADMIN/OWNER, no VIEWER tier), not a project ``Role``.

Migration safety:
- Idempotent by shape — ``filter(<col>=0).update(<col>=1)`` finds nothing on a re-run.
- Guarded against collision. Ordinal 1 sat inside the Enterprise reserved band under
  the pre-amendment scheme, so a deployment that registered a custom role there would
  see two distinct roles collapse into one. The guard refuses loudly instead; silently
  merging permission tiers is the worse failure. The same guard runs in reverse against
  a pre-existing 0.
- Reversible: 1 → 0 restores the prior scheme exactly.
- ``elidable=True`` — a fresh install created from a squashed history has no ordinal-0
  rows to move, so the backfill is safe to drop in a squash (see the CLAUDE.md
  migration-discipline rules).
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models

# Choice tuples used in AlterField — must match Role(IntegerChoices) in models.py
NEW_CHOICES = [
    (1, "Viewer"),
    (100, "Team Member"),
    (200, "Resource Manager"),
    (300, "Project Manager"),
    (400, "Project Admin"),
]

# (app_label, model_name, column) for every field that stores a project Role ordinal.
ROLE_COLUMNS: list[tuple[str, str, str]] = [
    ("access", "ProjectMembership", "role"),
    ("access", "ProgramMembership", "role"),
    ("projects", "Project", "default_member_role"),
    ("projects", "HistoricalProject", "default_member_role"),
    ("workspace", "GroupProject", "role"),
]


def _move(apps: Any, from_value: int, to_value: int, direction: str) -> None:
    """Move every stored Role ordinal from ``from_value`` to ``to_value``.

    Refuses if the destination ordinal is already occupied anywhere: that means an
    Enterprise custom role was registered in the reserved band at exactly this value,
    and completing the move would silently merge it with VIEWER.
    """
    occupied = [
        f"{app_label}.{model_name}.{column}"
        for app_label, model_name, column in ROLE_COLUMNS
        if apps.get_model(app_label, model_name).objects.filter(**{column: to_value}).exists()
    ]
    if occupied:
        raise RuntimeError(
            f"Refusing to {direction} the VIEWER ordinal to {to_value}: that value is "
            f"already in use by {', '.join(occupied)}. Ordinal {to_value} sits in a "
            "reserved band (ADR-0072), so this is most likely an Enterprise custom "
            "role. Re-point that role to a free ordinal in the band and re-run; "
            "completing the move would merge it into VIEWER."
        )

    for app_label, model_name, column in ROLE_COLUMNS:
        apps.get_model(app_label, model_name).objects.filter(**{column: from_value}).update(
            **{column: to_value}
        )


def viewer_zero_to_one(apps: Any, schema_editor: Any) -> None:
    """Forward: VIEWER 0 → 1."""
    _move(apps, from_value=0, to_value=1, direction="move")


def viewer_one_to_zero(apps: Any, schema_editor: Any) -> None:
    """Reverse: VIEWER 1 → 0, restoring the pre-amendment scheme."""
    _move(apps, from_value=1, to_value=0, direction="revert")


class Migration(migrations.Migration):
    # The RunPython reaches into projects and workspace, so their models must already
    # be in the migration state. access already depends on workspace (0008, 0011) and
    # workspace on projects, so this adds no cycle.
    dependencies = [
        ("access", "0016_externalstakeholder"),
        ("projects", "0127_historicalprogram_mcp_enabled_and_more"),
        ("workspace", "0020_viewer_ordinal_one"),
    ]

    operations = [
        migrations.AlterField(
            model_name="programmembership",
            name="role",
            field=models.IntegerField(choices=NEW_CHOICES),
        ),
        migrations.AlterField(
            model_name="projectmembership",
            name="role",
            field=models.IntegerField(choices=NEW_CHOICES),
        ),
        migrations.RunPython(viewer_zero_to_one, viewer_one_to_zero, elidable=True),
    ]
