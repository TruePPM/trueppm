"""Mint (or pin) the public read-only demo share links (issues #1487, #2440).

The public demo (``try.trueppm.com``) dogfoods the product's own tokenized,
read-only share links (#283, extended to schedules by #1486) rather than a
bespoke read-only mode: no login, no write path, near-zero abuse surface. This
command binds :class:`~trueppm_api.apps.projects.models.ShareLink` rows to the
seeded demo project and prints their public URLs, so both the demo compose stack
(``docker-compose.demo.yml``) and the Helm demo-seed hook (ADR-0658) can log
ready-to-share links on startup.

**Two content kinds.** A ``SCHEDULE`` link is always minted. A ``BOARD`` link is
minted *only when a board token is supplied* (``--token-board`` /
``TRUEPPM_DEMO_SHARE_TOKEN_BOARD``). That asymmetry is deliberate back-compat:
``docker-compose.demo.yml`` predates board sharing and supplies only the schedule
token, so it keeps its existing single-link behaviour untouched, while the Helm
path (which requires both tokens) gets both links. A board link is only worth
having if it is stable, so there is no generated-token mode for it.

Each kind needs its *own* token — ``ShareLink.token_hash`` is globally unique, so
one raw token cannot back two links.

**Two modes** (schedule only):

* **Pinned (required for a hosted demo).** Set ``TRUEPPM_DEMO_SHARE_TOKEN``
  (or pass ``--token``) to a fixed value. The command upserts a share link whose
  hash matches that token — idempotent and, crucially, *reprintable*: the same
  stable URL is emitted on every restart, so the demo has one deep-linkable
  address that survives redeploys. Under Helm this is not optional: the seeder is
  destructive and ``ShareLink.project`` is ``on_delete=CASCADE``, so an unpinned
  link changes its URL on every upgrade.
* **Generated (one-shot).** With no token supplied, a random token is minted
  once and its URL printed a single time (the raw token is never stored, only its
  hash — so it cannot be reprinted). Re-running without a pinned token reuses the
  existing link and reminds the operator to pin a token for a stable URL.

Read-only posture: this never touches the ``--with-personas`` /
``TRUEPPM_DEMO_PASSWORD`` path (#1350). The demo is reachable *only* through the
unauthenticated share endpoints.

**Minting and serving are two different gates** (#2781). ``mint_share_link()``
writes a row; the *read* additionally requires the ADR-0135 "Public sharing"
policy to resolve true for the project. Because ``Workspace.public_sharing``
defaults to ``False``, a demo built from default state minted links that every
recipient saw as ``410 Gone`` — while this command printed a confident URL. So
the command now turns sharing on for the project it publishes, and verifies the
*effective* policy before printing, rather than assuming the mint implies a
working link.
"""

from __future__ import annotations

import os
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from trueppm_api.apps.projects.authentication import sha256_hex
from trueppm_api.apps.projects.management.commands.seed_demo_project import (
    PROJECT_NAME,
)
from trueppm_api.apps.projects.models import Project, ShareContentKind, ShareLink
from trueppm_api.apps.projects.share_services import mint_share_link
from trueppm_api.apps.projects.sharing_settings import (
    public_sharing_instance_enabled,
    resolve_effective_sharing,
)

# Idempotency key: a demo link is matched (and reused) by its exact label so
# repeated runs never sprawl a fresh link per restart. The two kinds carry
# *different* labels because the generated-mode lookup filters on label — a shared
# label would make the two kinds collide on it.
#
# The SCHEDULE label is frozen at its original #1487 text on purpose: existing demo
# deployments already hold rows carrying it, and renaming it would make the
# generated-mode lookup miss them and mint a duplicate on the next run.
DEMO_LABEL = "Public read-only demo (#1487)"
DEMO_LABEL_BOARD = "Public read-only demo — board (#2440)"

LABEL_BY_KIND = {
    ShareContentKind.SCHEDULE: DEMO_LABEL,
    ShareContentKind.BOARD: DEMO_LABEL_BOARD,
}

# URL path segment per kind — mirrors the frontend routes /share/schedule/<token>
# and /share/board/<token>, and the API's own share/ URL patterns.
PATH_BY_KIND = {
    ShareContentKind.SCHEDULE: "schedule",
    ShareContentKind.BOARD: "board",
}

TOKEN_ENV = "TRUEPPM_DEMO_SHARE_TOKEN"
TOKEN_BOARD_ENV = "TRUEPPM_DEMO_SHARE_TOKEN_BOARD"
BASE_URL_ENV = "TRUEPPM_DEMO_BASE_URL"
DEFAULT_BASE_URL = "https://try.trueppm.com"


