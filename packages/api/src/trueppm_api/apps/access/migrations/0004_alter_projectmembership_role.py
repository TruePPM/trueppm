"""Update Role choices labels for issue #11.

Ordinal values are unchanged (no data migration); Django stores choice labels
in the migration state so this AlterField is required to keep makemigrations clean.

Old labels: Member, Scheduler, Admin, Owner
New labels: Team Member, Resource Manager, Project Manager, Project Admin
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("access", "0003_projectmembership_soft_delete"),
    ]

    operations = [
        migrations.AlterField(
            model_name="projectmembership",
            name="role",
            field=models.IntegerField(
                choices=[
                    (0, "Viewer"),
                    (1, "Team Member"),
                    (2, "Resource Manager"),
                    (3, "Project Manager"),
                    (4, "Project Admin"),
                ]
            ),
        ),
    ]
