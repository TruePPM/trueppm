"""``manage.py revoke_api_tokens`` — the operator's API-token breach-recovery lever (#2878).

**Why this exists.** ``administration/security.md`` told operators that rotating the JWT
signing key after a suspected token leak or an admin off-boarding signs everyone out. It
does — for sessions and JWTs. An API token is resolved by a SHA-256 hash lookup
(``apps/projects/authentication.py``), carries no signature, and is completely untouched
by key rotation: after following the documented procedure to the letter, every leaked
token on the instance is still live, and nothing in the runbook said so. This command is
the missing half of that procedure.

**Scope is a required choice, not a default.** Exactly one of:

  * ``--user <username-or-email>`` — every *personal* token owned by one account,
    **plus** (#4576) that account's refresh tokens, share links, git-automation
    webhook secret, outgoing webhooks, and live project WebSocket connections. The
    off-boarding / "this person's laptop was stolen" case — ``administration/
    management-commands.md`` documents this as the lever an operator runs for
    exactly that incident, so it must contain everything the account could still
    reach, not tokens alone. Named by account, regardless of whether that account
    currently owns any live personal token.
  * ``--all-personal`` — every personal token on the instance, plus (#4576) the
    same refresh-token / durable-grant / live-socket sweep for each account that
    owns one of the matched tokens. The "our secret store leaked" case. Leaves
    project- and program-scoped integration tokens alone, so team CI keeps
    working, and leaves alone any account that owns durable grants but no live
    personal token — ``--user`` is the lever for containing that account by name.
  * ``--all`` — every token of every kind, including integration tokens, **plus**
    every active share link, configured git-automation webhook secret, and
    registered outgoing webhook instance-wide (#2939, #4461) — the other three
    durable grants a leaked token or compromised session can mint that no other
    lever reaches. This *will* break every inbound sync, public share link, and
    outgoing webhook delivery until an admin re-mints/re-enables; it is the
    full-compromise lever.

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
            help="Revoke this account's personal access tokens, refresh tokens, share "
            "links, git-automation secret, outgoing webhooks, and live project "
            "sockets. Accepts username or email.",
        )
        scope.add_argument(
            "--all-personal",
            action="store_true",
            help="Revoke every personal access token on the instance, plus the refresh "
            "tokens, share links, git-automation secrets, outgoing webhooks, and "
            "live project sockets of each account that owns one. Leaves project- "
            "and program-scoped integration tokens, and accounts with no personal "
            "token, alone.",
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

    def _resolve_target_user(self, options: dict[str, Any]) -> Any | None:
        """The single account ``--user`` names, or None if ``--user`` was not given.

        Accepts either username or email so a runbook does not have to know which
        the operator has to hand during an incident.

        FAILS CLOSED on ambiguity. Django's stock ``auth.User`` puts **no**
        uniqueness constraint on ``email`` at all, and ``username`` uniqueness is
        case-*sensitive*, so ``__iexact`` can match several rows two ways. A
        ``.first()`` here would silently pick the lowest pk — during an incident,
        while reporting success — so the leaked token stays live and an uninvolved
        account's automations break instead. ``apps/sso/services.py`` and
        ``core/password_reset.py`` already treat this lookup as hazardous; this is
        the third caller and it must not be the one that guesses.
        """
        if not options["user"]:
            return None
        User = get_user_model()
        identifier = str(options["user"]).strip()
        candidates = list(
            User.objects.filter(
                Q(username__iexact=identifier) | Q(email__iexact=identifier)
            ).order_by("pk")[:3]
        )
        if not candidates:
            raise CommandError(f"No account matches {identifier!r} by username or email.")
        if len(candidates) > 1:
            listed = ", ".join(f"pk={u.pk} username={u.username!r}" for u in candidates)
            raise CommandError(
                f"{identifier!r} matches more than one account ({listed}). Re-run with "
                "an unambiguous username so the sweep cannot contain the wrong "
                "account."
            )
        return candidates[0]

    def _resolve_scope(self, options: dict[str, Any], target_user: Any | None) -> tuple[Any, str]:
        from trueppm_api.apps.projects.models import ApiToken

        active = ApiToken.objects.filter(is_deleted=False, revoked_at__isnull=True)
        if target_user is not None:
            label = f"personal tokens owned by {target_user.username}"
            return active.filter(owner=target_user), label
        if options["all_personal"]:
            return active.filter(owner__isnull=False), "all personal access tokens on this instance"
        return active, "ALL API tokens on this instance (including integration tokens)"

    def _report_matched_tokens(self, doomed: list[Any], scope_label: str) -> None:
        self.stdout.write(f"Scope: {scope_label}")
        self.stdout.write(f"Active tokens matched: {len(doomed)}")
        for token in doomed:
            kind = "personal" if token.owner_id else ("project" if token.project_id else "program")
            self.stdout.write(f"  {token.token_prefix}… ({kind}) {token.name}")

    def _grant_counts_for(self, user: Any | None) -> tuple[int, int, int]:
        """(share links, git-automation secrets, outgoing webhooks) matching ``user``.

        Read-only mirror of ``revoke_personal_durable_grants``'s own filters (#2939,
        #4461, #4576) — kept as a second copy rather than a shared helper because the
        service function performs the ``update()``, and a dry run must not touch a
        row it is only reporting on. ``user=None`` is the instance-wide population
        ``--all`` sweeps; a concrete user is one account's personal grants, used by
        ``--user``/``--all-personal``.
        """
        from trueppm_api.apps.integrations.models import BoardAutomation
        from trueppm_api.apps.projects.models import ShareLink
        from trueppm_api.apps.webhooks.models import Webhook

        links = ShareLink.objects.filter(revoked_at__isnull=True)
        secrets_qs = BoardAutomation.objects.exclude(secret_ciphertext=b"")
        webhooks_qs = Webhook.objects.filter(is_active=True)
        if user is not None:
            links = links.filter(created_by=user)
            secrets_qs = secrets_qs.filter(configured_by=user)
            webhooks_qs = webhooks_qs.filter(Q(created_by=user) | Q(editors__user=user))
        return links.count(), secrets_qs.count(), webhooks_qs.count()

    def _count_pending_invites(self, options: dict[str, Any], affected_users: list[Any]) -> int:
        """Read-only mirror of ``revoke_pending_workspace_invites``'s filter (#4589).

        ``--all`` counts every pending/failed invite instance-wide; ``--user`` and
        ``--all-personal`` count those minted by each affected account.
        """
        from trueppm_api.apps.workspace.models import InviteStatus, WorkspaceInvite

        live = WorkspaceInvite.objects.filter(
            status__in=(InviteStatus.PENDING, InviteStatus.FAILED)
        )
        if options["all"]:
            total = live.count()
        elif affected_users:
            total = live.filter(invited_by__in=affected_users).count()
        else:
            return 0
        self.stdout.write(f"Pending workspace invites matched: {total}")
        return total

    def _count_outstanding_refresh_tokens(self, user: Any) -> int:
        """Read-only mirror of ``revoke_all_refresh_tokens``'s filter, for dry-run counts."""
        try:
            from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
        except ImportError:  # pragma: no cover - only when the app is uninstalled
            return 0
        return OutstandingToken.objects.filter(user=user, blacklistedtoken__isnull=True).count()

    def _count_live_project_memberships(self, user_id: Any) -> int:
        """Read-only mirror of ``evict_all_live_project_sockets``'s filter.

        Counts projects the account holds a *live* membership in, i.e. the number
        of eviction broadcasts that call would schedule — not a live socket count,
        which the command has no way to observe.
        """
        from trueppm_api.apps.access.models import ProjectMembership

        return ProjectMembership.objects.filter(user_id=user_id, is_deleted=False).count()

    def _count_durable_grants(self, options: dict[str, Any]) -> tuple[int, int, int]:
        """(links_matched, secrets_matched, webhooks_matched) for ``--all``'s report.

        --all is the full-compromise lever: also sweep the three non-token durable
        grants a leaked token (or a compromised session) can mint (#2939, #4461).
        Counted ahead of --commit so a dry run reports the whole blast radius, not
        just the token count.
        """
        if not options["all"]:
            return 0, 0, 0
        links_matched, secrets_matched, webhooks_matched = self._grant_counts_for(None)
        self.stdout.write(f"Active share links matched: {links_matched}")
        self.stdout.write(f"Configured git-automation secrets matched: {secrets_matched}")
        self.stdout.write(f"Active outgoing webhooks matched: {webhooks_matched}")
        return links_matched, secrets_matched, webhooks_matched

    def _resolve_affected_users(
        self, options: dict[str, Any], target_user: Any | None, doomed: list[Any]
    ) -> list[Any]:
        """The account(s) this run also contains beyond their API tokens (#4576).

        ``--user`` always sweeps the one named account, whether or not it currently
        owns any live personal token — the operator is containing an *account* (the
        documented off-boarding / stolen-laptop lever), not a token population, and
        password reset (``core/password_reset.py``) and workspace off-boarding
        (``apps/workspace/views.py:_revoke_offboarded_credentials``) already sweep
        on that same basis.

        ``--all-personal`` has no independent "every user" population to draw on;
        its own scope is "every personal access token on the instance" (see the
        module docstring), so the accounts it sweeps for the other grant classes
        are exactly the owners of the personal tokens it is about to revoke. An
        account that owns durable grants but no live personal token sits outside
        ``--all-personal``'s stated scope — ``--user`` is the lever for containing
        it by name, ``--all`` the lever for the whole instance regardless of token
        ownership.

        ``--all`` already sweeps every grant instance-wide via
        ``revoke_personal_durable_grants(user=None)`` in ``_commit_revocation`` and
        must not be duplicated here, so it returns an empty list.
        """
        if target_user is not None:
            return [target_user]
        if options["all_personal"]:
            owner_ids = {token.owner_id for token in doomed if token.owner_id is not None}
            if not owner_ids:
                return []
            User = get_user_model()
            return list(User.objects.filter(pk__in=owner_ids).order_by("pk"))
        return []

    def _report_account_sweep(self, affected_users: list[Any]) -> tuple[int, int, int, int, int]:
        """Dry-run totals for the non-token sweep ``--user``/``--all-personal`` apply (#4576).

        Returns (refresh tokens, share links, git-automation secrets, outgoing
        webhooks, live project sockets) summed across every affected account, and
        prints each class's total the same way ``_count_durable_grants`` reports
        ``--all``'s instance-wide blast radius. One query set per affected account
        — acceptable here: this command runs interactively during incident
        response against a bounded, operator-named scope, not on a request path.
        """
        if not affected_users:
            return 0, 0, 0, 0, 0
        refresh_total = links_total = secrets_total = webhooks_total = sockets_total = 0
        for user in affected_users:
            refresh_total += self._count_outstanding_refresh_tokens(user)
            links, secrets_count, webhooks = self._grant_counts_for(user)
            links_total += links
            secrets_total += secrets_count
            webhooks_total += webhooks
            sockets_total += self._count_live_project_memberships(user.pk)
        self.stdout.write(f"Outstanding refresh tokens matched: {refresh_total}")
        self.stdout.write(f"Active share links matched: {links_total}")
        self.stdout.write(f"Configured git-automation secrets matched: {secrets_total}")
        self.stdout.write(f"Active outgoing webhooks matched: {webhooks_total}")
        self.stdout.write(f"Live project socket connections matched: {sockets_total}")
        return refresh_total, links_total, secrets_total, webhooks_total, sockets_total

    def _confirm(self, options: dict[str, Any], total: int) -> None:
        if options["yes"]:
            return
        answer = input(f"Revoke {total} grant(s)? This cannot be undone. [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            raise CommandError("Aborted.")

    def _commit_revocation(
        self, doomed: list[Any], affected_users: list[Any], options: dict[str, Any]
    ) -> tuple[int, int, int, int, int, int]:
        """Revoke `doomed`, audit each one, and sweep the other durable grant classes.

        Under ``--all`` this sweeps every grant instance-wide
        (``revoke_personal_durable_grants(user=None)``) — unchanged from before
        #4576. Under ``--user``/``--all-personal`` (#4576) it instead sweeps each
        ``affected_users`` account's refresh tokens, share links, git-automation
        secret, outgoing webhooks, and live project sockets — the same
        composition password reset (``core/password_reset.py``) and workspace
        off-boarding (``apps/workspace/views.py``) already use, so the documented
        off-boarding / stolen-laptop lever actually contains the account it names
        rather than leaving everything but its PATs live.

        Everything here runs inside one transaction — including the calls to
        ``revoke_all_refresh_tokens`` and ``revoke_personal_durable_grants``, both
        plain DB updates — so the token revocation, the sweep, and the audit trail
        commit or roll back together. ``evict_all_live_project_sockets`` is the one
        exception: it defers its own work with ``transaction.on_commit`` (mirrored
        from ``core/password_reset.py``), so a rolled-back run evicts nobody.

        Returns (tokens revoked, share links revoked, git-automation secrets
        cleared, outgoing webhooks deactivated, refresh tokens revoked, live
        project sockets scheduled for eviction). The last two are always 0 for
        ``--all`` and for a run with no affected accounts.
        """
        from trueppm_api.apps.projects.models import (
            ApiToken,
            ApiTokenAuditAction,
            ApiTokenAuditEntry,
        )

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
            links_revoked = secrets_cleared = webhooks_deactivated = 0
            refresh_revoked = sockets_evicted = 0
            if options["all"]:
                from trueppm_api.apps.access.services import revoke_personal_durable_grants

                links_revoked, secrets_cleared, webhooks_deactivated = (
                    revoke_personal_durable_grants(actor=None)
                )
            elif affected_users:
                from trueppm_api.apps.access.services import (
                    revoke_all_refresh_tokens,
                    revoke_personal_durable_grants,
                )
                from trueppm_api.apps.access.signals import evict_all_live_project_sockets

                for user in affected_users:
                    # Counted before the evict call schedules its on_commit work —
                    # the count and the eviction read the same live-membership rows,
                    # and neither mutates ProjectMembership, so order doesn't matter.
                    sockets_evicted += self._count_live_project_memberships(user.pk)
                    refresh_revoked += revoke_all_refresh_tokens(user)
                    u_links, u_secrets, u_webhooks = revoke_personal_durable_grants(
                        user, actor=None
                    )
                    links_revoked += u_links
                    secrets_cleared += u_secrets
                    webhooks_deactivated += u_webhooks
                    evict_all_live_project_sockets(user.pk)
        return (
            revoked,
            links_revoked,
            secrets_cleared,
            webhooks_deactivated,
            refresh_revoked,
            sockets_evicted,
        )

    def handle(self, *args: Any, **options: Any) -> None:
        target_user = self._resolve_target_user(options)
        queryset, scope_label = self._resolve_scope(options, target_user)
        doomed = list(queryset.only("pk", "token_prefix", "name", "owner", "project", "program"))
        self._report_matched_tokens(doomed, scope_label)
        links_matched, secrets_matched, webhooks_matched = self._count_durable_grants(options)

        # #4576: --user and --all-personal are documented as the off-boarding /
        # breach-containment levers, so they must also sweep refresh tokens, the
        # three non-token durable grants, and live project sockets for every
        # account the token revocation above targets — not PATs alone. See
        # _resolve_affected_users for exactly which accounts that is per scope.
        affected_users = self._resolve_affected_users(options, target_user, doomed)
        (
            refresh_matched,
            acct_links_matched,
            acct_secrets_matched,
            acct_webhooks_matched,
            sockets_matched,
        ) = self._report_account_sweep(affected_users)
        links_matched += acct_links_matched
        invites_matched = self._count_pending_invites(options, affected_users)
        secrets_matched += acct_secrets_matched
        webhooks_matched += acct_webhooks_matched

        if not any(
            (
                doomed,
                links_matched,
                secrets_matched,
                webhooks_matched,
                refresh_matched,
                sockets_matched,
                invites_matched,
            )
        ):
            self.stdout.write(self.style.SUCCESS("Nothing to revoke."))
            return

        if not options["commit"]:
            self.stdout.write(
                self.style.WARNING("Dry run — nothing revoked. Re-run with --commit to apply.")
            )
            return

        self._confirm(
            options,
            len(doomed)
            + links_matched
            + secrets_matched
            + webhooks_matched
            + refresh_matched
            + sockets_matched
            + invites_matched,
        )
        (
            revoked,
            links_revoked,
            secrets_cleared,
            webhooks_deactivated,
            refresh_revoked,
            sockets_evicted,
        ) = self._commit_revocation(doomed, affected_users, options)

        self.stdout.write(self.style.SUCCESS(f"Revoked {revoked} token(s)."))
        if options["all"]:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Revoked {links_revoked} share link(s), cleared "
                    f"{secrets_cleared} git-automation secret(s), deactivated "
                    f"{webhooks_deactivated} outgoing webhook(s)."
                )
            )
        elif affected_users:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Revoked {refresh_revoked} refresh token(s), {links_revoked} share "
                    f"link(s), cleared {secrets_cleared} git-automation secret(s), "
                    f"deactivated {webhooks_deactivated} outgoing webhook(s), and "
                    f"scheduled eviction of {sockets_evicted} live project connection(s)."
                )
            )
        if invites_matched:
            scope = "instance-wide" if options["all"] else "sent by the targeted account(s)"
            self.stdout.write(
                self.style.SUCCESS(
                    f"Revoked {invites_matched} pending workspace invite(s) {scope}."
                )
            )
        self.stdout.write(
            "Sessions and JWTs are a separate credential class — rotate JWT_SIGNING_KEY "
            "as well if you have not already (administration/security.md)."
        )