class Command(BaseCommand):
    """Mint or pin the public read-only demo share links (#1487, #2440)."""

    help = "Create (or pin) the public read-only demo share links and print their URLs."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--project",
            default=PROJECT_NAME,
            help=(
                f"Demo project name to share (default: {PROJECT_NAME!r}, "
                "seeded by seed_demo_project)."
            ),
        )
        parser.add_argument(
            "--token",
            default=None,
            help=(
                f"Pin a fixed raw token for a stable, reprintable SCHEDULE URL. "
                f"Falls back to the {TOKEN_ENV} env var. When omitted a random "
                "token is minted once."
            ),
        )
        parser.add_argument(
            "--token-board",
            default=None,
            help=(
                f"Pin a fixed raw token for a stable BOARD URL. Falls back to the "
                f"{TOKEN_BOARD_ENV} env var. When omitted no board link is minted "
                "(a board link is only useful if stable, so there is no generated "
                "mode). Must differ from the schedule token."
            ),
        )
        parser.add_argument(
            "--base-url",
            default=None,
            help=(
                f"Public base URL of the demo host (default: {BASE_URL_ENV} env "
                f"var, else {DEFAULT_BASE_URL!r})."
            ),
        )

    def handle(self, *args: object, **options: object) -> None:
        project_name = str(options["project"])
        base_url_opt = options.get("base_url")
        base_url = (
            str(base_url_opt) if base_url_opt else os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL
        ).rstrip("/")

        token_opt = options.get("token")
        schedule_token = str(token_opt) if token_opt else os.environ.get(TOKEN_ENV)
        token_board_opt = options.get("token_board")
        board_token = str(token_board_opt) if token_board_opt else os.environ.get(TOKEN_BOARD_ENV)

        # Guard the collision early with an actionable message. Without this the
        # second upsert would silently resolve the *first* kind's row by token_hash
        # and report success while minting nothing.
        if schedule_token and board_token and schedule_token == board_token:
            raise CommandError(
                "The schedule and board tokens are identical. ShareLink.token_hash is "
                "globally unique, so each kind needs its own token — generate a second "
                "one with: openssl rand -base64 32 | tr -d '=+/'"
            )

        try:
            # Scoped to is_sample so this publishes the seeder's project and never
            # an operator's same-named real one — Project.name is non-unique, and
            # since #2476 the seeder no longer deletes a real project that
            # collides with the demo name, so it can legitimately coexist here.
            project = Project.objects.get(name=project_name, is_sample=True, is_deleted=False)
        except Project.DoesNotExist as exc:
            raise CommandError(
                f"Demo project {project_name!r} not found. Run "
                "`python manage.py seed_demo_project` first."
            ) from exc

        # Turn sharing on *before* minting, so the links this run prints resolve
        # for the recipient rather than 410-ing (#2781).
        self._enable_public_sharing(project)

        results: list[tuple[str, ShareLink, str]] = []

        scheduled = self._resolve_link(project, ShareContentKind.SCHEDULE, schedule_token)
        if scheduled is not None:
            results.append(scheduled)

        # Board is opt-in via its token — see the module docstring for why.
        if board_token:
            board = self._resolve_link(project, ShareContentKind.BOARD, board_token)
            if board is not None:
                results.append(board)

        if not results:
            return

        # Re-read the posture the *recipient* will hit. Enabling sharing above is
        # necessary but not sufficient: the operator kill switch sits above every
        # policy, and an Enterprise ENFORCE lock outranks the project override. If
        # either still says no, say so instead of printing a URL that 404s/410s.
        self._warn_if_links_will_not_resolve(project)

        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write(self.style.SUCCESS("  Public read-only demo share links"))
        self.stdout.write(self.style.SUCCESS(f"  Project:  {project.name!r}"))
        for action, link, token in results:
            kind_path = PATH_BY_KIND[ShareContentKind(link.content_kind)]
            url = f"{base_url}/share/{kind_path}/{token}"
            self.stdout.write(self.style.SUCCESS(""))
            self.stdout.write(self.style.SUCCESS(f"  {action} {link.content_kind} link"))
            self.stdout.write(self.style.SUCCESS(f"  Link id:  {link.id}"))
            self.stdout.write(self.style.SUCCESS(f"  URL:      {url}"))
        self.stdout.write(self.style.SUCCESS("=" * 60))

    def _enable_public_sharing(self, project: Any) -> None:
        """Set the demo project's own ADR-0135 ``public_sharing`` override to True.

        The override is written at **project** scope, not on the workspace, and
        that is the whole point of the choice: ``Workspace.public_sharing`` is the
        admin-facing default for *every* project on the instance, and a management
        command has no business flipping it. The demo project is public by
        definition; nothing else on the instance is, and a self-hoster who seeds
        the sample onto a real install must not find their workspace default
        silently loosened as a side effect.

        Safe by scoping: ``handle()`` resolves the project with ``is_sample=True``,
        so the only row this can ever touch is one the seeder created.

        Idempotent — a second run finds the override already true and writes
        nothing, which keeps ``server_version`` (and the history row each save
        writes) from advancing once per container restart.
        """
        if project.public_sharing:
            return
        project.public_sharing = True
        project.save(update_fields=["public_sharing"])
        self.stdout.write(
            self.style.WARNING(
                f"Enabled public sharing on demo project {project.name!r} "
                "(project-scoped override; the workspace default is untouched)."
            )
        )

    def _warn_if_links_will_not_resolve(self, project: Any) -> None:
        """Warn when the printed URLs will not actually serve, and say why.

        The mint and the read are separate gates, and this command historically
        only exercised the first — which is how a demo shipped links that every
        recipient saw as ``410 Gone`` while startup logs showed a confident URL
        (#2781). Two conditions survive :meth:`_enable_public_sharing`:

        * the operator kill switch (``TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED=false``),
          which outranks every policy and makes the share endpoints answer 404;
        * an Enterprise ``ENFORCE`` sharing lock with the workspace value off,
          under which the project override is ignored and the read answers 410.

        Neither is this command's to override — an operator or a workspace admin
        set them deliberately. Reporting them is the honest response.
        """
        if not public_sharing_instance_enabled():
            self.stdout.write(
                self.style.ERROR(
                    "TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED is false — this instance "
                    "serves no public share links, so the URLs below will 404. Set it "
                    "to true to run a public demo."
                )
            )
            return
        if not resolve_effective_sharing(project, "public_sharing"):
            self.stdout.write(
                self.style.ERROR(
                    "Public sharing still resolves to off for this project despite the "
                    "project-scoped override — a workspace ENFORCE policy is locking it. "
                    "The URLs below will return 410 until a workspace admin turns "
                    "'Public sharing' on or relaxes the override policy."
                )
            )

    def _resolve_link(
        self,
        project: Any,
        kind: ShareContentKind,
        pinned_token: str | None,
    ) -> tuple[str, ShareLink, str] | None:
        """Return ``(action, link, raw_token)`` for one content kind.

        Returns ``None`` when there is nothing printable — today that is only the
        generated-mode case where a prior link exists but its raw token cannot be
        recovered, which is a warning rather than an error.
        """
        if pinned_token:
            link, created = self._upsert_pinned_link(project, kind, pinned_token)
            return ("Created" if created else "Reused"), link, pinned_token

        existing = (
            ShareLink.objects.filter(
                project=project,
                content_kind=kind,
                label=LABEL_BY_KIND[kind],
                revoked_at__isnull=True,
            )
            .order_by("-created_at")
            .first()
        )
        if existing is not None:
            env_var = TOKEN_ENV if kind == ShareContentKind.SCHEDULE else TOKEN_BOARD_ENV
            self.stdout.write(
                self.style.WARNING(
                    f"A generated demo {kind} share link already exists but its raw token "
                    f"cannot be recovered. Set {env_var} to pin a stable, "
                    "reprintable URL, or revoke it in the sharing UI and re-run."
                )
            )
            return None

        link, token = mint_share_link(
            project,
            user=None,
            label=LABEL_BY_KIND[kind],
            show_assignees=False,
            content_kind=kind,
        )
        return "Created", link, token

    def _upsert_pinned_link(
        self,
        project: Any,
        kind: ShareContentKind,
        token: str,
    ) -> tuple[ShareLink, bool]:
        """Return ``(link, created)`` for the pinned token, creating it if absent.

        Matched by ``token_hash`` (the only stored representation of the token),
        so a fixed token always resolves the same row and the URL is reprintable
        across restarts — and across the destructive re-seed that a Helm upgrade
        performs, which cascades the previous rows away entirely.
        """
        token_hash = sha256_hex(token)
        link = ShareLink.objects.filter(token_hash=token_hash).first()
        if link is not None:
            # A token already bound to the *other* kind must not be silently
            # reported as reused: the caller would see "Reused" and exit 0 while
            # the link they asked for was never minted. The same-run guard in
            # handle() only catches both-tokens-equal; this catches the cross-run
            # case (reusing a previously-pinned schedule token as a board token).
            if link.content_kind != kind:
                raise CommandError(
                    f"That token is already bound to a {link.content_kind} share link "
                    f"(id {link.id}); it cannot also back a {kind} link because "
                    "ShareLink.token_hash is globally unique. Use a different token."
                )
            return link, False
        link = ShareLink.objects.create(
            project=project,
            content_kind=kind,
            token_prefix=token[:12],
            token_hash=token_hash,
            label=LABEL_BY_KIND[kind],
            show_assignees=False,
            created_by=None,
        )
        return link, True
