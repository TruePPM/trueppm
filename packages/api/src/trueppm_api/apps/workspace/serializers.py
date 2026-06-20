"""Serializers for the workspace app (#517/#518/#519, ADR-0087).

Wire format is snake_case (DRF default); the web hooks map to camelCase. Member
and group *read* serializers are plain ``Serializer`` subclasses fed pre-built
dicts by the viewsets — the member "row" is a join across ``auth.User``,
``WorkspaceMembership``, group memberships, and a project count, so there is no
single model to bind a ``ModelSerializer`` to.
"""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from trueppm_api.apps.access.models import Role
from trueppm_api.apps.workspace.models import (
    _MONTH_NAMES,
    ExportJobStatus,
    Group,
    MemberStatus,
    Workspace,
    WorkspaceExportJob,
    WorkspaceRole,
)


def _max_fiscal_day(month: int) -> int:
    """Largest valid day-of-month for a *year-agnostic* fiscal anchor (#756).

    February is capped at 28 (not 29): the anchor stores no year, so a Feb 29
    start would be invalid in three years out of four. 30-day months reject 31.
    This keeps ``(month, day)`` valid in every calendar year, which is what the
    quarter-boundary math downstream assumes.
    """
    if month == 2:
        return 28
    if month in (4, 6, 9, 11):
        return 30
    return 31


# Deterministic avatar palette — index by a stable hash of the user id so a
# given user always renders the same dot color across sessions and clients.
_AVATAR_PALETTE = [
    "#1C6B3A",
    "#C17A10",
    "#7C3AED",
    "#0EA5E9",
    "#DC2626",
    "#0F766E",
    "#92400E",
    "#475569",
]


def initials_for(first_name: str, last_name: str, username: str) -> str:
    parts: list[str] = []
    if first_name:
        parts.append(first_name[0].upper())
    if last_name:
        parts.append(last_name[0].upper())
    if parts:
        return "".join(parts[:2])
    return username[:2].upper()


def display_name_for(first_name: str, last_name: str, username: str) -> str:
    name = f"{first_name} {last_name}".strip()
    return name or username


def color_for(user_id: Any) -> str:
    return _AVATAR_PALETTE[hash(str(user_id)) % len(_AVATAR_PALETTE)]


# ---------------------------------------------------------------------------
# #517 — Workspace general settings
# ---------------------------------------------------------------------------


