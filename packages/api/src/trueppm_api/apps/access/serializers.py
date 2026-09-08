"""Serializers for the access app."""

from __future__ import annotations

import re
from typing import Any

from django.contrib.auth import get_user_model
from django.db.models import Q, QuerySet
from drf_spectacular.utils import extend_schema_field, inline_serializer
from rest_framework import serializers

from trueppm_api.apps.access.groups import ALL_AUTO_GROUP_KEYS
from trueppm_api.apps.access.models import (
    ExternalStakeholder,
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
    program_role_label,
)
from trueppm_api.apps.profiles.models import DateFormat, RoleContext
from trueppm_api.apps.workspace.models import WorkspaceRole
from trueppm_api.apps.workspace.permissions import workspace_role_for_user
from trueppm_api.apps.workspace.serializers import display_name_for

User = get_user_model()

# A mention group key must be a valid mention token (the name class of
# notifications.services._MENTION_RE) so it is actually addressable as @name.
_GROUP_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

# Refusal copy for an unreachable membership target. Deliberately identical for
# "no such account" and "an account you may not name" so the field leaks no
# existence oracle — the same reasoning as ``ProjectSerializer.copy_settings_from``.
_UNREACHABLE_TARGET_ERROR = (
    "No such user, or not someone you can add. You can add people you already share a "
    "project or program with; ask a workspace admin to invite anyone else."
)

_USER_IMMUTABLE_ERROR = (
    "A membership's user cannot be changed. Remove this member and add the other account."
)

_TARGET_HELP_TEXT = (
    "The stock auth.User integer primary key of the account to add. Bounded to accounts "
    "you can already reach: a workspace Admin may name any active account; anyone else "
    "may name themselves or somebody already on a project or program roster they belong "
    "to. Deactivated accounts are never accepted. An id outside that set is refused with "
    "400 and the same message a nonexistent id gets, so this field is not an existence "
    "oracle — use a workspace invite to bring in anyone further out. Accepted on add "
    "only; a membership's user cannot be changed."
)


def reachable_membership_targets(actor: Any) -> QuerySet[Any]:
    """Accounts ``actor`` may name as the target of a membership write (#3641).

    Membership writes take a bare ``auth.User`` integer primary key and answer with
    the target's ``user_detail`` — including their email address. Left unbounded that
    turns a self-minted project into an address-lookup oracle over sequential ids
    (``POST /api/v1/projects/`` is ungated and mints the caller as Owner), which is
    the harvest #815 and #891 were fixed to prevent. So the target set is bounded to
    accounts the caller can *already* read, and a membership grant can therefore never
    disclose an account they could not already see.

    Two tiers, both mirroring rules the install already enforces elsewhere:

    * **Workspace ADMIN or above** reaches every active account. That is the branch
      ``WorkspaceMemberListView`` already takes for the directory listing, and the
      principal that already owns ``/workspace/invites/`` and
      ``/workspace/groups/{id}/members/``. It is not self-grantable: an implicit role
      is MEMBER (superuser bootstrap aside) and an explicit row is written only by an
      existing admin (``workspace_role_for_user``).
    * **Everyone else** reaches themselves plus the people already introduced to a
      project or program roster they belong to — the same "must already be a member"
      constraint ``validate_lead`` and the mention-group ``_member_user_or_400``
      helper apply, with the caller exempt exactly as in
      ``seed.importer._resolve_accounts`` (#1057).

    The caller's *own* membership must be live, but the target's need not be: a revoked
    row is still evidence that somebody with reach introduced that account to this
    roster, and requiring a live one would make re-adding a member you just removed
    impossible — the revive path ``_revive_revoked_membership`` exists for (#3410).

    So "reachable" means **ever introduced to a roster I am on**, not *currently
    readable there*. The deliberate consequence: somebody revoked from a project before
    the caller joined it is nameable even though the caller never saw them on it. That
    is bounded to accounts already adjacent to the caller's own projects, never the
    install, and it is the price of keeping re-add working. Do not silently narrow this
    to the live set without restoring the re-add path some other way.

    ``is_active=False`` accounts are excluded at every tier, matching ``UserSearchView``:
    the deactivated pool is admin-only state (#1724) and must not be reachable through
    a roster write either.

    Bringing in somebody outside that set is the invite path
    (``POST /api/v1/workspace/invites/``). It is keyed on an email address the inviter
    must already possess, so it discloses nothing — it is the reason this narrowing does
    not strand onboarding.

    Args:
        actor: The requesting user. An anonymous or deactivated principal reaches nobody.

    Returns:
        A ``User`` queryset of the accounts ``actor`` may name.
    """
    role = workspace_role_for_user(actor)
    if role is None:
        return User.objects.none()

    active = User.objects.filter(is_active=True)
    if role >= WorkspaceRole.ADMIN:
        return active

    # Subqueries rather than a join + ``.distinct()``: a caller on many projects would
    # otherwise fan the join out per shared roster row, and a bare ``.distinct()`` is
    # silently defeated by any model ordering the queryset picks up.
    # The actor's own row must be live and its scope must still exist — a trashed
    # project's roster is unreadable (``_get_project_or_404`` filters it out), so it
    # must not confer reach either. Archived is deliberately NOT excluded: an archived
    # project is read-only, not invisible, and its members still see each other.
    actor_project_ids = ProjectMembership.objects.filter(
        user=actor, is_deleted=False, project__is_deleted=False
    ).values("project_id")
    actor_program_ids = ProgramMembership.objects.filter(
        user=actor, is_deleted=False, program__is_deleted=False
    ).values("program_id")
    return active.filter(
        Q(pk=actor.pk)
        | Q(
            pk__in=ProjectMembership.objects.filter(project_id__in=actor_project_ids).values(
                "user_id"
            )
        )
        | Q(
            pk__in=ProgramMembership.objects.filter(program_id__in=actor_program_ids).values(
                "user_id"
            )
        )
    )


