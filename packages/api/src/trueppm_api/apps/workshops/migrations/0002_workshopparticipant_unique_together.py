"""Add unique_together(session, user) to WorkshopParticipant."""

from __future__ import annotations

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("workshops", "0001_initial"),
    ]

    operations = [
        migrations.AlterUniqueTogether(
            name="workshopparticipant",
            unique_together={("session", "user")},
        ),
    ]
