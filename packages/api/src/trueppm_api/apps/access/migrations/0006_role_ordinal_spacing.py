"""ADR-0072: re-space role ordinals from (0,1,2,3,4) to (0,100,200,300,400).

The OSS edition continues to ship the same 5 named roles with identical
user-visible behavior. The re-spacing opens 99-unit slot bands between OSS
tiers so Enterprise can register custom roles (e.g., a "Senior Scheduler" at
250) without forcing an OSS renumber.

Migration safety:
- Forward operation multiplies existing ``ProjectMembership.role`` and
  ``ProgramMembership.role`` values by 100. Both tables in a single Django
  transaction (default ``atomic=True`` on RunPython).
- Reverse operation divides by 100; integer division recovers the original
  values exactly because the forward multiplies by 100 and OSS only writes
  the canonical ordinals.
- Idempotent under retry: the forward RunPython guards on
  ``max(role) <= 4`` — if the migration is partially applied and re-run, we
  do not double-multiply.
- No DB-level CHECK constraint exists on the ``role`` column (confirmed in
  the audit), so the AlterField choice list change is metadata-only at the
  DB layer.
- Breaking API change: external clients consuming the numeric ``my_role``
  field will see new values. Surfaced in the changelog and release notes.

Coupled migration: both ``ProjectMembership.role`` and ``ProgramMembership.role``
are re-spaced in one transaction. Splitting them is technically possible but
adds no value and complicates rollback. ProgramMembership exists from
0005; both tables share the same ``Role`` enum.
"""

from __future__ import annotations

from typing import Any

from django.db import migrations, models
from django.db.models import F

# Choice tuples used in AlterField — must match Role(IntegerChoices) in models.py
NEW_CHOICES = [
    (0, "Viewer"),
    (100, "Team Member"),
    (200, "Resource Manager"),
    (300, "Project Manager"),
    (400, "Project Admin"),
]


def respace_ordinals(apps: Any, schema_editor: Any) -> None:
    """Forward: multiply existing role values by 100.

    Guarded by ``max(role) <= 4`` per table to be idempotent under retry. If
    the migration is partially applied and re-run, the guard ensures we never
    double-multiply (which would produce 10000s instead of 100s).
    """
    ProjectMembership = apps.get_model("access", "ProjectMembership")
    ProgramMembership = apps.get_model("access", "ProgramMembership")

    # Guard: only apply if values are still in the old (0–4) range.
    # ``role__gt=4`` would only match if the migration already ran.
    project_already_migrated = ProjectMembership.objects.filter(role__gt=4).exists()
    program_already_migrated = ProgramMembership.objects.filter(role__gt=4).exists()

    if project_already_migrated or program_already_migrated:
        # Partial state — refuse to double-apply. Operator must manually reverse
        # to {0..4} before re-running, or manually finish the half-completed
        # migration. Loud failure is preferable to silent data corruption.
        raise RuntimeError(
            "Refusing to re-apply 0006_role_ordinal_spacing: at least one table "
            "already contains role values > 4. If the migration is partially "
            "applied, reverse it first or manually complete the multiplication."
        )

    # Skip role=0 (VIEWER stays at 0 under both schemes). The filter on
    # ``role__gt=0`` avoids touching every Viewer row.
    ProjectMembership.objects.filter(role__gt=0).update(role=F("role") * 100)
    ProgramMembership.objects.filter(role__gt=0).update(role=F("role") * 100)


def reverse_ordinals(apps: Any, schema_editor: Any) -> None:
    """Reverse: divide existing role values by 100.

    PostgreSQL integer division truncates, so 100/100=1, 200/100=2, etc. The
    reverse is exact because the forward only multiplies canonical OSS ordinals
    (0/100/200/300/400). If an Enterprise custom role at 250 existed at reverse
    time, it would truncate to 2 (silently merging into SCHEDULER). The reverse
    function is therefore safe only against the same OSS-only data the forward
    produced — which is the contract: this migration is OSS-only and predates
    Enterprise custom-role registration.
    """
    ProjectMembership = apps.get_model("access", "ProjectMembership")
    ProgramMembership = apps.get_model("access", "ProgramMembership")

    ProjectMembership.objects.filter(role__gt=0).update(role=F("role") / 100)
    ProgramMembership.objects.filter(role__gt=0).update(role=F("role") / 100)


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0005_program_entity_and_membership"),
    ]

    operations = [
        migrations.AlterField(
            model_name="projectmembership",
            name="role",
            field=models.IntegerField(choices=NEW_CHOICES),
        ),
        migrations.AlterField(
            model_name="programmembership",
            name="role",
            field=models.IntegerField(choices=NEW_CHOICES),
        ),
        migrations.RunPython(respace_ordinals, reverse_ordinals),
    ]