class WorkspaceSettingsSerializer(serializers.ModelSerializer[Workspace]):
    """GET/PATCH /api/v1/workspace/. ``subdomain`` is read-only (#517).

    The fiscal-year anchor is a structured ``(month, day)`` pair (#756). The
    free-text ``fiscal_year_start`` it replaced is no longer accepted;
    ``fiscal_year_start_display`` is a read-only convenience label.
    """

    # Read-only mirror of the ``Workspace.fiscal_year_start_display`` property —
    # ModelSerializer does not surface plain model properties automatically.
    fiscal_year_start_display = serializers.CharField(read_only=True)
    # Public URL the top bar / settings page render in an <img> (ADR-0149, #969).
    # Points at the AllowAny serve endpoint (the logo is non-sensitive branding,
    # and an <img> cannot send the JWT). ``null`` when no logo is set, so the UI
    # falls back to the letter-mark. The ``?v=`` cache-buster is the row's
    # updated_at epoch so a replace busts the browser/CDN cache.
    logo_url = serializers.SerializerMethodField()

    class Meta:
        model = Workspace
        fields = [
            "name",
            "subdomain",
            "timezone",
            "fiscal_year_start_month",
            "fiscal_year_start_day",
            "fiscal_year_start_display",
            "work_week",
            "default_project_view",
            "allow_guests",
            "public_sharing",
            # Whether programs/projects may override the sharing settings above
            # (ADR-0135, #978). SUGGEST (OSS default) = downstream may loosen or
            # tighten; ENFORCE = Enterprise hard ceiling (no-op in OSS).
            "public_sharing_override_policy",
            # Workspace-wide iteration-container label default + cascade policy
            # (ADR-0116, #1106). The non-null root of the inheritance chain.
            "iteration_label",
            "iteration_label_override_policy",
            # Per-workspace Monte Carlo forecast-history config (ADR-0144, #1232) —
            # the non-null root of the Workspace → Program → Project inheritance
            # chain. mc_history_override_policy gates whether programs/projects may
            # override (SUGGEST = yes in OSS; ENFORCE = Enterprise lock, no-op in OSS).
            "mc_history_enabled",
            "mc_history_retention_cap",
            "mc_history_attribution_audience",
            "mc_history_override_policy",
            # Workspace-wide default planning methodology + cascade policy (ADR-0107,
            # issue 955) — the non-null root of the Workspace → Program → Project
            # methodology chain. methodology_override_policy governs whether
            # programs/projects may override (SUGGEST = yes in OSS; INHERIT locks the
            # affordance; ENFORCE = Enterprise hard lock, no-op in OSS).
            "methodology",
            "methodology_override_policy",
            # Workspace-wide default for what happens to a task's percent-complete when
            # its duration changes (ADR-0151, #414) — the non-null root of the
            # Workspace → Program → Project chain. task_duration_change_percent_override_policy
            # gates whether programs/projects may override (SUGGEST = yes in OSS;
            # ENFORCE = Enterprise hard lock, no-op in OSS).
            "task_duration_change_percent_policy",
            "task_duration_change_percent_override_policy",
            # Per-workspace attachment policy (ADR-0153, #976) — the non-null root of
            # the Workspace → Program → Project chain. attachments_enabled gates task
            # file uploads (external links unaffected); allowed_attachment_types is the
            # MIME allow-list seeded from the system default. attachments_override_policy
            # gates whether programs/projects may override (SUGGEST = yes in OSS;
            # ENFORCE = Enterprise lock, no-op in OSS).
            "attachments_enabled",
            "allowed_attachment_types",
            "attachments_override_policy",
            # Public serve-endpoint URL for the uploaded workspace logo (ADR-0149,
            # #969), or null when unset. Read-only; mutated via /workspace/logo/.
            "logo_url",
        ]
        read_only_fields = ["subdomain", "fiscal_year_start_display", "logo_url"]
        # An empty allow-list is a deliberate "no file types allowed" workspace
        # policy (ADR-0153, #976) — DRF maps the model ArrayField to allow_empty=
        # False by default, which would 400 a legitimate ``[]`` before
        # validate_allowed_attachment_types runs, so opt back in.
        extra_kwargs = {"allowed_attachment_types": {"allow_empty": True}}

    def get_logo_url(self, obj: Workspace) -> str | None:
        """Public serve-endpoint URL for the workspace logo, or ``None`` if unset."""
        if not obj.logo:
            return None
        version = int(obj.updated_at.timestamp()) if obj.updated_at else 0
        return f"/api/v1/workspace/logo/?v={version}"

    def validate_iteration_label(self, value: str) -> str:
        """The workspace label is the non-null root — reject empty (ADR-0116).

        Unlike the program/project overrides there is no "inherit" above the
        workspace, so a blank value cannot be normalized to NULL.
        """
        stripped = (value or "").strip()
        if not stripped:
            raise serializers.ValidationError(
                "Enter a default label for the iteration container (e.g. Sprint, Iteration, PI)."
            )
        return stripped

    def validate_work_week(self, value: list[bool]) -> list[bool]:
        if len(value) != 7:
            raise serializers.ValidationError("work_week must have exactly 7 entries (Mon-Sun).")
        return value

    def validate_allowed_attachment_types(self, value: list[str]) -> list[str]:
        """Normalize the workspace allow-list and reject security-denied types (ADR-0153).

        The workspace is the non-null root of the chain. Entries are lowercased
        and de-duplicated (deterministic order); a permanently-denied type
        (text/html etc.) is rejected outright rather than silently dropped, so an
        admin gets a clear error instead of a value that vanishes on the next read.
        An empty list is a valid (deliberate) "no types allowed" workspace policy.
        """
        from trueppm_api.apps.projects.attachment_policy import (
            DeniedAttachmentType,
            clean_attachment_type_list,
        )

        try:
            return clean_attachment_type_list(value)
        except DeniedAttachmentType as exc:
            raise serializers.ValidationError(
                f"{exc.args[0]!r} is blocked for security and cannot be allowed."
            ) from exc

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        """Reject a fiscal day that cannot exist in the chosen month (#756).

        PATCH may send only one of the pair, so fall back to the instance's
        current value for whichever field is absent before checking the matrix.
        """
        month = attrs.get(
            "fiscal_year_start_month",
            getattr(self.instance, "fiscal_year_start_month", 1),
        )
        day = attrs.get(
            "fiscal_year_start_day",
            getattr(self.instance, "fiscal_year_start_day", 1),
        )
        max_day = _max_fiscal_day(month)
        if day > max_day:
            raise serializers.ValidationError(
                {
                    "fiscal_year_start_day": (
                        f"{_MONTH_NAMES[month]} has no day {day}; "
                        f"the latest valid fiscal start in that month is {max_day}."
                    )
                }
            )
        return attrs


# ---------------------------------------------------------------------------
# #518 — Members
# ---------------------------------------------------------------------------


class WorkspaceMemberSerializer(serializers.Serializer[Any]):
    """Read serializer for a workspace member row (fed a pre-built dict)."""

    id = serializers.CharField()
    name = serializers.CharField()
    initials = serializers.CharField()
    color = serializers.CharField()
    email = serializers.EmailField()
    role = serializers.CharField()  # human label, e.g. "Admin"
    role_value = serializers.IntegerField()  # ordinal — use for comparisons
    groups = serializers.ListField(child=serializers.CharField())
    project_count = serializers.IntegerField()
    last_active = serializers.CharField(allow_null=True)
    status = serializers.CharField()
    # SSO / 2FA are Enterprise identity features — always false in OSS, surfaced
    # read-only so the members table renders without conditional columns.
    sso = serializers.BooleanField()
    two_fa = serializers.BooleanField()


