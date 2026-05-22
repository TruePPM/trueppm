"""Initial migration for ``apps.integrations`` — ``IntegrationCredential`` only.

``TaskLink`` (#637), the outgoing webhook ``format`` field (#638), and
``UserNotificationPreference`` table extensions (#639) ship in successor
migrations that depend on this 0001 baseline.
"""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="IntegrationCredential",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("provider", models.CharField(max_length=32)),
                ("secret_ciphertext", models.BinaryField()),
                ("base_url", models.CharField(blank=True, default="", max_length=512)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("last_used_at", models.DateTimeField(blank=True, null=True)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="integration_credentials",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "Integration credential",
                "verbose_name_plural": "Integration credentials",
                "ordering": ("provider",),
            },
        ),
        migrations.AddConstraint(
            model_name="integrationcredential",
            constraint=models.UniqueConstraint(
                fields=("user", "provider"),
                name="integrations_credential_unique_per_user_provider",
            ),
        ),
    ]
