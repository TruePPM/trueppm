"""Workspace-level models — singleton config, membership, invites, groups (ADR-0087).

The *workspace* is the whole self-hosted installation (single-tenant; multi-tenancy
is Enterprise). It is introduced here for the first time to back the Workspace
settings pages (#517 General, #518 Members, #519 Groups & teams).

Key design points (see ADR-0087):
- ``Workspace`` is a singleton config row (``singleton_key=1``), lazily materialized
  on first access — no data migration. It does NOT extend ``VersionedModel`` (config
  is not a mobile-offline sync entity).
- ``WorkspaceRole`` is deliberately separate from the project-scoped ``Role``
  (#518): workspace permission tiers are coarser than project scheduling roles.
- ``WorkspaceMembership``/``Group``/``GroupMembership`` extend ``VersionedModel`` so
  they participate in the offline sync protocol and support direct permission
  queries — mirroring the ``ProjectMembership`` pattern (ADR-0070).
- A ``Group`` confers project access: ``GroupProject`` links a group to a project
  with a granted project ``Role``; membership is reconciled into ``ProjectMembership``
  rows by ``services.reconcile_group_access`` (the cascade).
"""

from __future__ import annotations

import datetime
import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.utils import timezone

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import VersionedModel

INVITE_TTL_DAYS = 7  # ADR-0087 §4 — invite token validity window

