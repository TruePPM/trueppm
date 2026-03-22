"""Add soft-delete fields to Resource.

VersionedModel gained is_deleted and deleted_version in the projects 0004
migration. Resource extends VersionedModel and needs the same columns so
the schema matches the model definition. TaskResource extends models.Model
directly and does not need these fields.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("resources", "0002_alter_uuid_pk_serialize_false"),
    ]

    operations = [
        migrations.AddField(
            model_name="resource",
            name="is_deleted",
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.AddField(
            model_name="resource",
            name="deleted_version",
            field=models.BigIntegerField(blank=True, editable=False, null=True),
        ),
    ]
