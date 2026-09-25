"""Load a bundled sample project (issue #375).

Usage::

    python manage.py load_sample_project [--sample <key>] [--owner <username>]
                                         [--with-personas]

Imports a bundled sample seed (default: the Atlas hybrid-large launch demo) and
flags its projects as sample data. Idempotent — re-running replaces the sample.

``--with-personas`` additionally gives the sample's persona accounts a usable
login password so an evaluator can sign in *as* each persona (Alex the PM, Sarah
the sponsor, …) rather than only viewing their work. The password is resolved the
same way the demo seeds resolve it (#1350): ``TRUEPPM_DEMO_PASSWORD`` if set, else
``"demo"`` under ``DEBUG``, else a random token printed once — so a fixed weak
password can never silently reach a public instance. Without the flag the personas
are created with unusable passwords, exactly as before.

Because the load is idempotent, the flag applies to persona accounts a previous run
already created, not only to rows this run mints (#3484). It still never overwrites
a password a real user set, and never touches a staff/superuser account — and the
report lists only the accounts the printed password verifiably opens, naming any it
refused, so the command cannot claim a login state it did not produce.

Interactive demo mode (ADR-1197 D5, #3925) uses a *different* path. ``--with-personas``
is refused outright while ``settings.DEMO_READ_ONLY`` is on, because it passwords
**every** persona in the pack with one shared secret and its only refusals are staff
and superuser rows — a persona holding a project or program ``OWNER``/``ADMIN`` role
gets the password too, so publishing it would publish a Project Admin credential.
Instead, ``TRUEPPM_DEMO_LOGIN_USERNAME`` + ``TRUEPPM_DEMO_LOGIN_PASSWORD`` enable
exactly one named account, and only after proving that account holds no
``ADMIN``/``OWNER`` role anywhere and looks like a row this sample seeded rather
than a real user who happens to share the username.
"""

from __future__ import annotations

import os
import secrets
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Project
from trueppm_api.apps.projects.seed.demo_landing_overlay import (
    DemoOverlayFixtureMismatch,
    apply_demo_landing_overlay,
)
from trueppm_api.apps.projects.seed.samples import (
    DEFAULT_SAMPLE,
    SAMPLES,
    UnknownSampleError,
    load_sample,
    sample_accounts,
)
from trueppm_api.apps.workspace.models import WorkspaceRole
from trueppm_api.apps.workspace.permissions import workspace_role_for_user

User = get_user_model()

DEMO_PASSWORD_ENV = "TRUEPPM_DEMO_PASSWORD"

#: The interactive demo's single published login (#3925). Both must be set together.
#: The chart renders this pair onto the demo seed Job and the reset CronJob. The api
#: Deployment gets a different variable, ``TRUEPPM_DEMO_LOGIN_HINT``, whose value is
#: "<username> / <password>" — so the password *is* on the api pod, deliberately: it
#: is published on the login page by design (#3926 serves it from the unauthenticated
#: GET /api/v1/edition/). Nothing here is confidential; do not reason about it as if
#: it were.
DEMO_LOGIN_USERNAME_ENV = "TRUEPPM_DEMO_LOGIN_USERNAME"
DEMO_LOGIN_PASSWORD_ENV = "TRUEPPM_DEMO_LOGIN_PASSWORD"