# English month names, indexed 1–12, for the fiscal-year display label (#756).
# Hard-coded rather than derived from ``calendar``/``strftime`` because those are
# locale-sensitive and the workspace anchor must read identically regardless of
# the server's LC_TIME (UI copy is US-English per project convention).
_MONTH_NAMES = (
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


class WorkspaceRole(models.IntegerChoices):
    """Workspace-level permission tiers, separate from the project ``Role`` (#518).

    Ordinals follow the ADR-0072 100-unit banding so Enterprise can register
    intermediate roles (e.g. a billing-admin at 250) without an OSS renumber.
    Write access gates on ``role >= WorkspaceRole.ADMIN``; OWNER carries the
    last-owner guard (a workspace must never be left without an owner).

    Account *lifecycle* (active/guest/deactivated) is the orthogonal
    ``WorkspaceMembership.status`` field — a "guest" is a permission-limited
    external collaborator, not a separate role tier.
    """

    MEMBER = 100, "Member"
    ADMIN = 300, "Admin"
    OWNER = 400, "Owner"


class MemberStatus(models.TextChoices):
    """Account lifecycle for a workspace member (orthogonal to role)."""

    ACTIVE = "active", "Active"
    GUEST = "guest", "Guest"
    DEACTIVATED = "deactivated", "Deactivated"


class InviteStatus(models.TextChoices):
    PENDING = "pending", "Pending"
    ACCEPTED = "accepted", "Accepted"
    REVOKED = "revoked", "Revoked"
    EXPIRED = "expired", "Expired"


def _default_work_week() -> list[bool]:
    """Mon–Sun working-day flags; default Mon–Fri working, weekend off.

    A callable default is required so each row gets its own list rather than
    sharing one mutable instance across rows.
    """
    return [True, True, True, True, True, False, False]


class Workspace(models.Model):
    """Singleton installation-wide configuration (#517).

    Enforced single-row via the unique ``singleton_key`` (ADR-0081 pattern) and
    lazily created on first GET via :meth:`load` (ADR-0079 ``PhaseGateConfig``
    precedent) — there is intentionally no data migration to seed it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Always 1 — the unique constraint makes a second row impossible.
    singleton_key = models.PositiveSmallIntegerField(default=1, editable=False, unique=True)

    name = models.CharField(max_length=255, default="TruePPM Workspace")
    # Read-only via the API. Self-hosted installs have no subdomain; the column
    # exists so a future hosted edition can populate it without a schema change.
    subdomain = models.CharField(max_length=63, blank=True, default="")
    timezone = models.CharField(max_length=64, default="UTC")
    # Structured fiscal-year anchor (#756): month (1–12) + day (1–31), replacing
    # the former free-text ``fiscal_year_start`` CharField. Year-agnostic — a
    # workspace whose FY starts April 1 stores (4, 1). Drives quarter labels and
    # boundaries across the workspace, including the Schedule timeline (#755).
    # Day-vs-month validity (no Feb 30) is enforced in the settings serializer,
    # which is the only write path; the model carries the coarse range validators.
    fiscal_year_start_month = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(1), MaxValueValidator(12)],
    )
    fiscal_year_start_day = models.PositiveSmallIntegerField(
        default=1,
        validators=[MinValueValidator(1), MaxValueValidator(31)],
    )
    work_week = ArrayField(models.BooleanField(), size=7, default=_default_work_week)
    default_project_view = models.CharField(max_length=32, default="board")
    allow_guests = models.BooleanField(default=True)
    public_sharing = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "workspace_workspace"

    def __str__(self) -> str:
        return f"Workspace({self.name})"

    @classmethod
    def load(cls) -> Workspace:
        """Return the singleton, creating it on first access."""
        obj, _ = cls.objects.get_or_create(singleton_key=1)
        return obj

    @property
    def fiscal_year_start_display(self) -> str:
        """Human label for the fiscal-year anchor, e.g. ``"April 6"`` (#756).

        Read-only convenience exposed on the settings serializer for back-compat
        with any reader that previously consumed the free-text ``fiscal_year_start``.
        """
        return f"{_MONTH_NAMES[self.fiscal_year_start_month]} {self.fiscal_year_start_day}"


class WorkspaceMembership(VersionedModel):
    """A user's workspace-level role + account status (#518).

    Standalone through-model (not an M2M ``through=``) so it participates in
    offline sync and can be queried directly in permission checks — mirrors
    ``ProjectMembership`` (ADR-0070). A membership row is created lazily the
    first time an admin sets a user's role/status; users without a row default
    to OWNER if they are a Django superuser, else MEMBER (see
    ``permissions._workspace_membership_role``).
    """

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="workspace_memberships",
    )
    role = models.IntegerField(choices=WorkspaceRole.choices, default=WorkspaceRole.MEMBER)
    status = models.CharField(
        max_length=16, choices=MemberStatus.choices, default=MemberStatus.ACTIVE
    )
    # Mirrors ProjectMembership (#590): joined_at backfills via default=timezone.now;
    # role_changed_at is NULL until an actual role change.
    joined_at = models.DateTimeField(default=timezone.now, editable=False)
    role_changed_at = models.DateTimeField(null=True, blank=True, editable=False)

    class Meta:
        db_table = "workspace_membership"
        unique_together = [("workspace", "user")]

    def __str__(self) -> str:
        return f"{self.user} — {WorkspaceRole(self.role).label} ({self.status})"


class WorkspaceInvite(models.Model):
    """A pending email invitation to join the workspace (#518, ADR-0087 §4).

    The raw token (``secrets.token_urlsafe``) is emailed in the accept link and
    never stored — only its SHA-256 hash lives here, so a database leak cannot
    be replayed into account takeover. Email delivery uses the transactional
    outbox pattern (``email_pending`` drained by ``tasks.drain_invite_emails``),
    mirroring ``Notification``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="invites",
    )
    email = models.EmailField()
    role = models.IntegerField(choices=WorkspaceRole.choices, default=WorkspaceRole.MEMBER)
    # SHA-256 of the raw token — the durable credential the accept endpoint
    # authenticates against. The raw token is never stored long-term.
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    # Transient raw token, populated at create time so the async email drain can
    # build the accept link, then CLEARED on first successful send (and on
    # accept). Bounds at-rest exposure to the orphan window; after send only the
    # hash remains, so a later DB leak cannot be replayed.
    email_token = models.CharField(max_length=64, blank=True, default="")
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="workspace_invites_sent",
    )
    status = models.CharField(
        max_length=16, choices=InviteStatus.choices, default=InviteStatus.PENDING
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="workspace_invites_accepted",
    )

    # Email delivery state — drained by tasks.drain_invite_emails (ADR-0087 §Durable).
    email_pending = models.BooleanField(default=False, db_index=True)
    email_sent_at = models.DateTimeField(null=True, blank=True)
    email_failed_at = models.DateTimeField(null=True, blank=True)
    email_attempts = models.PositiveIntegerField(default=0)

    class Meta:
        db_table = "workspace_invite"
        ordering = ["-created_at"]
        indexes = [
            models.Index(
                fields=["email_pending", "-created_at"],
                name="ix_invite_email_pending",
                condition=models.Q(email_pending=True),
            ),
            models.Index(fields=["status", "-created_at"], name="ix_invite_status"),
        ]

    def __str__(self) -> str:
        return f"WorkspaceInvite({self.email} → {WorkspaceRole(self.role).label}, {self.status})"

    @staticmethod
    def default_expiry() -> datetime.datetime:
        return timezone.now() + datetime.timedelta(days=INVITE_TTL_DAYS)

    @property
    def is_expired(self) -> bool:
        return timezone.now() >= self.expires_at


class Group(VersionedModel):
    """A workspace team/group (#519).

    Members are linked via the ``GroupMembership`` through-model; project
    associations via ``GroupProject``. Adding a group to a project confers the
    group's granted ``Role`` on every member by reconciling ``ProjectMembership``
    rows (``services.reconcile_group_access``).
    """

    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="groups",
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    lead = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="groups_led",
    )

    class Meta:
        db_table = "workspace_group"
        ordering = ["name"]

    def __str__(self) -> str:
        return f"Group({self.name})"


