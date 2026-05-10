"""Seed minimal fixtures for the web:integration Playwright CI job.

Creates a deterministic user, project, membership, and one task so integration
tests have stable credentials and a real API surface to exercise.

Idempotent — re-running clears and re-seeds so CI always starts clean.

Environment variables:
    INTEGRATION_USER_EMAIL     default: ci@trueppm.test
    INTEGRATION_USER_PASSWORD  default: ci-integration-pw
"""

from __future__ import annotations

import os
from datetime import date

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

_EMAIL = os.environ.get("INTEGRATION_USER_EMAIL", "ci@trueppm.test")
_PASSWORD = os.environ.get("INTEGRATION_USER_PASSWORD", "ci-integration-pw")
_PROJECT_NAME = "CI Integration Project"


class Command(BaseCommand):
    """Seed integration-test user, project, and one task (idempotent)."""

    help = "Seed minimal fixtures for the web:integration CI job."

    @transaction.atomic
    def handle(self, *args: object, **options: object) -> None:
        """Create or reset the integration fixture set."""
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.models import Calendar, Project, Task

        User = get_user_model()

        # The frontend login form posts {username: email} (the default Django
        # User model has USERNAME_FIELD="username"), so the seeded user's
        # username MUST equal its email — otherwise SimpleJWT returns 401 on
        # every login attempt and every integration test fails at step one.
        user, _ = User.objects.update_or_create(
            email=_EMAIL,
            defaults={"username": _EMAIL},
        )
        user.set_password(_PASSWORD)
        user.save(update_fields=["password"])

        # Idempotent project reset. Order matters: ProjectMembership.project is
        # PROTECT (must clear memberships first), Task.project is CASCADE (auto-
        # deletes with the project, but explicit delete is harmless), and
        # Project.calendar is PROTECT (calendars must be deleted *after* their
        # projects, not before — reversed order raises ProtectedError).
        prior = Project.objects.filter(name=_PROJECT_NAME)
        if prior.exists():
            calendar_ids = list(prior.values_list("calendar_id", flat=True))
            ProjectMembership.objects.filter(project__in=prior).delete()
            Task.objects.filter(project__in=prior).delete()
            prior.delete()
            Calendar.objects.filter(id__in=[cid for cid in calendar_ids if cid]).delete()

        cal = Calendar.objects.create(name=f"{_PROJECT_NAME} calendar")
        project = Project.objects.create(
            name=_PROJECT_NAME,
            start_date=date.today(),
            calendar=cal,
        )
        ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)

        # One seed task so the schedule view renders a non-empty state on first load.
        Task.objects.create(
            project=project,
            name="CI Seed Task",
            duration=1,
            wbs_path="1",
        )

        self.stdout.write(
            self.style.SUCCESS(f"Integration fixtures seeded (project pk={project.pk})")
        )
        self.stdout.write(f"  user:    {_EMAIL}")
        self.stdout.write(f"  project: {_PROJECT_NAME!r}")
