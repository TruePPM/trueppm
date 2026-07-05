"""Serializers for the access app."""

from __future__ import annotations

import re
from typing import Any

from django.contrib.auth import get_user_model
from drf_spectacular.utils import extend_schema_field, inline_serializer
from rest_framework import serializers

from trueppm_api.apps.access.groups import KNOWN_GROUP_KEYS
from trueppm_api.apps.access.models import (
    ProgramMembership,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.profiles.models import RoleContext

User = get_user_model()

# A mention group key must be a valid mention token (the name class of
# notifications.services._MENTION_RE) so it is actually addressable as @name.
_GROUP_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class _UserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class ProjectMembershipReadSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Response serializer — includes user_detail and role_label for list/retrieve.

    role                       — integer ordinal (canonical wire format; use for comparisons)
    role_label                 — human-readable label e.g. "Project Manager" (display only)
    joined_at                  — when this membership row was created (per-project access evidence)
    role_changed_at            — when the role last changed, or null if unchanged since joining
    other_active_project_count — how many OTHER active (non-archived, non-deleted) projects this
                                 user belongs to, excluding the current one. A resource-load
                                 signal for the assigner (#598). The full count is shown; it is a
                                 number only and leaks no project identities.
    other_active_project_names — names of those other projects, but ONLY the ones the *requesting*
                                 user is OWNER of (visibility gate — never reveal the name of a
                                 project the requester cannot already see). Empty for non-OWNERs.
    """

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    role_label = serializers.SerializerMethodField()
    other_active_project_count = serializers.SerializerMethodField()
    other_active_project_names = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProjectMembership) -> str:
        return Role(obj.role).label

    def get_other_active_project_count(self, obj: ProjectMembership) -> int:
        # list/retrieve annotate this on the queryset (one Subquery, no N+1). create/
        # partial_update serialize a fresh, un-annotated instance — fall back to a
        # single count query there (rare, one row).
        annotated = getattr(obj, "other_active_count", None)
        if annotated is not None:
            return int(annotated)
        return (
            ProjectMembership.objects.filter(
                user_id=obj.user_id,
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=obj.project_id)
            .values("project_id")
            .distinct()
            .count()
        )

    def get_other_active_project_names(self, obj: ProjectMembership) -> list[str]:
        # Names are visibility-gated and prebuilt once per request by the viewset
        # (see ProjectMembershipViewSet._build_other_project_names_map). When the map
        # is absent (create/partial_update responses) return [] — the client re-fetches
        # the list, which carries the gated names.
        names_map: dict[Any, list[str]] = self.context.get("other_project_names_map") or {}
        return names_map.get(obj.user_id, [])

    class Meta:
        model = ProjectMembership
        fields = [
            "id",
            "server_version",
            "project",
            "user",
            "user_detail",
            "role",
            "role_label",
            "joined_at",
            "role_changed_at",
            "other_active_project_count",
            "other_active_project_names",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "project",
            "user",
            "user_detail",
            "role_label",
            "joined_at",
            "role_changed_at",
            "other_active_project_count",
            "other_active_project_names",
        ]


class ProjectMembershipWriteSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Write serializer — accepts user (UUID) and role; project is injected from URL."""

    class Meta:
        model = ProjectMembership
        fields = ["user", "role"]

    def validate_role(self, value: int) -> int:
        # Role must be a valid Role ordinal.
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value


class ProgramMembershipReadSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Response serializer for ProgramMembership — mirrors the project version."""

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    # ``role_label`` is the *access* role's display name (Owner/Admin/…), a
    # computed mirror of the ``role`` ordinal — NOT the freeform functional title.
    # The freeform PO/PM/Tech-Lead label is the distinct ``role_title`` field
    # below (#565); the two never collide.
    role_label = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProgramMembership) -> str:
        return Role(obj.role).label

    class Meta:
        model = ProgramMembership
        fields = [
            "id",
            "server_version",
            "program",
            "user",
            "user_detail",
            "role",
            "role_label",
            "role_title",
            "joined_at",
            "role_changed_at",
        ]
        read_only_fields = [
            "id",
            "server_version",
            "program",
            "user",
            "user_detail",
            "role_label",
            "joined_at",
            "role_changed_at",
        ]


class ProgramMembershipWriteSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Write serializer — accepts user (UUID), role, and the freeform role_title.

    ``program`` is injected from the URL. ``role_title`` (#565) is optional; the
    view gates *who* may set it (role/user reassignment stays Owner-only, while a
    role_title-only PATCH is allowed at Admin+).
    """

    class Meta:
        model = ProgramMembership
        fields = ["user", "role", "role_title"]

    def validate_role(self, value: int) -> int:
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value

    def validate_role_title(self, value: str | None) -> str:
        # Collapse whitespace-only / empty submissions to "" so "unset" is a single
        # canonical state (empty string, never NULL — per the model's DJ001 default).
        return (value or "").strip()


class UserDefinedMentionGroupReadSerializer(serializers.ModelSerializer[UserDefinedMentionGroup]):
    """Response serializer for a user-defined @mention group (ADR-0211, #515).

    ``members`` is the curated member set (summary detail); ``member_count`` is a
    convenience for the list UI. ``muted_by_me`` reflects whether the *requesting*
    user has muted this group — the per-user override that suppresses its
    mentions for them.
    """

    members = _UserSummarySerializer(many=True, read_only=True)
    member_count = serializers.SerializerMethodField()
    muted_by_me = serializers.SerializerMethodField()

    def get_member_count(self, obj: UserDefinedMentionGroup) -> int:
        # Prefetched by the viewset — len() over the cache, no extra query.
        return len(obj.members.all())

    def get_muted_by_me(self, obj: UserDefinedMentionGroup) -> bool:
        user = getattr(self.context.get("request"), "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return False
        # muted_by is prefetched by the viewset.
        return any(m.pk == user.pk for m in obj.muted_by.all())

    class Meta:
        model = UserDefinedMentionGroup
        fields = [
            "id",
            "server_version",
            "project",
            "name",
            "description",
            "email_default_on",
            "members",
            "member_count",
            "muted_by_me",
        ]
        read_only_fields = fields


class UserDefinedMentionGroupWriteSerializer(serializers.ModelSerializer[UserDefinedMentionGroup]):
    """Write serializer for create/rename/edit — ``project`` is injected from URL.

    Membership and mute are managed through dedicated viewset actions (different
    RBAC), so this serializer covers only the group's own attributes.
    """

    class Meta:
        model = UserDefinedMentionGroup
        fields = ["name", "description", "email_default_on"]

    def validate_name(self, value: str) -> str:
        # Accept a leading @ from the client for convenience; store without it.
        name = value.strip().lstrip("@").strip()
        if not name:
            raise serializers.ValidationError("Group name cannot be empty.")
        if len(name) > 32:
            raise serializers.ValidationError("Group name must be 32 characters or fewer.")
        if not _GROUP_NAME_RE.match(name):
            raise serializers.ValidationError(
                "Group name may only contain letters, digits, and the characters . _ -"
            )
        # An auto-group name (@admins, @scrum-team, …) must never be shadowed.
        if name.lower() in KNOWN_GROUP_KEYS:
            raise serializers.ValidationError(
                f"'@{name}' is a reserved automatic group and cannot be used."
            )
        # Case-insensitive project-uniqueness (the DB constraint is the backstop;
        # this returns a friendly field error instead of a 500 on the race loser).
        project_id = str(self.context.get("project_id"))
        qs = UserDefinedMentionGroup.objects.filter(
            project_id=project_id, name__iexact=name, is_deleted=False
        )
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                f"A group named '@{name}' already exists in this project."
            )
        return name

    def validate_description(self, value: str | None) -> str:
        return (value or "").strip()


class UserSearchResultSerializer(serializers.Serializer[Any]):
    """Read-only serializer for GET /api/v1/users/search/ results (ADR-0061).

    Deliberately omits ``email`` (#815): returning it let any authenticated caller
    paginate the typeahead to harvest every user's email. Identity for the invite
    typeahead is carried by username + display_name + initials; the endpoint still
    *matches* on email so invite-by-email works, but never echoes the value back.
    """

    id = serializers.CharField()
    username = serializers.CharField()
    display_name = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()

    def get_display_name(self, obj: Any) -> str:
        name = f"{obj.first_name} {obj.last_name}".strip()
        return name if name else obj.username

    def get_initials(self, obj: Any) -> str:
        parts: list[str] = []
        if obj.first_name:
            parts.append(obj.first_name[0].upper())
        if obj.last_name:
            parts.append(obj.last_name[0].upper())
        if parts:
            return "".join(parts[:2])
        return str(obj.username[:2].upper())


class MeSerializer(serializers.Serializer[Any]):
    """Read-only serializer for GET /api/v1/auth/me/."""

    id = serializers.UUIDField()
    username = serializers.CharField()
    display_name = serializers.SerializerMethodField()
    initials = serializers.SerializerMethodField()
    email = serializers.EmailField()
    # Contributor-tier role signal (#855/#856). The web client gates the admin
    # settings nav and the "Signal-only" notification default on this, instead of
    # re-deriving "am I an admin anywhere" by fanning out per-project membership
    # calls. API-first: the tier verdict is a server fact, MCP-reachable.
    #   - max_project_role: highest project Role ordinal across the user's
    #     memberships (null if they belong to no projects).
    #   - workspace_role: the user's *effective* WorkspaceRole ordinal — an
    #     explicit membership if present, else the implicit role every
    #     authenticated user holds (OWNER for a Django superuser bootstrapping a
    #     fresh install, else MEMBER); null only for a deactivated membership.
    #     Resolved by workspace.permissions.workspace_role_for_user so this signal
    #     can never drift from what workspace RBAC actually enforces.
    #   - can_access_admin_settings: true iff Admin+ in any project OR Admin+ at
    #     the workspace (the implicit superuser OWNER counts) — the single boolean
    #     the settings shell gates on.
    max_project_role = serializers.SerializerMethodField()
    workspace_role = serializers.SerializerMethodField()
    can_access_admin_settings = serializers.SerializerMethodField()
    # Role-based app front door (ADR-0129). The web router reads these and
    # navigates — it holds no role→surface policy itself. API-first: the
    # destination is a server fact, identical for web, mobile, and MCP clients.
    #   - default_landing: the user's stored preference ("auto" if unset).
    #   - landing: {intent, path, resolved_by} — the resolved front door.
    default_landing = serializers.SerializerMethodField()
    landing = serializers.SerializerMethodField()
    # Per-user nav visibility (ADR-0139). The web shell reads this to hide the
    # view tabs the user opted out of; it is a global per-user list, layered on
    # top of the per-project methodology preset client-side. API-first: the
    # hidden set is a server fact, identical for web, mobile, and MCP clients.
    hidden_views = serializers.SerializerMethodField()
    # Active role-context "lens" (#412, ADR-0162). A presentation-only preference
    # the web shell reads to pick a dual-hat user's default project view and the
    # view-tab emphasis ("pm" / "scrum_master" / "unified"; "unified" if unset).
    # It NEVER gates access — RBAC remains the sole authority; this is read here
    # only so the lens can be reflected without a flash of the wrong view.
    role_context = serializers.SerializerMethodField()

    def get_max_project_role(self, obj: Any) -> int | None:
        # Memoized: get_can_access_admin_settings also needs this, so without the
        # cache /auth/me would run the same aggregate twice per response.
        if not hasattr(self, "_max_project_role"):
            from django.db.models import Max

            value = ProjectMembership.objects.filter(user=obj, is_deleted=False).aggregate(
                _max=Max("role")
            )["_max"]
            self._max_project_role: int | None = int(value) if value is not None else None
        return self._max_project_role

    def get_workspace_role(self, obj: Any) -> int | None:
        # Memoized: get_can_access_admin_settings also reads this. Delegates to the
        # canonical resolver so the superuser-bootstrap and deactivated-status
        # rules match what workspace RBAC enforces (no shadow copy — ADR-0087 §6).
        if not hasattr(self, "_workspace_role"):
            from trueppm_api.apps.workspace.permissions import workspace_role_for_user

            self._workspace_role: int | None = workspace_role_for_user(obj)
        return self._workspace_role

    def get_can_access_admin_settings(self, obj: Any) -> bool:
        from trueppm_api.apps.workspace.models import WorkspaceRole

        proj = self.get_max_project_role(obj)
        ws = self.get_workspace_role(obj)
        return (proj is not None and proj >= Role.ADMIN) or (
            ws is not None and ws >= WorkspaceRole.ADMIN
        )

    def _prefs(self, obj: Any) -> tuple[str, list[str], str]:
        # Memoized single read of (default_landing, hidden_views, role_context):
        # get_landing, get_default_landing, get_hidden_views, and get_role_context
        # all need a UserProfile column, so reading them in one .only() query keeps
        # /auth/me at one profile read regardless of how many fields consume it.
        if not hasattr(self, "_prefs_cache"):
            from trueppm_api.apps.profiles.services import get_profile_prefs

            self._prefs_cache: tuple[str, list[str], str] = get_profile_prefs(obj)
        return self._prefs_cache

    def get_default_landing(self, obj: Any) -> str:
        return self._prefs(obj)[0]

    @extend_schema_field(
        inline_serializer(
            "Landing",
            {
                "intent": serializers.CharField(),
                "path": serializers.CharField(),
                "resolved_by": serializers.CharField(),
            },
        )
    )
    def get_landing(self, obj: Any) -> dict[str, str]:
        from trueppm_api.apps.profiles.services import resolve_landing

        # Reuse the already-computed preference and max project role so the
        # resolver doesn't re-query UserProfile / re-aggregate Max(role) — both
        # are memoized above and computed for sibling fields on this same request.
        landing = resolve_landing(
            obj,
            pref=self.get_default_landing(obj),
            max_role=self.get_max_project_role(obj),
        )
        return {
            "intent": landing.intent,
            "path": landing.path,
            "resolved_by": landing.resolved_by,
        }

    @extend_schema_field(serializers.ListField(child=serializers.CharField()))
    def get_hidden_views(self, obj: Any) -> list[str]:
        return self._prefs(obj)[1]

    # Reuse the model's own choices (not a hardcoded copy) so this enum is
    # byte-identical to UserProfileSerializer.role_context — drf-spectacular then
    # collapses both into one shared ``RoleContextEnum`` component instead of
    # emitting divergent ``MeRoleContextEnum`` / ``UserProfileRoleContextEnum``
    # duplicates for the same pm/scrum_master/unified set.
    @extend_schema_field(serializers.ChoiceField(choices=RoleContext.choices))
    def get_role_context(self, obj: Any) -> str:
        return self._prefs(obj)[2]

    def get_display_name(self, obj: Any) -> str:
        name = f"{obj.first_name} {obj.last_name}".strip()
        return name if name else obj.username

    def get_initials(self, obj: Any) -> str:
        parts: list[str] = []
        if obj.first_name:
            parts.append(obj.first_name[0].upper())
        if obj.last_name:
            parts.append(obj.last_name[0].upper())
        if parts:
            return "".join(parts[:2])
        return str(obj.username[:2].upper())
