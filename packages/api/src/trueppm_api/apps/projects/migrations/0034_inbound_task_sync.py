"""Inbound task-sync — ProjectApiToken, InboundTaskLink, ApiTokenAuditEntry (ADR-0068 / #500)."""

from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0033_task_my_work_index"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="ProjectApiToken",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                (
                    "name",
                    models.CharField(
                        help_text="Human-readable label (e.g. 'Jira Production').  Not unique.",
                        max_length=128,
                    ),
                ),
                (
                    "token_prefix",
                    models.CharField(
                        db_index=True,
                        help_text="First 8 hex chars of the raw token (for audit identification).",
                        max_length=8,
                    ),
                ),
                (
                    "token_hash",
                    models.CharField(
                        help_text="SHA-256 hex digest of the raw token.",
                        max_length=64,
                        unique=True,
                    ),
                ),
                (
                    "status_map",
                    models.JSONField(
                        blank=True,
                        default=dict,
                        help_text=(
                            "Maps external source-status strings → TaskStatus values.  "
                            "Empty dict falls back to the default map: "
                            "{'todo': 'NOT_STARTED', 'in_progress': 'IN_PROGRESS', "
                            "'done': 'COMPLETE'}."
                        ),
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "last_used_at",
                    models.DateTimeField(
                        blank=True,
                        help_text=(
                            "Updated by the authenticator on each successful inbound request."
                        ),
                        null=True,
                    ),
                ),
                (
                    "revoked_at",
                    models.DateTimeField(
                        blank=True,
                        db_index=True,
                        help_text=("Set when an Admin/PM revokes the token.  Non-null = inactive."),
                        null=True,
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="api_tokens_created",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="api_tokens",
                        to="projects.project",
                    ),
                ),
            ],
            options={
                "db_table": "projects_api_token",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="projectapitoken",
            index=models.Index(
                fields=["project", "revoked_at"],
                name="projects_ap_project_44b58a_idx",
            ),
        ),
        migrations.CreateModel(
            name="InboundTaskLink",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                ("server_version", models.BigIntegerField(default=0, editable=False)),
                ("is_deleted", models.BooleanField(db_index=True, default=False)),
                (
                    "deleted_version",
                    models.BigIntegerField(blank=True, editable=False, null=True),
                ),
                (
                    "source",
                    models.CharField(
                        help_text="External source key — 'jira', 'linear', 'github', 'custom'.",
                        max_length=32,
                    ),
                ),
                (
                    "external_id",
                    models.CharField(
                        help_text="The external system's identifier (e.g. 'PROJ-123').",
                        max_length=255,
                    ),
                ),
                (
                    "external_url",
                    models.URLField(
                        blank=True,
                        help_text="Optional canonical URL of the external task.",
                        max_length=2000,
                        null=True,
                    ),
                ),
                (
                    "parent_external_id",
                    models.CharField(
                        blank=True,
                        help_text="External system's parent identifier (e.g. Jira epic key).",
                        max_length=255,
                        null=True,
                    ),
                ),
                (
                    "pending_assignee_email",
                    models.EmailField(
                        blank=True,
                        help_text=(
                            "Set when assignee_email did not match a project member.  "
                            "Resolved on a subsequent push if the user joins the project."
                        ),
                        max_length=254,
                        null=True,
                    ),
                ),
                ("last_synced_at", models.DateTimeField(auto_now=True)),
                (
                    "created_via_token",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_links",
                        to="projects.projectapitoken",
                    ),
                ),
                (
                    "last_synced_via_token",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="projects.projectapitoken",
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inbound_links",
                        to="projects.project",
                    ),
                ),
                (
                    "task",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="inbound_links",
                        to="projects.task",
                    ),
                ),
            ],
            options={
                "db_table": "projects_inbound_task_link",
                "ordering": ["-last_synced_at"],
            },
        ),
        migrations.AddConstraint(
            model_name="inboundtasklink",
            constraint=models.UniqueConstraint(
                condition=models.Q(("is_deleted", False)),
                fields=("project", "source", "external_id"),
                name="uniq_inbound_link_per_source",
            ),
        ),
        migrations.AddIndex(
            model_name="inboundtasklink",
            index=models.Index(
                condition=models.Q(
                    ("is_deleted", False),
                    ("pending_assignee_email__isnull", False),
                ),
                fields=["project", "pending_assignee_email"],
                name="inbound_link_pending_idx",
            ),
        ),
        migrations.CreateModel(
            name="ApiTokenAuditEntry",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                (
                    "token_prefix",
                    models.CharField(
                        help_text="Denormalized — preserved after token deletion.",
                        max_length=8,
                    ),
                ),
                (
                    "action",
                    models.CharField(
                        choices=[("minted", "Minted"), ("revoked", "Revoked"), ("used", "Used")],
                        max_length=16,
                    ),
                ),
                ("source_ip", models.GenericIPAddressField(blank=True, null=True)),
                ("detail", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                (
                    "actor",
                    models.ForeignKey(
                        blank=True,
                        help_text=(
                            "The user who performed the action.  NULL for 'used' entries "
                            "(inbound requests have no Django user — the actor is the token "
                            "itself)."
                        ),
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "project",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="api_token_audit",
                        to="projects.project",
                    ),
                ),
                (
                    "token",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="audit_entries",
                        to="projects.projectapitoken",
                    ),
                ),
            ],
            options={
                "db_table": "projects_api_token_audit",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="apitokenauditentry",
            index=models.Index(
                fields=["project", "-created_at"],
                name="api_token_audit_proj_idx",
            ),
        ),
    ]