class _ReachableMembershipTargetMixin:
    """Bounds a membership write serializer's ``user`` field to reachable accounts.

    ``user`` is declared with an **empty** queryset on the concrete serializers, so a
    serializer built without a request context resolves nobody rather than everybody —
    the field is its own IDOR gate, failing closed. Here the real, caller-scoped
    queryset is swapped in (the structural precedent is
    ``ProjectSerializer.__init__``'s ``copy_settings_from`` narrowing).

    On **update** the field is made read-only and a supplied ``user`` is refused
    outright: reassigning an existing row onto another account is the same harvest
    through a second door, and it also silently rewrites who holds access while
    keeping the row's ``joined_at`` access evidence (#3410). Refusing rather than
    ignoring keeps a 200 from meaning two different things to the caller.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        field = self.fields.get("user")  # type: ignore[attr-defined]
        if not isinstance(field, serializers.PrimaryKeyRelatedField):
            return
        if self.instance is not None:  # type: ignore[attr-defined]
            field.read_only = True
            return
        request = self.context.get("request")  # type: ignore[attr-defined]
        actor = getattr(request, "user", None)
        if actor is not None and getattr(actor, "is_authenticated", False):
            field.queryset = reachable_membership_targets(actor)

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        # ``user`` is read-only on update, so DRF drops it silently. Surface the
        # refusal instead — a caller that asked to reassign the row must not read a
        # 200 as "done". Checked against ``initial_data`` because the field never
        # reaches ``attrs``; the body may not be a dict, so do not assume ``in`` works.
        if self.instance is not None:  # type: ignore[attr-defined]
            raw = getattr(self, "initial_data", None)
            if isinstance(raw, dict) and "user" in raw:
                raise serializers.ValidationError({"user": _USER_IMMUTABLE_ERROR})
        return super().validate(attrs)  # type: ignore[misc,no-any-return]


class _UserSummarySerializer(serializers.ModelSerializer):  # type: ignore[type-arg]
    class Meta:
        model = User
        fields = ["id", "username", "email"]


class ProjectMembershipReadSerializer(serializers.ModelSerializer[ProjectMembership]):
    """Response serializer — includes user_detail and role_label for list/retrieve.

    role                       — integer ordinal (canonical wire format; use for comparisons)
    role_label                 — human-readable label e.g. "Project Manager" (display only)
    joined_at                  — when this membership row was first created. Per-project access
                                 evidence, but NOT proof of uninterrupted access: re-adding a
                                 previously removed member revives their original row and keeps
                                 this date, so the span may contain one or more revoked intervals
                                 (#3410). Nothing on the row records the gap.
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
        """Display name for ``role`` in **project** vocabulary.

        Ordinal 400 reads "Project Admin" and 300 reads "Project Manager". The
        identically-named field on a *program* membership deliberately names the
        same two ordinals "Program Admin" and "Program Manager" — see
        ``ProgramMembershipReadSerializer.get_role_label``. One ordinal, two
        containers, two names.
        """
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


class ProjectMembershipWriteSerializer(
    _ReachableMembershipTargetMixin, serializers.ModelSerializer[ProjectMembership]
):
    """Write serializer — accepts user and role; project is injected from URL.

    ``user`` is the stock ``auth.User`` **integer** primary key (TruePPM has no custom
    user model), and it is bounded to :func:`reachable_membership_targets` — see that
    function for who a caller may name and why. It is accepted on add only; a
    ``partial_update`` that carries it is refused (#3641).

    ``role`` is optional (ADR-0363, #157): when omitted on add, the viewset falls
    back to the project's ``default_member_role``. It remains required for a role
    *change* (``partial_update`` always sends it), and the model column stays
    non-null — the fallback is resolved before ``save``.
    """

    # Empty by construction — the mixin swaps in the caller-scoped queryset. Without a
    # request context the field resolves nobody, so it fails closed.
    user = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.none(),
        error_messages={"does_not_exist": _UNREACHABLE_TARGET_ERROR},
        help_text=_TARGET_HELP_TEXT,
    )
    role = serializers.IntegerField(
        required=False,
        help_text=(
            "Optional on add — defaults to the project's default_member_role "
            "(ADR-0363). Required to change an existing member's role."
        ),
    )

    class Meta:
        model = ProjectMembership
        fields = ["user", "role"]

    def validate_role(self, value: int) -> int:
        # Role must be a valid Role ordinal.
        valid = {r.value for r in Role}
        if value not in valid:
            raise serializers.ValidationError(f"Invalid role. Choose from {sorted(valid)}.")
        return value


