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
from django.contrib.auth.password_validation import validate_password

# ``ValidationError`` here is Django's (used for the ownership-transfer guards and
# the password-policy check) — distinct from DRF's ValidationError raised in views.
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from trueppm_api.apps.access.models import ProjectMembership
from trueppm_api.apps.workspace.models import (
    AuditEvent,
    AuditEventType,
    ExportJobStatus,
    GroupMembership,
    GroupProject,
    InviteStatus,
    MemberStatus,
    Workspace,
    WorkspaceExportJob,
    WorkspaceInvite,
    WorkspaceMembership,
    WorkspaceRole,
)
from trueppm_api.apps.workspace.signals import audit_event_created

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
# Operational audit log (ADR-0157, #859)
# ---------------------------------------------------------------------------


def _actor_label(actor: Any) -> str:
    """Human-readable display for an audit actor, captured at event time.

    Denormalized onto the row so the log stays readable after the user is deleted
    (the ``actor`` FK then resolves to NULL). Prefers a full name, then email,
    then username; an absent actor (system action) yields an empty string.
    """
    if actor is None or not getattr(actor, "pk", None):
        return ""
    full_name = ""
    get_full_name = getattr(actor, "get_full_name", None)
    if callable(get_full_name):
        full_name = (get_full_name() or "").strip()
    label = full_name or getattr(actor, "email", "") or actor.get_username()
    return label[:255]


def record_audit_event(
    *,
    event_type: str,
    actor: Any,
    target_type: str = "",
    target_id: Any = None,
    target_label: str = "",
    metadata: dict[str, Any] | None = None,
) -> AuditEvent:
    """Write one operational ``AuditEvent`` and fan it out to enterprise receivers.

    The single choke point for the OSS audit log (ADR-0157): every emission site
    calls this rather than ``AuditEvent.objects.create`` directly. The row is
    written synchronously inside the caller's transaction (so it rolls back with a
    failed action — the log never claims an action that did not happen), and the
    ``audit_event_created`` signal is fired from ``transaction.on_commit`` with
    ``send_robust`` so a raising enterprise receiver is swallowed-and-logged and
    can never break the OSS write path. OSS itself connects no receiver.
    """
    event = AuditEvent.objects.create(
        actor=actor if (actor is not None and getattr(actor, "pk", None)) else None,
        actor_label=_actor_label(actor),
        event_type=event_type,
        target_type=target_type,
        target_id=target_id,
        target_label=(target_label or "")[:512],
        metadata=metadata or {},
    )
    transaction.on_commit(
        lambda: audit_event_created.send_robust(sender=AuditEvent, audit_event=event)
    )
    return event


# ---------------------------------------------------------------------------
# Lifecycle: transfer ownership / export / delete (ADR-0174, #641)
# ---------------------------------------------------------------------------


def transfer_workspace_ownership(*, new_owner: Any, actor: Any) -> WorkspaceMembership:
    """Atomically promote a workspace member to OWNER, demote the actor to ADMIN.

    Mirrors :func:`access.services.transfer_project_ownership`. The target must
    already be an **active** workspace member — requiring an explicit membership
    forces an invite step and keeps a clean "joined → promoted" audit sequence.

    The actor's explicit OWNER row (if any) is demoted to ADMIN. If the actor is
    an *implicit* owner (an active superuser with no explicit row), nothing is
    demoted — there is no row to change and the superuser bootstrap is intentional.
    Promoting the target always leaves at least one owner, so this never strands
    the workspace.

    Args:
        new_owner: The user who will become OWNER.
        actor: The current owner initiating the transfer.

    Returns:
        The new owner's ``WorkspaceMembership`` row.

    Raises:
        ValidationError: if ``new_owner`` is the actor, or has no active membership.
    """
    if new_owner.pk == actor.pk:
        raise ValidationError("You already own this workspace.")

    # Defense in depth — the view gates with ``IsWorkspaceOwner``, but the service
    # is reusable (management commands, signals, future endpoints). Without this an
    # actor who is not actually an owner would promote the target while no one is
    # demoted, minting an extra owner. Assert authority before any state change.
    if actor.pk not in workspace_owner_user_ids():
        raise ValidationError("Only an existing workspace Owner can transfer ownership.")

    with transaction.atomic():
        try:
            target = WorkspaceMembership.objects.select_for_update().get(
                user=new_owner,
                is_deleted=False,
            )
        except WorkspaceMembership.DoesNotExist as exc:
            raise ValidationError(
                "The new owner must already be an active workspace member."
            ) from exc
        if target.status == MemberStatus.DEACTIVATED:
            raise ValidationError("The new owner must be an active workspace member.")

        # Promote the target first so the workspace is never momentarily ownerless.
        if target.role != WorkspaceRole.OWNER:
            target.role = WorkspaceRole.OWNER
            target.role_changed_at = timezone.now()
            target.save(update_fields=["role", "role_changed_at"])

        # Demote the actor's explicit OWNER row, if they have one.
        actor_row = (
            WorkspaceMembership.objects.select_for_update()
            .filter(user=actor, is_deleted=False)
            .first()
        )
        if actor_row is not None and actor_row.role == WorkspaceRole.OWNER:
            actor_row.role = WorkspaceRole.ADMIN
            actor_row.role_changed_at = timezone.now()
            actor_row.save(update_fields=["role", "role_changed_at"])

        # Audit inside the same transaction so the row rolls back with a failed
        # transfer. target_id is left null — a User PK is an int, not a UUID — and
        # the new owner's id is carried in metadata instead (ADR-0157).
        record_audit_event(
            event_type=AuditEventType.OWNERSHIP_TRANSFERRED,
            actor=actor,
            target_type="member",
            target_label=_actor_label(new_owner),
            metadata={"new_owner_user_id": new_owner.pk},
        )

    return target