class Command(BaseCommand):
    help = "Load a bundled sample project into the database."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--sample",
            default=DEFAULT_SAMPLE,
            help=f"Sample key to load. Known: {sorted(SAMPLES)}. Default: {DEFAULT_SAMPLE}.",
        )
        parser.add_argument(
            "--owner",
            help="Username to own the sample program. Defaults to the first superuser.",
        )
        parser.add_argument(
            "--with-personas",
            action="store_true",
            help=(
                "Give the sample's persona accounts a usable login password so you "
                "can sign in as each one. Password: $TRUEPPM_DEMO_PASSWORD, else "
                "'demo' under DEBUG, else a random token printed once."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        sample_key = options["sample"]
        with_personas = options["with_personas"]

        # Fail BEFORE the import, not after (ADR-1197 D5). In demo read-only mode the
        # seed Job's exit status is the Helm release's exit status, so refusing here
        # fails the install rather than leaving a public instance whose every persona —
        # including three that hold OWNER or ADMIN — shares one published password.
        if with_personas and settings.DEMO_READ_ONLY:
            raise CommandError(
                "--with-personas is refused while TRUEPPM_DEMO_READ_ONLY is on. It gives "
                "EVERY persona in the sample the same password and refuses only staff and "
                "superuser rows, so a persona holding a project or program OWNER/ADMIN "
                "role receives it too — publishing that password would publish a Project "
                f"Admin credential. Enable exactly one non-privileged account instead, via "
                f"{DEMO_LOGIN_USERNAME_ENV} + {DEMO_LOGIN_PASSWORD_ENV} (ADR-1197 D5)."
            )

        # Resolve the demo-login request before the import too, for the same reason:
        # a typo in the username, or one half of the env pair, is a refusal that costs
        # nothing to discover before any data is written. The checks that need the
        # imported rows (privilege, provenance) necessarily run afterwards.
        demo_login = self._resolve_demo_login_request(sample_key)

        owner = self._resolve_owner(options.get("owner"), sample_key)

        persona_password: str | None = None
        password_source: str | None = None
        if with_personas:
            persona_password, password_source = self._resolve_demo_password()

        try:
            program = load_sample(
                sample_key, owner=owner, create_users=True, persona_password=persona_password
            )
        except UnknownSampleError as exc:
            raise CommandError(str(exc)) from exc

        count = Project.objects.filter(program=program).count()
        self.stdout.write(
            self.style.SUCCESS(
                f"Loaded sample {program.name!r} with {count} project(s) (marked is_sample)."
            )
        )
        if with_personas:
            self._report_personas(sample_key, persona_password, password_source)
        else:
            self.stdout.write(
                "  Personas created with unusable passwords (view-only). "
                "Re-run with --with-personas to enable persona logins."
            )

        self._enable_demo_login(program, demo_login)
        self._apply_demo_landing_overlay(program, sample_key)

    def _apply_demo_landing_overlay(self, program: Any, sample_key: str) -> None:
        """Make the landing project readable on a first visit (#4050 Part B).

        Runs **only** on a read-only demo deployment, and **only** for the default
        sample — the overlay is written against ``atlas-platform-launch.json``'s rows
        and has nothing to say about another fixture.

        Placed here, after the import and after the demo login is enabled, because
        the overlay's last act is a Monte Carlo run that must outlive every other
        write for the forecast not to read as stale (see the module docstring). It is
        also why this is not folded into ``load_sample``: the overlay is a property of
        one *deployment mode*, not of loading a sample.

        A fixture mismatch is raised, not swallowed. The seed Job's exit status is the
        Helm release's exit status, so a rename in the fixture fails the install rather
        than publishing a demo that is half-fixed with nothing in the log saying which
        half.
        """
        if not settings.DEMO_READ_ONLY:
            return
        if sample_key != DEFAULT_SAMPLE:
            self.stdout.write(
                f"  Demo landing overlay skipped: it is written against "
                f"{DEFAULT_SAMPLE!r} and this run loaded {sample_key!r}."
            )
            return

        try:
            result = apply_demo_landing_overlay(program)
        except DemoOverlayFixtureMismatch as exc:
            raise CommandError(
                f"Demo landing overlay could not be applied: {exc} "
                "(#4050 Part B — the overlay is fixture-coupled by design.)"
            ) from exc

        if result.was_noop:
            self.stdout.write("  Demo landing overlay: already applied; forecast re-run.")
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    "  Demo landing overlay applied: health override cleared, "
                    f"milestone confirmed, {result.unscheduled_removed} unscheduled "
                    "row(s) trimmed."
                )
            )
        self.stdout.write(
            f"    Behind-plan signal kept at WBS {result.behind_plan_task_wbs_path} "
            f"(task {result.behind_plan_task_id})."
        )
        self.stdout.write(
            f"    Forecast P80 {result.p80.isoformat()} vs commitment "
            f"{result.commitment_finish.isoformat()}."
        )

    def _report_personas(self, sample_key: str, password: str | None, source: str | None) -> None:
        """Print the persona usernames the printed password actually opens.

        This is the fix's payoff (#1760): the evaluation guide told readers to
        "Sign in as Alex", but the seeded username is ``atlas-alex`` and the
        password was unusable. Echo both so the walkthrough actually works.

        The list is built by **checking each account against the password we are
        about to print**, not by echoing the sample's ``accounts[]`` and trusting
        the import to have honored it. That is the #3484 defect: the importer only
        passworded rows it *created*, so every reload printed fifteen logins that
        did not work. The importer now covers pre-existing persona rows as well,
        but it still (correctly) refuses a real account that already has its own
        password and any staff/superuser row — so the report must be able to say
        so rather than assert a state the command did not produce.
        """
        accounts = sample_accounts(sample_key)
        usernames = [a.get("username", "") for a in accounts if a.get("username")]
        by_username = {u.username: u for u in User.objects.filter(username__in=usernames)}

        enabled: list[tuple[str, str]] = []
        refused: list[tuple[str, str]] = []
        for account in accounts:
            username = account.get("username", "")
            display = account.get("display_name", "")
            user = by_username.get(username)
            if user is not None and password is not None and user.check_password(password):
                enabled.append((username, display))
            else:
                refused.append((username, self._persona_refusal_reason(user)))

        # ``TRUEPPM_DEMO_PASSWORD`` (operator opt-in) and DEBUG's "demo" are safe to
        # echo; a randomly generated production token is also printed once because
        # there is no other way to recover it — but it is never a re-derivable value.
        if source == "env":
            detail = f"password set via {DEMO_PASSWORD_ENV}"
        else:
            detail = f"password={password!r}"

        if enabled:
            self.stdout.write(self.style.SUCCESS(f"  Persona logins enabled ({detail}):"))
            for username, display in enabled:
                self.stdout.write(f"    {username}  ({display})")
        else:
            self.stdout.write(self.style.WARNING("  No persona logins were enabled."))

        if refused:
            self.stdout.write(
                self.style.WARNING(
                    f"  {len(refused)} persona account(s) left untouched — "
                    f"the password above does not open them:"
                )
            )
            for username, reason in refused:
                self.stdout.write(f"    {username}  ({reason})")
            self.stdout.write(
                "  To take one of these over deliberately, set its password yourself: "
                "python manage.py changepassword <username>"
            )

    def _resolve_demo_login_request(self, sample_key: str) -> dict[str, str] | None:
        """Validate the demo-login env pair before anything is written (#3925).

        Everything checkable without the imported rows is checked here, so a typo or a
        half-set pair costs a refusal rather than a seeded-then-failed install. The
        checks that genuinely need the rows — privilege and provenance — cannot move.

        Returns:
            The resolved request, or ``None`` when neither variable is set.
        """
        username = (os.environ.get(DEMO_LOGIN_USERNAME_ENV) or "").strip()
        password = os.environ.get(DEMO_LOGIN_PASSWORD_ENV) or ""
        if not username and not password:
            return None
        if not username or not password:
            raise CommandError(
                f"{DEMO_LOGIN_USERNAME_ENV} and {DEMO_LOGIN_PASSWORD_ENV} must be set "
                "together — one without the other cannot open an account, and a demo "
                "that publishes a login hint nobody can use is a broken demo."
            )

        # The invariant lives HERE, not only in the Helm guard that has the same rule.
        # The chart is one caller; `kubectl exec ... manage.py load_sample_project`,
        # `docker compose run` and a CI seed step are not covered by a render-time
        # check, and on a writable instance this account's MEMBER role plus an open
        # `POST /projects/` is a self-granted OWNER.
        if not settings.DEMO_READ_ONLY:
            raise CommandError(
                f"{DEMO_LOGIN_USERNAME_ENV} is set but TRUEPPM_DEMO_READ_ONLY is not on. "
                "That would publish a working login to a WRITABLE instance, which is "
                "worse than publishing none: any authenticated user may POST /projects/ "
                "and is made its OWNER. Arm the read-only fence, or unset the pair."
            )

        account = next(
            (a for a in sample_accounts(sample_key) if a.get("username") == username), None
        )
        if account is None:
            raise CommandError(
                f"{DEMO_LOGIN_USERNAME_ENV}={username!r} is not one of sample "
                f"{sample_key!r}'s accounts. Only an account the sample itself seeds may "
                "be enabled: anything else is a pre-existing real user whose password "
                "this command must never set."
            )
        return {
            "username": username,
            "password": password,
            "email": account.get("email", "") or "",
        }

    def _enable_demo_login(self, program: Any, request: dict[str, str] | None) -> None:
        """Give ONE named sample account a usable password (ADR-1197 D5, #3925).

        This is the interactive demo's published credential, so every failure here is
        a ``CommandError``: the seed Job is a Helm hook, so raising fails the release
        rather than publishing a login hint for an account that does not exist, or --
        worse -- quietly passwording an account that is not ours to password.

        Two questions have to be answered, and the sample pack can answer neither:

        **Is it privileged?** Read the membership rows this import produced, not the
        pack's declared roles -- the roster in the JSON is a claim about the seed, the
        rows are what the API enforces. The query is deliberately NOT scoped to this
        program: a role held somewhere else is exactly as published as a role held
        here, and scoping the check to one program is how it would miss that.

        **Is it ours?** ``SeedImporter._resolve_accounts`` binds an account by bare
        username, so a pre-existing real user who happens to hold a sample username is
        adopted by the import. ``has_usable_password()`` -- the guard the persona path
        uses -- cannot be reused here, because the scheduled reset must re-apply the
        password on every run and a rotated credential must be able to land. Provenance
        is asserted instead: a seeded row carries the pack's own email and holds
        memberships in this program and nowhere else.

        Residual, stated rather than hidden: a pre-existing account that shares the
        sample's username AND its ``@atlas.example`` email AND holds no membership
        outside this program would still be passworded. Never point
        ``demo.loginHint.username`` at an instance that has real users.
        """
        if request is None:
            return
        username = request["username"]
        password = request["password"]

        user = User.objects.filter(username=username).first()
        if user is None:
            raise CommandError(
                f"{DEMO_LOGIN_USERNAME_ENV}={username!r} names a sample account that does "
                "not exist after the load. The seed did not produce it — refusing to "
                "report a demo login that cannot work."
            )
        if user.is_staff or user.is_superuser:
            raise CommandError(
                f"Refusing to set a published password on {username!r}: it is a staff or "
                "superuser account."
            )

        if (
            ProjectMembership.objects.filter(
                user=user, is_deleted=False, role__gte=Role.ADMIN
            ).exists()
            or ProgramMembership.objects.filter(
                user=user, is_deleted=False, role__gte=Role.ADMIN
            ).exists()
        ):
            raise CommandError(
                f"Refusing to set a published password on {username!r}: it holds an "
                "ADMIN or OWNER role on some project or program. The interactive demo's "
                "credential is public, and the read-only fence is a deployment property "
                "that a future misconfiguration can remove — a published Project Admin "
                "login would then be a full write credential (ADR-1197 D5)."
            )

        # The third privilege axis, and the one a project/program sweep cannot see.
        # A seeded persona holds no WorkspaceMembership row and therefore resolves to
        # the implicit MEMBER, so the bundled pack passes — but an operator who granted
        # this account workspace ADMIN on a long-lived demo instance has handed it the
        # exfil and irreversible surfaces behind IsWorkspaceAdminStrict, and neither
        # membership query above would notice.
        workspace_role = workspace_role_for_user(user)
        if workspace_role is not None and workspace_role >= WorkspaceRole.ADMIN:
            raise CommandError(
                f"Refusing to set a published password on {username!r}: it holds "
                "workspace ADMIN or higher, which gates the export and irreversible "
                "surfaces regardless of any project role (ADR-1197 D5)."
            )

        foreign = (
            ProjectMembership.objects.filter(user=user, is_deleted=False)
            .exclude(project__program=program)
            .exists()
            or ProgramMembership.objects.filter(user=user, is_deleted=False)
            .exclude(program=program)
            .exists()
        )
        if foreign or (request["email"] and user.email != request["email"]):
            raise CommandError(
                f"Refusing to set a published password on {username!r}: it does not look "
                "like an account this sample seeded (it holds membership outside this "
                "program, or its email is not the pack's). A real user who happens to "
                "share a sample username must never have their password replaced by a "
                "published one."
            )

        if user.check_password(password):
            # Already correct — a reset re-running the identical seed. Skip the write
            # so a no-op run does not churn the password hash.
            self.stdout.write(f"  Interactive demo login for {username!r} already current.")
            return

        # A seeded persona, not an interactive signup, so the password validators that
        # govern real sign-ups do not apply; the value is an operator's own choice.
        # nosemgrep: unvalidated-password
        user.set_password(password)
        user.save(update_fields=["password"])
        self.stdout.write(
            self.style.SUCCESS(
                f"  Interactive demo login enabled for {username!r} "
                "(password from the environment; not echoed)."
            )
        )

    @staticmethod
    def _persona_refusal_reason(user: Any) -> str:
        """Why a persona account is not openable with the password just printed."""
        if user is None:
            return "no such account"
        if user.is_staff or user.is_superuser:
            return "privileged account — never re-passworded"
        if user.has_usable_password():
            return "pre-existing account with its own password"
        return "password not applied"

    def _resolve_demo_password(self) -> tuple[str, str]:
        """Resolve the persona login password and its source (mirrors #1350).

        A fixed weak password must never reach a public (non-DEBUG) instance.
        Resolution order: ``TRUEPPM_DEMO_PASSWORD`` env var, then ``"demo"`` under
        ``DEBUG``, else a random token printed once so the operator can record it.
        """
        env_password = os.environ.get(DEMO_PASSWORD_ENV)
        if env_password:
            return env_password, "env"
        if settings.DEBUG:
            return "demo", "debug"
        return secrets.token_urlsafe(16), "generated"

    def _resolve_owner(self, username: str | None, sample_key: str) -> Any:
        """Resolve the program owner: explicit user, then superuser, then the sample's own.

        The third fallback exists for the hosted demo (#3098). ``seed_demo_project``
        built its own persona accounts and owned the program with one of them, so
        the demo deployment never created a superuser — and it must not, because
        the read-only posture (ADR-0658) rests on there being no login-capable
        account at all. Requiring a superuser here would have made the demo stack
        fail to boot the moment it swapped to this command.

        The account is created with an **unusable** password, exactly like every
        other persona this command creates without ``--with-personas``, so the
        zero-login posture is preserved.
        """
        if username:
            owner = User.objects.filter(username=username).first()
            if owner is None:
                raise CommandError(f"No user with username {username!r}.")
            return owner
        owner = User.objects.filter(is_superuser=True).order_by("pk").first()
        if owner is not None:
            return owner

        try:
            accounts = sample_accounts(sample_key)
        except UnknownSampleError as exc:
            raise CommandError(str(exc)) from exc
        lead = next(
            (a for a in accounts if a.get("role") == "OWNER"),
            accounts[0] if accounts else None,
        )
        if lead is None:
            raise CommandError(
                "No superuser to own the sample and the sample declares no accounts. "
                "Pass --owner <username> or create a superuser."
            )
        owner, created = User.objects.get_or_create(
            username=lead["username"],
            defaults={
                "email": lead.get("email", ""),
                "first_name": (lead.get("display_name") or "").split(" ")[0],
                "last_name": " ".join((lead.get("display_name") or "").split(" ")[1:]),
            },
        )
        if created:
            # Unusable password (a sentinel hash, not a credential) — this is a
            # seeded persona, not an interactive signup, so validators do not apply.
            # nosemgrep: unvalidated-password
            owner.set_password(None)
            owner.save(update_fields=["password"])
        # Read the state back rather than asserting the create branch's intent: on a
        # reload the row already exists and this never touched it, so hard-coding
        # "(unusable password)" was the same false claim as #3484's persona report.
        state = "usable password" if owner.has_usable_password() else "unusable password"
        self.stdout.write(
            f"No superuser found; owning the sample with its own persona "
            f"{lead['username']!r} ({state})."
        )
        return owner