class ProjectMembershipUpdateSerializer(ProjectMembershipWriteSerializer):
    """PATCH body — ``role`` only.

    A separate class rather than ``read_only_fields`` on the add serializer so the
    published schema tells the truth: ``user`` is genuinely not part of an update
    body, and an integrator reading ``PatchedProjectMembershipWriteRequest`` would
    otherwise still see it advertised as writable. Sending it anyway is refused by
    the inherited ``validate`` rather than silently dropped (#3641).
    """

    class Meta(ProjectMembershipWriteSerializer.Meta):
        fields = ["role"]


class ProgramMembershipReadSerializer(serializers.ModelSerializer[ProgramMembership]):
    """Response serializer for ProgramMembership — mirrors the project version.

    ``joined_at`` carries the same caveat as its project twin: it is the date the row
    was first created, and a revoked member who is later re-added keeps it, so the
    span may contain revoked intervals (#3410). It is not proof of uninterrupted
    access.
    """

    user_detail = _UserSummarySerializer(source="user", read_only=True)
    # ``role_label`` is the *access* role's display name (Owner/Admin/…), a
    # computed mirror of the ``role`` ordinal — NOT the freeform functional title.
    # The freeform PO/PM/Tech-Lead label is the distinct ``role_title`` field
    # below (#565); the two never collide.
    role_label = serializers.SerializerMethodField()

    def get_role_label(self, obj: ProgramMembership) -> str:
        """Display name for ``role`` in **program** vocabulary.

        Ordinal 400 reads "Program Admin" and 300 reads "Program Manager" — the
        same names ``Program.my_role_label`` uses, from the same map. An ordinal
        outside the five OSS roles has no name and reads ``"Role <ordinal>"``.
        """
        # Why this is not ``Role.label``: the enum's labels are project-scoped, so
        # serializing through them called a *program* membership "Project Admin"
        # here while the program card called the same membership "Program Admin"
        # — one fact, two answers, and only TruePPM's own web client knew which to
        # believe (#3503). ``program_role_label`` is the one definition of that
        # vocabulary and the program card calls it too.
        #
        # The fallback covers an Enterprise custom-band ordinal (ADR-0072), which
        # the OSS edition cannot name. The field is a non-null string in the
        # published schema and the ordinal is already on the wire beside it in
        # ``role``, so echoing it degrades rather than borrowing a neighbouring
        # role's name — and rather than the ``ValueError`` this used to raise,
        # which DRF does not convert and which 500'd the whole response.
        return program_role_label(obj.role) or f"Role {obj.role}"

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