class GroupMembership(VersionedModel):
    """Through-model linking a user to a :class:`Group` (#519)."""

    group = models.ForeignKey(
        Group,
        on_delete=models.CASCADE,
        related_name="memberships",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="group_memberships",
    )
    joined_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        db_table = "workspace_group_membership"
        unique_together = [("group", "user")]

    def __str__(self) -> str:
        return f"{self.user} ∈ {self.group}"


class GroupProject(models.Model):
    """Links a :class:`Group` to a project with the project ``Role`` it confers (#519).

    Uses the project-scoped ``Role`` enum (not ``WorkspaceRole``) because the
    cascade materializes ``ProjectMembership`` rows. The conferred role is
    capped below OWNER by serializer validation — a group can never confer
    project ownership (the last-owner guard must remain meaningful).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    group = models.ForeignKey(
        Group,
        on_delete=models.CASCADE,
        related_name="project_links",
    )
    project = models.ForeignKey(
        "projects.Project",
        on_delete=models.CASCADE,
        related_name="group_links",
    )
    role = models.IntegerField(choices=Role.choices, default=Role.MEMBER)
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="group_projects_added",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "workspace_group_project"
        unique_together = [("group", "project")]

    def __str__(self) -> str:
        return f"{self.group} → {self.project_id} ({Role(self.role).label})"


class ExportJobStatus(models.TextChoices):
    """Lifecycle of an async workspace export (ADR-0092)."""

    PENDING = "pending", "Pending"
    RUNNING = "running", "Running"
    SUCCESS = "success", "Success"
    FAILED = "failed", "Failed"


class WorkspaceExportJob(models.Model):
    """Tracks a full-workspace archive export (ADR-0092, #641).

    Plain (non-synced) model — an export job is server-side bookkeeping, never a
    mobile-offline entity. There is no FK to ``Workspace`` because it is a
    singleton; a job always concerns the one workspace. Mirrors ``taskruns.TaskRun``
    for the status/timestamp shape. The drain re-dispatches ``pending`` rows whose
    ``celery_task_id`` never got set (broker down at ``on_commit``); the nightly
    purge deletes rows past ``expires_at`` and their stored files.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="workspace_exports",
    )
    status = models.CharField(
        max_length=10,
        choices=ExportJobStatus.choices,
        default=ExportJobStatus.PENDING,
        db_index=True,
    )
    celery_task_id = models.CharField(max_length=255, blank=True, default="", db_index=True)
    # Storage key (relative to the configured default storage), populated on success.
    file_path = models.CharField(max_length=512, blank=True, default="")
    file_size = models.BigIntegerField(null=True, blank=True)
    error_detail = models.TextField(blank=True, default="")
    # Download-link validity; past this the purge deletes the row + file (410 Gone).
    expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "workspace_export_job"
        ordering = ["-created_at"]
        indexes = [
            # Drives the drain scan: pending rows awaiting (re-)dispatch.
            models.Index(fields=["status", "created_at"], name="wsexport_status_created_idx"),
            # Drives the nightly purge scan of expired download links.
            models.Index(fields=["expires_at"], name="wsexport_expires_idx"),
        ]

    def __str__(self) -> str:
        return f"WorkspaceExportJob({self.id}, {self.status})"
