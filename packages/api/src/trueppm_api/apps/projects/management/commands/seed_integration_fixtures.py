"""Seed minimal fixtures for the web:integration Playwright CI job.

Creates a deterministic user, project, membership, and one task so integration
tests have stable credentials and a real API surface to exercise.

Idempotent — re-running clears and re-seeds so CI always starts clean.

Environment variables:
    INTEGRATION_USER_EMAIL     default: ci@trueppm.test
    INTEGRATION_USER_PASSWORD  resolved password (see _resolve_integration_password)
"""

from __future__ import annotations

import os
import secrets
from datetime import date

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

_EMAIL = os.environ.get("INTEGRATION_USER_EMAIL", "ci@trueppm.test")
_MEMBER_EMAIL = "ci-member@trueppm.test"
_NONMEMBER_EMAIL = "ci-nonmember@trueppm.test"
_PROJECT_NAME = "CI Integration Project"

# Env var an operator (or CI) sets to choose a known fixture password. When
# unset, the password is the static default below under DEBUG (local-dev
# convenience) and a random token otherwise — never a fixed, guessable password
# on a public instance (#1375, residual of #1350). The CI job exports this
# variable, so the deterministic credential survives there without DEBUG.
INTEGRATION_PASSWORD_ENV = "INTEGRATION_USER_PASSWORD"
_DEBUG_DEFAULT_PASSWORD = "ci-integration-pw"  # only honored under settings.DEBUG


def _resolve_integration_password() -> tuple[str, str]:
    """Resolve the integration fixture password and its source.

    The seeded accounts are real, loginable users, so a fixed weak password must
    never reach a public (non-DEBUG) instance (#1375). Returns
    ``(password, source)`` where ``source`` is one of ``"env"``, ``"debug"``, or
    ``"generated"`` — the caller uses it to decide whether the value is safe to
    echo and whether a destructive re-seed should proceed. Resolution order:

      1. ``INTEGRATION_USER_PASSWORD`` env var, if set — operator/CI opt-in to a
         known value (the CI job exports it);
      2. the static ``ci-integration-pw`` default when ``settings.DEBUG`` is on —
         local-dev convenience, where the instance is not internet-reachable;
      3. a random URL-safe token otherwise, printed once at seed time.
    """
    env_password = os.environ.get(INTEGRATION_PASSWORD_ENV)
    if env_password:
        return env_password, "env"
    if settings.DEBUG:
        return _DEBUG_DEFAULT_PASSWORD, "debug"
    return secrets.token_urlsafe(16), "generated"


class Command(BaseCommand):
    """Seed integration-test user, project, and one task (idempotent)."""

    help = "Seed minimal fixtures for the web:integration CI job."

    def add_arguments(self, parser: object) -> None:
        parser.add_argument(  # type: ignore[attr-defined]
            "--force",
            action="store_true",
            help=(
                "Allow the destructive re-seed to run even when a throwaway "
                "password would be generated (DEBUG off and no env override)."
            ),
        )

    @transaction.atomic
    def handle(self, *args: object, **options: object) -> None:
        """Create or reset the integration fixture set."""
        from trueppm_api.apps.access.models import ProjectMembership, Role
        from trueppm_api.apps.projects.models import Calendar, Project, Task

        password, password_source = _resolve_integration_password()
        # Prod guard (#1375): this command clears and re-seeds the fixture
        # project — destructive. On a non-DEBUG instance with no env override the
        # only resolvable password is a useless random throwaway, so refuse to
        # wipe data unless the operator explicitly opts in with --force.
        if password_source == "generated" and not options.get("force"):
            raise CommandError(
                "Refusing to seed integration fixtures on a non-DEBUG instance "
                "without a password. This command clears and re-seeds the CI "
                f"fixture project and would delete data. Set {INTEGRATION_PASSWORD_ENV} "
                "(as the CI job does) or pass --force to override."
            )

        User = get_user_model()

        # The frontend login form posts {username: email} (the default Django
        # User model has USERNAME_FIELD="username"), so the seeded user's
        # username MUST equal its email — otherwise SimpleJWT returns 401 on
        # every login attempt and every integration test fails at step one.
        # get-or-create-ok: CI seed command, fixed constant fixture email — no duplicate reachable
        user, _ = User.objects.update_or_create(
            email=_EMAIL,
            defaults={"username": _EMAIL},
        )
        # CI integration fixture: the password is resolved by
        # _resolve_integration_password (env var > DEBUG default > random token),
        # not an interactive-signup path — password validators do not apply (same
        # for the two member fixtures below).
        # nosemgrep: unvalidated-password
        user.set_password(password)
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
        # OWNER so integration tests can exercise the full member-management UI
        ProjectMembership.objects.create(project=project, user=user, role=Role.OWNER)

        # Second user — project member; used by E2E to verify member list
        # get-or-create-ok: CI seed command, fixed constant fixture email — no duplicate reachable
        ci_member, _ = User.objects.update_or_create(
            email=_MEMBER_EMAIL,
            defaults={"username": _MEMBER_EMAIL},
        )
        # nosemgrep: unvalidated-password
        ci_member.set_password(password)
        ci_member.save(update_fields=["password"])
        ProjectMembership.objects.create(project=project, user=ci_member, role=Role.MEMBER)

        # Third user — has an account but no project membership; used by E2E
        # member-search tests to find a user and add them to the project
        # get-or-create-ok: CI seed command, fixed constant fixture email — no duplicate reachable
        ci_nonmember, _ = User.objects.update_or_create(
            email=_NONMEMBER_EMAIL,
            defaults={"username": _NONMEMBER_EMAIL},
        )
        # nosemgrep: unvalidated-password
        ci_nonmember.set_password(password)
        ci_nonmember.save(update_fields=["password"])

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
        # Only echo the value when it cannot be recovered elsewhere (the generated
        # random token) or is the well-known dev default. A password supplied via
        # INTEGRATION_USER_PASSWORD is already in the operator's/CI secret store, so
        # it is not re-emitted into stdout / container logs (#1375).
        if password_source == "env":
            self.stdout.write(f"  password set via {INTEGRATION_PASSWORD_ENV}")
        else:
            self.stdout.write(f"  password: {password!r}")
