# Hand-written migration: rename ProjectApiToken → ApiToken and add polymorphic
# program scope (ADR-0076 extension). The auto-generated `makemigrations` output
# proposed a destructive Delete + Create cycle because the Python class name
# changed but the `db_table` stayed at `projects_api_token`. RenameModel keeps
# every row and every FK intact and is the correct operation for this case.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0038_taskcomment_commentreaction_commentacknowledgement_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # 1. Rename the model. db_table stays `projects_api_token` (Meta on the
        #    new class declares it explicitly) so no SQL ALTER TABLE runs; this
        #    is a pure state migration. All FKs (InboundTaskLink, ApiTokenAuditEntry)
        #    are updated to point at the new model in one atomic step.
        migrations.RenameModel(
            old_name="ProjectApiToken",
            new_name="ApiToken",
        ),
        # 2. Make the existing project FK nullable so program-scoped tokens can
        #    omit it. Existing rows keep their project_id; no data backfill.
        migrations.AlterField(
            model_name="apitoken",
            name="project",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Set when the token authorizes writes into a single project. "
                    "Exactly one of project/program is non-null (DB constraint)."
                ),
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="api_tokens",
                to="projects.project",
            ),
        ),
        # 3. Add the new program FK. Nullable; existing rows get NULL which
        #    satisfies the XOR constraint (since all existing rows have project
        #    set, the XOR holds).
        migrations.AddField(
            model_name="apitoken",
            name="program",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Set when the token authorizes writes into any project "
                    "within this program. Exactly one of project/program is "
                    "non-null (DB constraint)."
                ),
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="api_tokens",
                to="projects.program",
            ),
        ),
        # 4. Composite index on (program, revoked_at) to mirror the existing
        #    (project, revoked_at) index — supports program-scoped lookups.
        migrations.AddIndex(
            model_name="apitoken",
            index=models.Index(
                fields=["program", "revoked_at"],
                name="projects_ap_program_315712_idx",
            ),
        ),
        # 5. XOR constraint: exactly one of project / program is non-null.
        #    Enforces the polymorphic-scope invariant at the database layer.
        migrations.AddConstraint(
            model_name="apitoken",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(project__isnull=False, program__isnull=True)
                    | models.Q(project__isnull=True, program__isnull=False)
                ),
                name="api_token_scope_xor",
            ),
        ),
    ]