class ProgramMembershipWriteSerializer(
    _ReachableMembershipTargetMixin, serializers.ModelSerializer[ProgramMembership]
):
    """Write serializer — accepts user, role, and the freeform role_title.

    ``user`` is the stock ``auth.User`` **integer** primary key, bounded to
    :func:`reachable_membership_targets` on add and refused entirely on
    ``partial_update`` (#3641) — the project twin carries the same constraint for the
    same reason.

    ``program`` is injected from the URL. ``role_title`` (#565) is optional; the
    view gates *who* may set it (a role change stays Owner-only, while a
    role_title-only PATCH is allowed at Admin+).
    """

    # Empty by construction — see the project twin.
    user = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.none(),
        error_messages={"does_not_exist": _UNREACHABLE_TARGET_ERROR},
        help_text=_TARGET_HELP_TEXT,
    )

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


class ProgramMembershipUpdateSerializer(ProgramMembershipWriteSerializer):
    """PATCH body — ``role`` and ``role_title`` only; see the project twin for why."""

    class Meta(ProgramMembershipWriteSerializer.Meta):
        fields = ["role", "role_title"]


class UserDefinedMentionGroupReadSerializer(serializers.ModelSerializer[UserDefinedMentionGroup]):
    """Response serializer for a user-defined @mention group (ADR-0212, #515).

    ``members`` is the curated member set (summary detail); ``member_count`` is a
    convenience for the list UI. ``muted_by_me`` reflects whether the *requesting*
    user has muted this group — the per-user override that suppresses its
    mentions for them.
    """

    members = _UserSummarySerializer(many=True, read_only=True)
    member_count = serializers.SerializerMethodField()
    muted_by_me = serializers.SerializerMethodField()

    def get_member_count(self, obj: UserDefinedMentionGroup) -> int:
        # `members` is already prefetched by the viewset (it also backs the
        # ``members`` field), so counting the loaded rows in Python is free. A
        # DB-side ``.count()`` here would be a wasted round trip, not a saving.
        members = obj.members.all()
        return len(members)

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
        # An auto-group name (@admins, @scrum-team, @program-pms, …) must never
        # be shadowed — project- and program-scoped keys alike.
        if name.lower() in ALL_AUTO_GROUP_KEYS:
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


class ProgramUserDefinedMentionGroupReadSerializer(
    serializers.ModelSerializer[ProgramUserDefinedMentionGroup]
):
    """Response serializer for a program-scoped @mention group (ADR-0248, #516).

    The program-scoped mirror of :class:`UserDefinedMentionGroupReadSerializer`.
    ``members`` is the curated member set (drawn from across the program's
    projects); ``member_count`` is a list-UI convenience; ``muted_by_me`` reflects
    whether the *requesting* user has muted this group.
    """

    members = _UserSummarySerializer(many=True, read_only=True)
    member_count = serializers.SerializerMethodField()
    muted_by_me = serializers.SerializerMethodField()

    def get_member_count(self, obj: ProgramUserDefinedMentionGroup) -> int:
        # members is prefetched by the viewset (it also backs the members field),
        # so counting the loaded rows in Python is free (no extra round trip).
        members = obj.members.all()
        return len(members)

    def get_muted_by_me(self, obj: ProgramUserDefinedMentionGroup) -> bool:
        user = getattr(self.context.get("request"), "user", None)
        if user is None or not getattr(user, "is_authenticated", False):
            return False
        # muted_by is prefetched by the viewset.
        return any(m.pk == user.pk for m in obj.muted_by.all())

    class Meta:
        model = ProgramUserDefinedMentionGroup
        fields = [
            "id",
            "server_version",
            "program",
            "name",
            "description",
            "email_default_on",
            "members",
            "member_count",
            "muted_by_me",
        ]
        read_only_fields = fields


class ProgramUserDefinedMentionGroupWriteSerializer(
    serializers.ModelSerializer[ProgramUserDefinedMentionGroup]
):
    """Write serializer for program-group create/rename/edit — ``program`` from URL.

    Membership and mute are managed through dedicated viewset actions (different
    RBAC), so this serializer covers only the group's own attributes.
    """

    class Meta:
        model = ProgramUserDefinedMentionGroup
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
        # An auto-group name (@admins, @scrum-team, @program-pms, …) must never be
        # shadowed — project- and program-scoped keys alike.
        if name.lower() in ALL_AUTO_GROUP_KEYS:
            raise serializers.ValidationError(
                f"'@{name}' is a reserved automatic group and cannot be used."
            )
        # Case-insensitive program-uniqueness (the DB constraint is the backstop;
        # this returns a friendly field error instead of a 500 on the race loser).
        program_id = str(self.context.get("program_id"))
        qs = ProgramUserDefinedMentionGroup.objects.filter(
            program_id=program_id, name__iexact=name, is_deleted=False
        )
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                f"A group named '@{name}' already exists in this program."
            )
        return name

    def validate_description(self, value: str | None) -> str:
        return (value or "").strip()