class WorkspaceMemberUpdateSerializer(serializers.Serializer[Any]):
    """PATCH body for a member — role and/or status (#518)."""

    role = serializers.IntegerField(required=False)
    status = serializers.ChoiceField(choices=MemberStatus.choices, required=False)

    def validate_role(self, value: int) -> int:
        valid = {r.value for r in WorkspaceRole}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if "role" not in attrs and "status" not in attrs:
            raise serializers.ValidationError("Provide at least one of: role, status.")
        return attrs


class WorkspaceInviteSerializer(serializers.Serializer[Any]):
    """Read serializer for a pending invite (#518)."""

    id = serializers.CharField()
    email = serializers.EmailField()
    role = serializers.CharField()  # human label
    role_value = serializers.IntegerField()
    status = serializers.CharField()
    invited_by = serializers.CharField(allow_null=True)  # initials
    created_at = serializers.DateTimeField()
    expires_at = serializers.DateTimeField()


class WorkspaceInviteCreateSerializer(serializers.Serializer[Any]):
    """POST body to create an invite (#518)."""

    email = serializers.EmailField()
    role = serializers.IntegerField(default=WorkspaceRole.MEMBER)

    def validate_role(self, value: int) -> int:
        valid = {r.value for r in WorkspaceRole}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value


class InviteAcceptSerializer(serializers.Serializer[Any]):
    """POST body to accept an invite. username/password required only when no
    account already exists for the invited email."""

    token = serializers.CharField()
    username = serializers.CharField(required=False, allow_blank=True, default="")
    password = serializers.CharField(
        required=False,
        allow_blank=True,
        default="",
        write_only=True,
        style={"input_type": "password"},
    )


# ---------------------------------------------------------------------------
# #519 — Groups & teams
# ---------------------------------------------------------------------------


class GroupSerializer(serializers.Serializer[Any]):
    """Read serializer for a group row (fed a pre-built dict)."""

    id = serializers.CharField()
    name = serializers.CharField()
    description = serializers.CharField(allow_blank=True)
    lead = serializers.CharField(allow_null=True)  # initials
    lead_user_id = serializers.CharField(allow_null=True)
    member_count = serializers.IntegerField()
    members = serializers.ListField(child=serializers.DictField())
    projects = serializers.ListField(child=serializers.CharField())


class GroupWriteSerializer(serializers.ModelSerializer[Group]):
    """POST/PATCH body for a group (#519)."""

    class Meta:
        model = Group
        fields = ["name", "description", "lead"]
        extra_kwargs = {
            "description": {"required": False},
            "lead": {"required": False, "allow_null": True},
        }


class GroupMemberAddSerializer(serializers.Serializer[Any]):
    """POST /groups/{id}/members/ — add a member to a group (#519).

    ``user`` is the stock ``auth.User`` integer PK (TruePPM has no custom user
    model), not a UUID.
    """

    user = serializers.IntegerField()


class GroupProjectWriteSerializer(serializers.Serializer[Any]):
    """POST /groups/{id}/projects/ — link a group to a project with a conferred role."""

    project = serializers.UUIDField()
    role = serializers.IntegerField(default=Role.MEMBER)

    def validate_role(self, value: int) -> int:
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        # A group can never confer project ownership — the last-owner guard must
        # stay meaningful (ADR-0087 §5).
        if value >= Role.OWNER:
            raise serializers.ValidationError("A group cannot confer the Owner role.")
        return value


# ---------------------------------------------------------------------------
# #641 — Workspace lifecycle (ADR-0092)
# ---------------------------------------------------------------------------


class TransferOwnershipSerializer(serializers.Serializer[Any]):
    """POST body for transfer-ownership.

    ``new_owner_user_id`` is the stock ``auth.User`` integer PK (TruePPM has no
    custom user model), not a UUID.
    """

    new_owner_user_id = serializers.IntegerField()


class WorkspaceExportJobSerializer(serializers.ModelSerializer[WorkspaceExportJob]):
    """Read serializer for an export job's status and download affordance (#641)."""

    download_url = serializers.SerializerMethodField()

    class Meta:
        model = WorkspaceExportJob
        fields = [
            "id",
            "status",
            "file_size",
            "error_detail",
            "expires_at",
            "created_at",
            "started_at",
            "completed_at",
            "download_url",
        ]
        read_only_fields = fields

    def get_download_url(self, obj: WorkspaceExportJob) -> str | None:
        """Authenticated download path, present only once the archive is ready.

        Returns a relative API path (not a raw storage URL) so the archive is
        always fetched through the owner-gated download endpoint (ADR-0092).
        """
        if obj.status != ExportJobStatus.SUCCESS:
            return None
        return f"/api/v1/workspace/export/{obj.id}/download/"
