"""Per-user app-preference models (ADR-0129).

This app holds personal *application* preferences — settings that shape how the
app behaves *for one user*, not collaborative domain data. The first such
preference is :attr:`UserProfile.default_landing`, which feeds the role-based
app front door (the screen the user lands on at login / on hitting ``/``).
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class DefaultLanding(models.TextChoices):
    """Where the app opens for this user.

    ``AUTO`` is the sentinel meaning "use the role-based policy" (the default for
    every user). The three concrete values pin the front door to one surface
    regardless of role; ``PORTFOLIO`` only resolves to a real path when the
    running edition is Enterprise *and* the user is portfolio-entitled, and
    otherwise degrades cleanly to My Work (see ``services.resolve_landing``).
    """

    AUTO = "auto", "Automatic (based on your role)"
    MY_WORK = "my_work", "My Work"
    PROJECT_OVERVIEW = "project_overview", "Project Overview"
    PORTFOLIO = "portfolio", "Portfolio"


class UserProfile(models.Model):
    """Singleton per-user app preferences.

    Deliberately **not** a ``VersionedModel``: this is a personal app preference,
    not a board-scoped collaborative entity. It carries no ``server_version``,
    never participates in the offline delta/sync protocol, and is never broadcast
    over WebSockets — it is read only through ``/auth/me/`` and written only
    through ``PATCH /auth/me/profile/``. Keeping it out of sync avoids polluting
    the WatermelonDB schema with a non-collaborative singleton.

    Rows are created lazily (``get_or_create``) on first read/write, so existing
    users need no backfill — the absence of a row is read as ``default_landing``
    == ``AUTO``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    default_landing = models.CharField(
        max_length=20,
        choices=DefaultLanding.choices,
        default=DefaultLanding.AUTO,
        help_text="Which screen the app opens on. 'auto' uses the role-based policy.",
    )
    # Per-user view visibility (ADR-0139). Canonical view keys this user has
    # hidden from their own project nav — applied globally across every project,
    # layered on top of the per-project methodology preset (ADR-0041). Empty =
    # methodology default only; 'overview' is never hideable.
    hidden_views = models.JSONField(default=list, blank=True, help_text="Hidden nav view keys.")

    class Meta:
        verbose_name = "user profile"
        verbose_name_plural = "user profiles"

    def __str__(self) -> str:
        return f"UserProfile({self.user_id}, default_landing={self.default_landing})"
