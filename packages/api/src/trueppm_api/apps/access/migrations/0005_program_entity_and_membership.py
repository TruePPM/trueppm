"""ADR-0070: introduce ProgramMembership for Program entity RBAC.

Migration safety:
- ``ProgramMembership`` is a NEW model — no existing rows to migrate. Mirrors
  ``ProjectMembership`` structurally (PROTECT on program FK, CASCADE on user
  FK, ``unique_together`` on (program, user)).
- PROTECT on the program FK is intentional — deleting a Program requires
  clearing memberships first. The access service layer (``delete_program``)
  enforces this atomically.
- No destructive operations, no NOT NULL columns without defaults, no data
  migrations. Depends on ``projects.0036_program_entity_and_membership``
  (the FK target).
"""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0004_alter_projectmembership_role"),
        ("projects", "0036_program_entity_and_membership"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ProgramMembership",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                ("deleted_version", models.BigIntegerField(blank=True, editable=False, null=True)),
                (
                    "role",
                    models.IntegerField(
                        choices=[
                            (0, "Viewer"),
                            (1, "Team Member"),
                            (2, "Resource Manager"),
                            (3, "Project Manager"),
                            (4, "Project Admin"),
                        ]
                    ),
                ),
                (
                    "program",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="memberships",
                        to="projects.program",
                    ),
                ),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="program_memberships",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "access_program_membership",
                "unique_together": {("program", "user")},
            },
        ),
    ]
