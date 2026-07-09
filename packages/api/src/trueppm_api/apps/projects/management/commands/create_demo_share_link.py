"""Mint (or pin) the public read-only demo share link (issue #1487).

The public demo (``try.trueppm.dev``) dogfoods the product's own tokenized,
read-only share link (#283, extended to schedules by #1486) rather than a
bespoke read-only mode: no login, no write path, near-zero abuse surface. This
command binds a ``SCHEDULE`` :class:`~trueppm_api.apps.projects.models.ShareLink`
to the seeded demo project and prints the public URL so the demo compose stack
(``docker-compose.demo.yml``) can log a ready-to-share link on startup.

Two modes:

* **Pinned (recommended for a hosted demo).** Set ``TRUEPPM_DEMO_SHARE_TOKEN``
  (or pass ``--token``) to a fixed value. The command upserts a share link whose
  hash matches that token — idempotent and, crucially, *reprintable*: the same
  stable URL is emitted on every restart, so the demo has one deep-linkable
  address that survives redeploys.
* **Generated (one-shot).** With no token supplied, a random token is minted
  once and its URL printed a single time (the raw token is never stored, only its
  hash — so it cannot be reprinted). Re-running without a pinned token reuses the
  existing link and reminds the operator to pin a token for a stable URL.

Read-only posture: this never touches the ``--with-personas`` /
``TRUEPPM_DEMO_PASSWORD`` path (#1350). The demo is reachable *only* through the
unauthenticated share endpoint.
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

# Idempotency key: the demo link is matched (and reused) by this exact label so
# repeated runs never sprawl a fresh link per restart.
DEMO_LABEL = "Public read-only demo (#1487)"

TOKEN_ENV = "TRUEPPM_DEMO_SHARE_TOKEN"
BASE_URL_ENV = "TRUEPPM_DEMO_BASE_URL"
DEFAULT_BASE_URL = "https://try.trueppm.dev"


class Command(BaseCommand):
    """Mint or pin the public read-only demo schedule share link (#1487)."""

    help = "Create (or pin) the public read-only demo schedule share link and print its URL."

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
                f"Pin a fixed raw token for a stable, reprintable URL. "
                f"Falls back to the {TOKEN_ENV} env var. When omitted a random "
                "token is minted once."
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
        pinned_token = str(token_opt) if token_opt else os.environ.get(TOKEN_ENV)

        try:
            # The seed is idempotent and never creates duplicates, so .get() is safe.
            project = Project.objects.get(name=project_name, is_deleted=False)
        except Project.DoesNotExist as exc:
            raise CommandError(
                f"Demo project {project_name!r} not found. Run "
                "`python manage.py seed_demo_project` first."
            ) from exc

        if pinned_token:
            token = pinned_token
            link, created = self._upsert_pinned_link(project, token)
            action = "Created" if created else "Reused"
        else:
            existing = (
                ShareLink.objects.filter(
                    project=project,
                    content_kind=ShareContentKind.SCHEDULE,
                    label=DEMO_LABEL,
                    revoked_at__isnull=True,
                )
                .order_by("-created_at")
                .first()
            )
            if existing is not None:
                self.stdout.write(
                    self.style.WARNING(
                        "A generated demo share link already exists but its raw token "
                        f"cannot be recovered. Set {TOKEN_ENV} to pin a stable, "
                        "reprintable URL, or revoke it in the sharing UI and re-run."
                    )
                )
                return
            link, token = mint_share_link(
                project,
                user=None,
                label=DEMO_LABEL,
                show_assignees=False,
                content_kind=ShareContentKind.SCHEDULE,
            )
            action = "Created"

        url = f"{base_url}/share/schedule/{token}"
        self.stdout.write(self.style.SUCCESS("=" * 60))
        self.stdout.write(self.style.SUCCESS(f"  {action} public read-only demo share link"))
        self.stdout.write(self.style.SUCCESS(f"  Project:  {project.name!r}"))
        self.stdout.write(self.style.SUCCESS(f"  Link id:  {link.id}"))
        self.stdout.write(self.style.SUCCESS(f"  URL:      {url}"))
        self.stdout.write(self.style.SUCCESS("=" * 60))

    def _upsert_pinned_link(self, project: Any, token: str) -> tuple[ShareLink, bool]:
        """Return ``(link, created)`` for the pinned token, creating it if absent.

        Matched by ``token_hash`` (the only stored representation of the token),
        so a fixed ``TRUEPPM_DEMO_SHARE_TOKEN`` always resolves the same row and
        the URL is reprintable across restarts.
        """
        token_hash = sha256_hex(token)
        link = ShareLink.objects.filter(token_hash=token_hash).first()
        if link is not None:
            return link, False
        link = ShareLink.objects.create(
            project=project,
            content_kind=ShareContentKind.SCHEDULE,
            token_prefix=token[:12],
            token_hash=token_hash,
            label=DEMO_LABEL,
            show_assignees=False,
            created_by=None,
        )
        return link, True