def enqueue_workspace_export(*, requested_by: Any) -> WorkspaceExportJob:
    """Create an export job row and best-effort dispatch the Celery task (ADR-0174).

    Follows the transactional-outbox convention (ADR-0080): the row commits with
    the request; ``.delay()`` is attempted in ``transaction.on_commit`` and broker
    errors are swallowed because ``drain_workspace_exports`` re-dispatches stuck
    ``pending`` rows. ``.delay()`` is only ever called from here and the drain.

    De-dupes in-flight work: a full-workspace archive is expensive, so if an export
    is already ``pending``/``running`` the existing job is returned rather than
    queuing a second build (also bounds an owner triggering repeated exports).
    """
    existing = WorkspaceExportJob.objects.filter(
        status__in=[ExportJobStatus.PENDING, ExportJobStatus.RUNNING]
    ).first()
    if existing is not None:
        return existing

    job = WorkspaceExportJob.objects.create(requested_by=requested_by)

    # Audit only the path that actually queues a new export — the dedupe branch
    # above returns an in-flight job without minting work, so it is not an event.
    record_audit_event(
        event_type=AuditEventType.EXPORT_TRIGGERED,
        actor=requested_by,
        target_type="workspace_export",
        target_id=job.id,
        target_label="Workspace export",
    )

    def _dispatch() -> None:
        from trueppm_api.apps.workspace.tasks import run_workspace_export

        try:
            run_workspace_export.delay(str(job.id))
        except Exception:  # pragma: no cover - broker-down path, drain recovers
            logger.warning(
                "broker unavailable; drain_workspace_exports will pick up export %s", job.id
            )

    transaction.on_commit(_dispatch)
    return job


def purge_workspace() -> None:
    """Hard-delete every workspace-scoped row and the singleton itself (ADR-0174).

    Because ``Workspace.load()`` re-materializes the singleton on next access,
    deleting the row is a factory reset: the next request gets a fresh default
    workspace. Deletes run in FK-safe order in one transaction — ``PROTECT``
    membership rows (project/program) and ``Project``-referenced ``Calendar`` rows
    must be removed before their referents, so a naive ``Workspace.delete()``
    cascade is not enough.
    """
    # Imported lazily: this is the only place the workspace service reaches across
    # into the projects/access/resources models, and doing it at module load would
    # widen the import graph for every workspace request.
    from trueppm_api.apps.access.models import ProgramMembership
    from trueppm_api.apps.projects.models import Calendar, Program, Project
    from trueppm_api.apps.resources.models import Resource, Skill

    with transaction.atomic():
        # Group access cascade first (GroupProject/GroupMembership → Group).
        GroupProject.objects.all().delete()
        GroupMembership.objects.all().delete()
        from trueppm_api.apps.workspace.models import Group

        Group.objects.all().delete()
        WorkspaceInvite.objects.all().delete()
        WorkspaceMembership.objects.all().delete()
        # PROTECT memberships must precede their parents.
        ProjectMembership.objects.all().delete()
        ProgramMembership.objects.all().delete()
        # Projects cascade tasks/deps/baselines/sprints/risks/attachments/etc.
        Project.objects.all().delete()
        Program.objects.all().delete()
        # Workspace-global flat tables (no project/workspace FK).
        Resource.objects.all().delete()
        Skill.objects.all().delete()
        # Calendars are PROTECT-referenced by Project; safe now projects are gone.
        Calendar.objects.all().delete()
        WorkspaceExportJob.objects.all().delete()
        Workspace.objects.all().delete()


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


