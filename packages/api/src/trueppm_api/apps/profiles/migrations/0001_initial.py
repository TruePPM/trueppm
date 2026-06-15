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
            name="UserProfile",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4, editable=False, primary_key=True, serialize=False
                    ),
                ),
                (
                    "default_landing",
                    models.CharField(
                        choices=[
                            ("auto", "Automatic (based on your role)"),
                            ("my_work", "My Work"),
                            ("project_overview", "Project Overview"),
                            ("portfolio", "Portfolio"),
                        ],
                        default="auto",
                        help_text=(
                            "Which screen the app opens on. 'auto' uses the role-based policy."
                        ),
                        max_length=20,
                    ),
                ),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="profile",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "verbose_name": "user profile",
                "verbose_name_plural": "user profiles",
            },
        ),
    ]
