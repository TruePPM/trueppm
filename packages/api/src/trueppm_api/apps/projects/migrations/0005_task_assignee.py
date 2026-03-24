"""Add assignee FK to Task for issue #11 (5-role RBAC).

Nullable FK to AUTH_USER_MODEL so that Team Members can be assigned tasks
and IsProjectMemberWriteOrOwn can enforce the assignee-scoped write rule.
on_delete=SET_NULL preserves the task when a user is removed.
"""

from __future__ import annotations

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0004_soft_delete_and_dependency_versioned"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="assignee",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="assigned_tasks",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