# Statuses an admin may resend (ADR-0149). PENDING covers a lost/bounced live
# invite; FAILED is a send-exhausted invite — resend is its recovery path. An
# ACCEPTED/REVOKED/EXPIRED invite is intentionally *not* revivable.
RESENDABLE_INVITE_STATUSES = (InviteStatus.PENDING, InviteStatus.FAILED)

_RESEND_UPDATE_FIELDS = [
    "token_hash",
    "email_token",
    "status",
    "expires_at",
    "email_pending",
    "email_sent_at",
    "email_failed_at",
    "email_attempts",
]


def _reissue_invite_token(invite: WorkspaceInvite) -> None:
    """Reset an (unsaved, locked) invite back into the drain-eligible queued shape.

    Regenerates the one-time token — so any link in a previously-sent email stops
    working, which is the correct posture for a re-issue (ADR-0149) — and clears the
    outbox columns (``email_pending`` on, ``email_sent_at``/``email_failed_at`` off,
    attempts zeroed) so the existing ``drain_invite_emails`` picks the row up on its
    next 30 s tick. ``created_at`` is unchanged, so the resend clears the drain's
    5-min orphan window immediately (unlike a fresh create).
    """
    raw_token = secrets.token_urlsafe(32)
    invite.token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    invite.email_token = raw_token
    invite.status = InviteStatus.PENDING
    invite.expires_at = WorkspaceInvite.default_expiry()
    invite.email_pending = True
    invite.email_sent_at = None
    invite.email_failed_at = None
    invite.email_attempts = 0


def _is_in_flight(invite: WorkspaceInvite) -> bool:
    """True if a send is already queued and not yet sent (idempotent-resend guard).

    A double-click on Resend (or a created-but-not-yet-drained invite) must not
    re-issue a token the drain is about to send with the *current* token, so resend
    is a no-op for these rows.
    """
    return invite.email_pending and invite.email_sent_at is None


def drain_invite_emails_soon() -> None:
    """Best-effort nudge the invite-email drain to run now instead of next tick.

    A resend re-queues a row whose ``created_at`` is already past the 5-min orphan
    window, so it's drain-eligible immediately — this just shortens the wait from the
    30 s Beat cadence to "right after commit". Broker errors are swallowed: the
    periodic ``drain_invite_emails`` is the durability guarantee, this is only an
    optimization (ADR-0149). Call inside ``transaction.on_commit``.
    """
    from trueppm_api.apps.workspace.tasks import drain_invite_emails

    try:
        drain_invite_emails.delay()
    except Exception:  # pragma: no cover - broker-down path, periodic drain recovers
        logger.warning("broker unavailable; periodic drain_invite_emails will send resends")


def resend_invite(invite_id: _PK) -> WorkspaceInvite | None:
    """Re-queue one resendable invite's email with a fresh token (ADR-0149).

    Returns the invite on success, the unchanged invite when it is already in
    flight (idempotent no-op), or ``None`` when it does not exist or is not
    resendable (accepted/revoked/expired) — the view maps ``None`` to 409/404.
    Locks the row so a concurrent double-submit re-issues at most once.
    """
    with transaction.atomic():
        invite = WorkspaceInvite.objects.select_for_update().filter(pk=invite_id).first()
        if invite is None or invite.status not in RESENDABLE_INVITE_STATUSES:
            return None
        if _is_in_flight(invite):
            return invite
        _reissue_invite_token(invite)
        invite.save(update_fields=_RESEND_UPDATE_FIELDS)
    return invite