class ExternalStakeholderSerializer(serializers.ModelSerializer[ExternalStakeholder]):
    """CRUD serializer for a program's external stakeholder registry (#1658, ADR-0264).

    ``created_by`` is echoed as the adder's display name (never the raw user row);
    ``program`` comes from the URL and is never accepted from the body (IDOR-safe —
    the viewset scopes and stamps it). Case-insensitive per-program email uniqueness
    is validated here so the client gets a friendly field error instead of the DB
    constraint's 500 on the race loser.
    """

    created_by = serializers.SerializerMethodField()

    class Meta:
        model = ExternalStakeholder
        fields = ["id", "name", "email", "note", "created_by", "created_at", "updated_at"]
        read_only_fields = ["id", "created_by", "created_at", "updated_at"]

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_created_by(self, obj: ExternalStakeholder) -> str | None:
        user = obj.created_by
        if user is None:
            return None
        return display_name_for(user.first_name, user.last_name, user.username)

    def validate_name(self, value: str) -> str:
        name = value.strip()
        if not name:
            raise serializers.ValidationError("Name cannot be empty.")
        return name

    def validate_note(self, value: str | None) -> str:
        return (value or "").strip()

    def validate_email(self, value: str) -> str:
        email = value.strip()
        # Case-insensitive per-program uniqueness across LIVE rows (the DB
        # constraint is the backstop; this returns a friendly 400 on the race loser
        # and on the common re-add-of-existing case).
        program_id = str(self.context.get("program_id"))
        qs = ExternalStakeholder.objects.filter(
            program_id=program_id, email__iexact=email, is_deleted=False
        )
        if self.instance is not None:
            qs = qs.exclude(pk=self.instance.pk)
        if qs.exists():
            raise serializers.ValidationError(
                "A stakeholder with this email already exists in this program."
            )
        return email


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
    # Account-wide Do-Not-Disturb (#1707, ADR-0292). Read-only projection so the
    # web current-user query carries the DND state and the bell reflects it with no
    # extra request; the authoritative read/write surface is
    # /api/v1/me/notification-settings/. Non-creating on this hot GET path — the
    # absence of a settings row reads as DND off.
    dnd_enabled = serializers.SerializerMethodField()
    # Personal display frame (#1953, ADR-0410). Read-only projections the web client
    # reads to render timestamps/dates in the viewer's frame. API-first: these are
    # server facts (identical for web, mobile, MCP) but purely presentational — the
    # API itself always emits aware-UTC ISO-8601; an agent ignores them.
    #   - timezone: IANA zone for instant timestamps, or "auto" (browser zone).
    #   - date_format: style for all displayed dates ("auto"/"iso"/"us"/"eu").
    timezone = serializers.SerializerMethodField()
    date_format = serializers.SerializerMethodField()

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

    def _prefs(self, obj: Any) -> tuple[str, list[str], str, str, str]:
        # Memoized single read of (default_landing, hidden_views, role_context,
        # timezone, date_format): every pref getter needs a UserProfile column, so
        # reading them in one .only() query keeps /auth/me at one profile read
        # regardless of how many fields consume it.
        if not hasattr(self, "_prefs_cache"):
            from trueppm_api.apps.profiles.services import get_profile_prefs

            self._prefs_cache: tuple[str, list[str], str, str, str] = get_profile_prefs(obj)
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

    @extend_schema_field(serializers.CharField())
    def get_timezone(self, obj: Any) -> str:
        return self._prefs(obj)[3]

    # Reuse the model's own choices (not a hardcoded copy) so drf-spectacular
    # collapses this and UserProfileSerializer.date_format into one shared
    # ``DateFormatEnum`` component instead of divergent Me/UserProfile duplicates.
    @extend_schema_field(serializers.ChoiceField(choices=DateFormat.choices))
    def get_date_format(self, obj: Any) -> str:
        return self._prefs(obj)[4]

    @extend_schema_field(serializers.BooleanField())
    def get_dnd_enabled(self, obj: Any) -> bool:
        from trueppm_api.apps.notifications.models import UserNotificationSettings

        return (
            UserNotificationSettings.objects.filter(user=obj)
            .values_list("dnd_enabled", flat=True)
            .first()
            or False
        )

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
