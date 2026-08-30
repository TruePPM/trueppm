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


class RoleContext(models.TextChoices):
    """Which role-context "lens" the app presents for this user (#412).

    A person who wears two hats (e.g. a delivery lead who is both PM and Scrum
    Master) can pin the workspace to a single role's layout, or keep the dual-hat
    ``UNIFIED`` view that blends both. This stores the *active* lens; the concrete
    mode-layouts that consume it are a deferred frontend follow-up.
    """

    PM = "pm", "PM"
    SCRUM_MASTER = "scrum_master", "Scrum Master"
    UNIFIED = "unified", "Unified Today"


class DateFormat(models.TextChoices):
    """Date-format *style* for displayed dates (#1953, ADR-0410).

    A display-only styling preference — it never re-timezones a value, so it
    applies to *every* displayed date (instant timestamps and UTC-pinned calendar
    dates alike). ``AUTO`` follows the viewer's browser locale (resolved
    client-side); the three explicit styles pin a recognizable order. Server-side
    this is opaque — the API always emits aware-UTC ISO-8601 and localization is a
    pure client concern.
    """

    AUTO = "auto", "Automatic (based on your locale)"
    ISO = "iso", "2026-07-14"  # YYYY-MM-DD
    US = "us", "Jul 14, 2026"  # MMM D, YYYY
    EU = "eu", "14 Jul 2026"  # D MMM YYYY


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
    # 'unified' is the default because the dual-hat "Unified Today" view is the
    # headline demo for #412: a user who has not yet picked a lens should see the
    # blended PM + Scrum Master surface, not be forced into one role up front.
    role_context = models.CharField(
        max_length=12,
        choices=RoleContext.choices,
        default=RoleContext.UNIFIED,
        help_text="Active role-context view: PM, Scrum Master, or Unified Today (#412).",
    )
    # Per-user view visibility (ADR-0139). Canonical view keys this user has
    # hidden from their own project nav — applied globally across every project,
    # layered on top of the per-project methodology preset (ADR-0041). Empty =
    # methodology default only; 'overview' is never hideable.
    hidden_views = models.JSONField(default=list, blank=True, help_text="Hidden nav view keys.")
    # Personal display frame (#1953, ADR-0410). Globally-dispersed teams: each user
    # picks the zone their *instant* timestamps (activity/comments/relative times)
    # render in, and the *style* every displayed date reads in. Both are
    # display-only — the API stays aware-UTC ISO-8601 and localization happens only
    # in the client. 'auto' is the zero-config default: it resolves client-side to
    # the browser's detected zone / locale, so display is correct on first load with
    # no write. The two preferences have DIFFERENT scope: timezone re-clocks only
    # instants (re-timezoning a calendar date would shift the displayed day per
    # viewer — the ADR-0144 bug), whereas date_format restyles *all* dates (a style
    # change is timezone-independent and never moves a day).
    timezone = models.CharField(
        max_length=64,
        default="auto",
        help_text=(
            "IANA timezone for displaying instant timestamps, or 'auto' to use the "
            "browser's detected zone. Display-only; API datetimes stay UTC."
        ),
    )
    date_format = models.CharField(
        max_length=8,
        choices=DateFormat.choices,
        default=DateFormat.AUTO,
        help_text="Date-format style for all displayed dates. 'auto' follows browser locale.",
    )

    class Meta:
        verbose_name = "user profile"
        verbose_name_plural = "user profiles"

    def __str__(self) -> str:
        return f"UserProfile({self.user_id}, default_landing={self.default_landing})"