def resend_all_pending(workspace: Workspace) -> int:
    """Re-queue every resendable invite in one transaction; return the count.

    Bundled into a single transaction so "Resend all" is one throttle bucket hit
    (ADR-0149) and can never email-bomb regardless of how many invites are pending.
    In-flight rows are skipped, so the returned count reflects only rows actually
    re-issued.
    """
    count = 0
    with transaction.atomic():
        invites = list(
            WorkspaceInvite.objects.select_for_update().filter(
                workspace=workspace,
                status__in=RESENDABLE_INVITE_STATUSES,
            )
        )
        for invite in invites:
            if _is_in_flight(invite):
                continue
            _reissue_invite_token(invite)
            invite.save(update_fields=_RESEND_UPDATE_FIELDS)
            count += 1
    return count


# ---------------------------------------------------------------------------
# Workspace logo (ADR-0149, #969)
# ---------------------------------------------------------------------------


def _delete_storage_file_on_commit(name: str) -> None:
    """Best-effort delete of a storage blob after the current transaction commits.

    Deferred to ``on_commit`` so a rolled-back logo write never orphans the *new*
    file by deleting the *old* one prematurely; storage drift (already gone) is
    logged, not raised.
    """
    if not name:
        return

    def _delete() -> None:
        from django.core.files.storage import default_storage

        try:
            default_storage.delete(name)
        except OSError:  # pragma: no cover - storage drift, nothing to clean up
            logger.warning("could not delete old workspace logo file %s", name)

    transaction.on_commit(_delete)


def set_workspace_logo(*, file: Any, mime: str) -> Workspace:
    """Store a new workspace logo, deleting the previously-stored file on commit.

    The validated content type is pinned in ``logo_mime`` so the public serve
    endpoint sets Content-Type from a trusted column rather than re-sniffing. The
    UUID-prefixed ``upload_to`` guarantees the new key differs from the old, so the
    old blob is always safe to delete once the row commits (ADR-0149).
    """
    ws = Workspace.load()
    old_name = ws.logo.name
    ws.logo = file
    ws.logo_mime = mime
    ws.save(update_fields=["logo", "logo_mime", "updated_at"])
    if old_name and old_name != ws.logo.name:
        _delete_storage_file_on_commit(old_name)
    return ws


def clear_workspace_logo() -> Workspace:
    """Remove the workspace logo and delete its stored file on commit (ADR-0149)."""
    ws = Workspace.load()
    old_name = ws.logo.name
    if old_name:
        ws.logo = ""
        ws.logo_mime = ""
        ws.save(update_fields=["logo", "logo_mime", "updated_at"])
        _delete_storage_file_on_commit(old_name)
    return ws


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
            # create_user hashes but does NOT run AUTH_PASSWORD_VALIDATORS, and the
            # serializer accepts any non-empty string — so enforce the configured
            # password policy here before minting the account. Without this an
            # unauthenticated invitee could set a trivially-guessable password.
            try:
                validate_password(password)
            except ValidationError as exc:
                raise InviteError(" ".join(exc.messages)) from exc
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
        if created:
            # Self-service join: the actor is the invitee provisioning their own
            # membership via a token (the endpoint is unauthenticated). Audited
            # inside the provisioning transaction so it rolls back with it.
            record_audit_event(
                event_type=AuditEventType.MEMBER_ADDED,
                actor=user,
                target_type="member",
                target_label=_actor_label(user),
                metadata={
                    "role": WorkspaceRole(membership.role).label,
                    "source": "invite",
                },
            )
        else:
            # A deactivated member must NOT be silently reactivated (or re-elevated)
            # by replaying a pending invite — that would let an admin's deactivation
            # be undone without admin consent. Reactivation is an explicit admin
            # action; refuse the invite instead.
            if membership.status == MemberStatus.DEACTIVATED:
                raise InviteError(
                    "Membership is deactivated; an admin must reactivate it "
                    "before this invite can be used."
                )
            changed = False
            old_role = membership.role
            if invite.role > membership.role:
                membership.role = invite.role
                membership.role_changed_at = now
                changed = True
            if changed:
                membership.save()
                record_audit_event(
                    event_type=AuditEventType.MEMBER_ROLE_CHANGED,
                    actor=user,
                    target_type="member",
                    target_label=_actor_label(user),
                    metadata={
                        "old_role": WorkspaceRole(old_role).label,
                        "new_role": WorkspaceRole(membership.role).label,
                        "source": "invite",
                    },
                )

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
