"""Service-layer helpers for the workspace app (ADR-0087).

Three multi-row transactions live here:

- :func:`reconcile_group_access` — the Group→project access **cascade**. It
  materializes, updates, and removes ``ProjectMembership`` rows so that every
  (group member × linked project) pair has the project ``Role`` the group
  confers. Reconciliation is idempotent and recomputed from scratch per affected
  pair, so it is safe to call after any group/member/link/role change.

- :func:`accept_invite` — atomically provisions (or links) a user account and
  creates the ``WorkspaceMembership`` from a token-bearing invite.

- :func:`create_invite` — issues a pending invite with a one-time token.

The owner-counting helpers back the last-owner guard: a workspace must never be
left without at least one active owner (explicit OWNER membership or an active
Django superuser).
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import uuid
from typing import Any

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.utils import timezone

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.workspace.models import (
    GroupMembership,
    GroupProject,
    InviteStatus,
    MemberStatus,
    Workspace,
    WorkspaceInvite,
    WorkspaceMembership,
    WorkspaceRole,
)

logger = logging.getLogger(__name__)

_PK = uuid.UUID | str


class InviteError(Exception):
    """Raised when an invite cannot be accepted (invalid/expired token, etc.).

    The message is deliberately generic for token failures to avoid leaking
    whether a given token exists (enumeration).
    """


# ---------------------------------------------------------------------------
# Owner counting / last-owner guard
# ---------------------------------------------------------------------------


def workspace_owner_user_ids(exclude_user_id: _PK | None = None) -> set[Any]:
    """Return the set of user ids that currently hold workspace-owner authority.

    An owner is an active explicit OWNER ``WorkspaceMembership`` **or** an active
    Django superuser with no explicit (overriding) membership row. ``exclude_user_id``
    drops a candidate so callers can ask "who would remain if I changed this user?".
    """
    User = get_user_model()
    owners: set[Any] = set(
        WorkspaceMembership.objects.filter(
            role=WorkspaceRole.OWNER,
            status=MemberStatus.ACTIVE,
            is_deleted=False,
        ).values_list("user_id", flat=True)
    )
    # Active superusers are implicit owners unless an explicit row overrides them
    # (that row's role is already reflected above if it is OWNER).
    explicit_ids = set(
        WorkspaceMembership.objects.filter(is_deleted=False).values_list("user_id", flat=True)
    )
    for uid in User.objects.filter(is_superuser=True, is_active=True).values_list("id", flat=True):
        if uid not in explicit_ids:
            owners.add(uid)
    if exclude_user_id is not None:
        owners.discard(exclude_user_id)
    return owners


def would_strand_workspace(user_id: _PK) -> bool:
    """True if removing/demoting ``user_id`` would leave the workspace ownerless."""
    return len(workspace_owner_user_ids(exclude_user_id=user_id)) == 0


# ---------------------------------------------------------------------------
# Group → project access cascade (ADR-0087 §5)
# ---------------------------------------------------------------------------


def _build_confer_map(
    user_ids: set[Any], project_ids: set[Any]
) -> dict[tuple[Any, Any], tuple[int, Any]]:
    """Bulk-compute the conferred project ``Role`` per (user, project) pair.

    Returns ``{(user_id, project_id): (role, source_group_id)}`` for the highest
    role any active group the user belongs to confers on that project. Replaces a
    per-pair query with two bulk reads (GroupProject + GroupMembership), so a
    cascade over M members × P projects costs O(1) queries, not O(M·P).
    """
    gp_rows = list(
        GroupProject.objects.filter(
            project_id__in=project_ids, group__is_deleted=False
        ).values_list("project_id", "group_id", "role")
    )
    involved_group_ids = {gid for _, gid, _ in gp_rows}
    members_by_group: dict[Any, set[Any]] = {}
    for gid, uid in GroupMembership.objects.filter(
        group_id__in=involved_group_ids, is_deleted=False, user_id__in=user_ids
    ).values_list("group_id", "user_id"):
        members_by_group.setdefault(gid, set()).add(uid)

    confer: dict[tuple[Any, Any], tuple[int, Any]] = {}
    for project_id, gid, role in gp_rows:
        for uid in members_by_group.get(gid, ()):
            key = (uid, project_id)
            current = confer.get(key)
            if current is None or role > current[0]:
                confer[key] = (int(role), gid)
    return confer


def _reconcile_pair(
    user_id: Any,
    project_id: Any,
    confer_entry: tuple[int, Any] | None,
    existing: ProjectMembership | None,
    now: Any,
    events: list[tuple[Any, str, dict[str, Any]]],
) -> None:
    """Reconcile one (user, project) pair from pre-fetched confer + existing data.

    A direct membership (``source_group IS NULL``) always wins and is never
    touched. Otherwise the group-derived row is created, role-synced, resurrected,
    or removed to match the conferred role. Board events are appended to ``events``.
    """
    confer_role, src_group_id = confer_entry if confer_entry is not None else (None, None)

    # Direct grant wins — group reconciliation must not alter or revoke it.
    if existing is not None and not existing.is_deleted and existing.source_group_id is None:
        return

    if confer_role is None:
        if (
            existing is not None
            and not existing.is_deleted
            and existing.source_group_id is not None
        ):
            existing.soft_delete()
            events.append(
                (
                    project_id,
                    "member_removed",
                    {"membership_id": str(existing.pk), "user_id": str(user_id)},
                )
            )
        return

    if existing is None:
        pm = ProjectMembership.objects.create(
            project_id=project_id,
            user_id=user_id,
            role=confer_role,
            source_group_id=src_group_id,
        )
        events.append(
            (
                project_id,
                "member_added",
                {"membership_id": str(pm.pk), "user_id": str(user_id), "role": confer_role},
            )
        )
    elif existing.is_deleted:
        # Resurrect a previously-removed row as group-derived (unique_together on
        # (project, user) means we cannot insert a second row).
        existing.is_deleted = False
        existing.deleted_version = None
        existing.role = confer_role
        existing.source_group_id = src_group_id
        existing.role_changed_at = now
        existing.save()
        events.append(
            (
                project_id,
                "member_added",
                {"membership_id": str(existing.pk), "user_id": str(user_id), "role": confer_role},
            )
        )
    else:
        changed: list[str] = []
        role_changed = existing.role != confer_role
        if role_changed:
            existing.role = confer_role
            existing.role_changed_at = now
            changed += ["role", "role_changed_at"]
        if existing.source_group_id != src_group_id:
            existing.source_group_id = src_group_id
            changed.append("source_group")
        if changed:
            existing.save(update_fields=changed)
            # Only broadcast member_role_changed when the role actually moved — a
            # pure source_group reattribution (e.g. one of two overlapping groups
            # removed, role unchanged) is invisible to board consumers.
            if role_changed:
                events.append(
                    (
                        project_id,
                        "member_role_changed",
                        {
                            "membership_id": str(existing.pk),
                            "user_id": str(user_id),
                            "role": existing.role,
                        },
                    )
                )


@transaction.atomic
def reconcile_group_access(group_id: Any) -> None:
    """Reconcile all affected (member × project) pairs for a group.

    Considers the union of the group's current desired pairs (active members ×
    linked projects) and any pair still attributed to this group in
    ``ProjectMembership.source_group`` (so removals are caught when a member or
    project link is dropped, or the group is soft-deleted). Reconciliation is
    global across groups (overlaps resolve to the highest conferred role) and is
    driven by bulk reads — three queries regardless of group size.
    """
    member_ids = list(
        GroupMembership.objects.filter(group_id=group_id, is_deleted=False).values_list(
            "user_id", flat=True
        )
    )
    project_ids = list(
        GroupProject.objects.filter(group_id=group_id).values_list("project_id", flat=True)
    )
    desired = {(u, p) for u in member_ids for p in project_ids}
    attributed = set(
        ProjectMembership.objects.filter(source_group_id=group_id, is_deleted=False).values_list(
            "user_id", "project_id"
        )
    )
    pairs = desired | attributed
    if not pairs:
        return

    user_ids = {u for u, _ in pairs}
    proj_ids = {p for _, p in pairs}
    confer = _build_confer_map(user_ids, proj_ids)
    # Lock the candidate membership rows once (one query), then reconcile in memory.
    existing = {
        (m.user_id, m.project_id): m
        for m in ProjectMembership.objects.select_for_update().filter(
            user_id__in=user_ids, project_id__in=proj_ids
        )
    }

    now = timezone.now()
    events: list[tuple[Any, str, dict[str, Any]]] = []
    for user_id, project_id in pairs:
        _reconcile_pair(
            user_id,
            project_id,
            confer.get((user_id, project_id)),
            existing.get((user_id, project_id)),
            now,
            events,
        )
    _broadcast_membership_events(events)


def _broadcast_membership_events(events: list[tuple[Any, str, dict[str, Any]]]) -> None:
    """Defer best-effort board broadcasts for each cascade-affected project."""
    if not events:
        return

    def _send() -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        for project_id, event_type, payload in events:
            broadcast_board_event(str(project_id), event_type, payload)

    transaction.on_commit(_send)


# ---------------------------------------------------------------------------
# Invites
# ---------------------------------------------------------------------------


def create_invite(
    *,
    workspace: Workspace,
    email: str,
    role: int,
    invited_by: Any,
) -> WorkspaceInvite:
    """Create a pending invite with a one-time token and queue its email.

    The raw token is generated here, hashed for the durable credential, and kept
    in ``email_token`` only until the drain sends the link (ADR-0087 §4).
    """
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    return WorkspaceInvite.objects.create(
        workspace=workspace,
        email=email,
        role=role,
        token_hash=token_hash,
        email_token=raw_token,
        invited_by=invited_by,
        expires_at=WorkspaceInvite.default_expiry(),
        email_pending=True,
    )


def accept_invite(*, token: str, username: str = "", password: str = "") -> Any:
    """Provision (or link) a user and create their workspace membership.

    Looks the invite up by token hash, validates it is pending and unexpired,
    then atomically links an existing user matching the invite email or creates
    a new account from ``username``/``password``. Idempotent under a double-submit:
    the status flips ``pending → accepted`` under a row lock.

    The expiry-marking write is done as a standalone autocommit ``update`` (not
    inside the provisioning ``atomic`` block) so it survives the ``InviteError``
    raise — otherwise the rollback would revert it and leave the invite pending.

    Raises:
        InviteError: invalid/expired token, or account-creation conflict.
    """
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    try:
        invite = WorkspaceInvite.objects.get(token_hash=token_hash)
    except WorkspaceInvite.DoesNotExist as exc:
        raise InviteError("This invitation link is invalid or has expired.") from exc

    if invite.status != InviteStatus.PENDING or invite.is_expired:
        if invite.status == InviteStatus.PENDING and invite.is_expired:
            WorkspaceInvite.objects.filter(pk=invite.pk).update(
                status=InviteStatus.EXPIRED, email_pending=False, email_token=""
            )
        raise InviteError("This invitation link is invalid or has expired.")

    User = get_user_model()
    user = User.objects.filter(email__iexact=invite.email).first()
    if user is None and (not username or not password):
        raise InviteError("A username and password are required to accept this invitation.")

    with transaction.atomic():
        # Re-fetch under a row lock to make a double-submit create exactly one
        # membership (the second caller sees status != PENDING and bails).
        invite = WorkspaceInvite.objects.select_for_update().get(pk=invite.pk)
        if invite.status != InviteStatus.PENDING:
            raise InviteError("This invitation link is invalid or has expired.")

        if user is None:
            try:
                user = User.objects.create_user(
                    username=username, email=invite.email.lower(), password=password
                )
            except IntegrityError as exc:
                raise InviteError("That username is already taken.") from exc

        now = timezone.now()
        membership, created = WorkspaceMembership.objects.get_or_create(
            workspace=invite.workspace,
            user=user,
            defaults={"role": invite.role, "status": MemberStatus.ACTIVE},
        )
        if not created:
            changed = False
            if membership.status == MemberStatus.DEACTIVATED:
                membership.status = MemberStatus.ACTIVE
                changed = True
            if invite.role > membership.role:
                membership.role = invite.role
                membership.role_changed_at = now
                changed = True
            if changed:
                membership.save()

        invite.status = InviteStatus.ACCEPTED
        invite.accepted_at = now
        invite.accepted_user = user
        invite.email_pending = False
        invite.email_token = ""  # consume the raw token
        invite.save(
            update_fields=[
                "status",
                "accepted_at",
                "accepted_user",
                "email_pending",
                "email_token",
            ]
        )
    return user