class ProjectVisit(models.Model):
    """Per-user "last visited" timestamp for a project (ADR-0150).

    One row per ``(user, project)``, upserted on each visit, recording when the
    user last opened the project. This replaces the membership-``server_version``
    proxy that ``services.most_recent_project`` used to pick a PM's landing
    project (ADR-0129 flagged the proxy as inadequate: a membership's version
    advances on role edits, not on actual navigation).

    Like :class:`UserProfile` this is private per-user navigation telemetry —
    plain ``models.Model`` (no ``server_version``), never synced to mobile, never
    broadcast. The upsert-in-place shape keeps the table bounded by the user's
    membership count, and the ``(user, -visited_at)`` index serves both the
    resolver's "my most recent project" lookup and a forward-compatible
    "recently viewed projects" switcher without a schema change.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="project_visits",
    )
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="visits",
    )
    visited_at = models.DateTimeField(help_text="When the user last opened this project.")

    class Meta:
        verbose_name = "project visit"
        verbose_name_plural = "project visits"
        constraints = [
            models.UniqueConstraint(
                fields=["user", "project"],
                name="uq_project_visit_user_project",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-visited_at"], name="projectvisit_user_recent_idx"),
        ]

    def __str__(self) -> str:
        return f"ProjectVisit({self.user_id} → {self.project_id} @ {self.visited_at:%Y-%m-%d})"


class UserPin(models.Model):
    """A project or program one user has pinned for quick access (#2390, ADR-0627).

    A pin is **private to its owner**. It is a personal wayfinding marker, not
    collaborative domain data and not a signal about the pinned entity — nothing
    in the API answers "who pinned this" or "how many people pinned this", and
    :attr:`pinned_at` is exposed only on the owner's own ``GET /me/pinned/``.
    That restraint is deliberate: a per-user marker readable by a PM or admin
    becomes an engagement metric by accretion ("she hasn't pinned the client
    project in weeks"), which is precisely the surveillance surface ADR-0627 §D5
    exists to foreclose.

    **Naming caveat (ADR-0627 §D1.1).** ``pinned`` carries the *opposite* privacy
    semantics elsewhere in this same schema: ``TaskNote.pinned`` and
    ``TaskAttachment.is_pinned`` are **shared** curation any project writer may
    toggle. The two meanings never meet on one resource, and this one is enforced
    owner-only, but do not reason by analogy from those fields when extending
    this model — adding ``pinned_by`` or ``pin_count`` here would be a privacy
    regression, and requires a superseding ADR rather than a convention appeal.

    Exactly one of :attr:`project` / :attr:`program` is set, enforced by a
    database CheckConstraint. This mirrors the explicit-nullable-FK pattern used
    by ``Webhook`` and ``ApiToken`` (ADR-0076) rather than a GenericForeignKey,
    which this codebase does not use anywhere (ADR-0075).

    Deliberately **not** part of the offline sync delta (ADR-0142): the delta is
    project-scoped while a pin is user-scoped and spans both entity kinds, the
    same reasoning that kept ``UserProfile`` and ``ProjectVisit`` out. Unpinning
    is a hard delete — there is no tombstone, and therefore no unpin *history* to
    mine.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="pins",
    )
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="pins",
        null=True,
        blank=True,
    )
    program = models.ForeignKey(
        "projects.Program",
        on_delete=models.CASCADE,
        related_name="pins",
        null=True,
        blank=True,
    )
    pinned_at = models.DateTimeField(
        auto_now_add=True,
        help_text="When the user pinned this item. Never exposed on a shared payload.",
    )

    class Meta:
        verbose_name = "user pin"
        verbose_name_plural = "user pins"
        constraints = [
            models.CheckConstraint(
                # Exactly one target. A row with both or neither is meaningless
                # and would make the `is_pinned` annotation ambiguous.
                condition=(
                    models.Q(project__isnull=False, program__isnull=True)
                    | models.Q(project__isnull=True, program__isnull=False)
                ),
                name="ck_userpin_project_xor_program",
            ),
            # Partial uniques rather than one composite: a NULL target column
            # would make a plain UniqueConstraint non-enforcing (NULL != NULL in
            # SQL), so each kind gets its own. They double as the covering
            # indexes the `is_pinned` Exists() subquery probes.
            models.UniqueConstraint(
                fields=["user", "project"],
                condition=models.Q(project__isnull=False),
                name="uq_userpin_user_project",
            ),
            models.UniqueConstraint(
                fields=["user", "program"],
                condition=models.Q(program__isnull=False),
                name="uq_userpin_user_program",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "-pinned_at"], name="userpin_user_recent_idx"),
        ]

    def __str__(self) -> str:
        target = self.project_id or self.program_id
        return f"UserPin({self.user_id} → {target})"
