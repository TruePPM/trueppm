"""``manage.py revoke_api_tokens`` — the operator's API-token breach-recovery lever (#2878).

**Why this exists.** ``administration/security.md`` told operators that rotating the JWT
signing key after a suspected token leak or an admin off-boarding signs everyone out. It
does — for sessions and JWTs. An API token is resolved by a SHA-256 hash lookup
(``apps/projects/authentication.py``), carries no signature, and is completely untouched
by key rotation: after following the documented procedure to the letter, every leaked
token on the instance is still live, and nothing in the runbook said so. This command is
the missing half of that procedure.

**Scope is a required choice, not a default.** Exactly one of:

  * ``--user <username-or-email>`` — every *personal* token owned by one account. The
    off-boarding / "this person's laptop was stolen" case.
  * ``--all-personal`` — every personal token on the instance. The "our secret store
    leaked" case. Leaves project- and program-scoped integration tokens alone, so team
    CI keeps working.
  * ``--all`` — every token of every kind, including integration tokens. This *will*
    break every inbound sync until an admin re-mints; it is the full-compromise lever.

**Dry-run by default.** The command reports what it would revoke and exits; ``--commit``
performs the revocation, prompting for confirmation unless ``--yes`` is given. Revocation
is one-way — nothing in the codebase clears ``revoked_at`` — so a mistyped scope cannot
be undone, which is exactly why it does not act without being told twice.

Every revoked token gets an ``ApiTokenAuditEntry`` row with
``detail["reason"] = "operator_bulk_revoke"``, so the incident timeline can distinguish
an operator's containment sweep from a user's routine rotation. ``actor`` is null: a
command run from a shell has no Django user, and inventing one would be worse than
recording the absence.
"""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

REASON = "operator_bulk_revoke"


class Command(BaseCommand):
    help = "Revoke API tokens instance-wide or for one account (breach recovery, #2878)."

    def add_arguments(self, parser: Any) -> None:
        scope = parser.add_mutually_exclusive_group(required=True)
        scope.add_argument(
            "--user",
            type=str,
            help="Revoke every personal access token owned by this username or email.",
        )
        scope.add_argument(
            "--all-personal",
            action="store_true",
            help="Revoke every personal access token on the instance. Leaves project- "
            "and program-scoped integration tokens alone.",
        )
        scope.add_argument(
            "--all",
            action="store_true",
            help="Revoke EVERY API token, including project- and program-scoped "
            "integration tokens. Breaks all inbound sync until re-minted.",
        )
        parser.add_argument(
            "--commit",
            action="store_true",
            help="Actually revoke. Without this the command only reports.",
        )
        parser.add_argument(
            "--yes",
            action="store_true",
            help="Skip the interactive confirmation (for use in a runbook script).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        from trueppm_api.apps.projects.models import (
            ApiToken,
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )

        target_user = None
        if options["user"]:
            User = get_user_model()
            identifier = str(options["user"]).strip()
            # Accept either handle so a runbook does not have to know which the operator
            # has to hand during an incident.
            target_user = User.objects.filter(
                Q(username__iexact=identifier) | Q(email__iexact=identifier)
            ).first()
            if target_user is None:
                raise CommandError(f"No account matches {identifier!r} by username or email.")

        active = ApiToken.objects.filter(is_deleted=False, revoked_at__isnull=True)
        if target_user is not None:
            queryset = active.filter(owner=target_user)
            scope_label = f"personal tokens owned by {target_user.username}"
        elif options["all_personal"]:
            queryset = active.filter(owner__isnull=False)
            scope_label = "all personal access tokens on this instance"
        else:
            queryset = active
            scope_label = "ALL API tokens on this instance (including integration tokens)"

        doomed = list(queryset.only("pk", "token_prefix", "name", "owner", "project", "program"))
        self.stdout.write(f"Scope: {scope_label}")
        self.stdout.write(f"Active tokens matched: {len(doomed)}")
        for token in doomed:
            kind = "personal" if token.owner_id else ("project" if token.project_id else "program")
            self.stdout.write(f"  {token.token_prefix}… ({kind}) {token.name}")

        if not doomed:
            self.stdout.write(self.style.SUCCESS("Nothing to revoke."))
            return

        if not options["commit"]:
            self.stdout.write(
                self.style.WARNING("Dry run — nothing revoked. Re-run with --commit to apply.")
            )
            return

        if not options["yes"]:
            answer = input(f"Revoke {len(doomed)} token(s)? This cannot be undone. [y/N] ")
            if answer.strip().lower() not in ("y", "yes"):
                raise CommandError("Aborted.")

        now = timezone.now()
        with transaction.atomic():
            revoked = ApiToken.objects.filter(pk__in=[token.pk for token in doomed]).update(
                revoked_at=now
            )
            # One audit row per token, in the same transaction as the revocation, so the
            # sweep and its record commit together. The scope XOR on ApiTokenAuditEntry
            # requires exactly one of owner/project/program, mirroring the token's own.
            ApiTokenAuditEntry.objects.bulk_create(
                [
                    ApiTokenAuditEntry(
                        owner_id=token.owner_id,
                        project_id=token.project_id,
                        program_id=token.program_id,
                        token=token,
                        token_prefix=token.token_prefix,
                        actor=None,
                        action=ApiTokenAuditAction.REVOKED.value,
                        detail={"name": token.name, "reason": REASON},
                    )
                    for token in doomed
                ]
            )

        self.stdout.write(self.style.SUCCESS(f"Revoked {revoked} token(s)."))
        self.stdout.write(
            "Sessions and JWTs are a separate credential class — rotate JWT_SIGNING_KEY "
            "as well if you have not already (administration/security.md)."
        )
