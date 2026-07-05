"""Service-layer helpers for the access app.

The service layer wraps multi-row transactions that must remain atomic — most
importantly the Program create flow, which inserts a ``Program`` row and an
OWNER ``ProgramMembership`` row in the same transaction so a Program can never
exist in the database without at least one Owner.

ADR-0070: see §Durable Execution §4 for the atomic-create rationale.
"""

from __future__ import annotations

import uuid
from typing import Any

from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.models import Methodology, Program, Project


@transaction.atomic
def create_program(
    *,
    name: str,
    description: str,
    methodology: str | Methodology,
    created_by: Any,
) -> Program:
    """Create a ``Program`` and the creator's OWNER membership in one transaction.

    Atomicity is the whole point of this helper — if the OWNER ``ProgramMembership``
    INSERT were a second request (or a non-atomic follow-up), a crash between the
    two writes would leave a Program with no Owner, which permission classes treat
    as "nobody can manage this program." The ``@transaction.atomic`` wrapper makes
    that orphan window impossible.

    Args:
        name: Display name (max 255). No uniqueness enforcement — two PMs can
            both have a program called "Phase 2".
        description: Optional rich text; empty string allowed.
        methodology: One of ``Methodology`` values; default ``HYBRID``.
        created_by: The user creating the program — recorded on the Program row
            and inserted as the OWNER ``ProgramMembership``.

    Returns:
        The persisted ``Program``. The OWNER membership exists by the time the
        function returns.
    """
    program = Program.objects.create(
        name=name,
        description=description,
        methodology=methodology,
        created_by=created_by,
    )
    ProgramMembership.objects.create(
        program=program,
        user=created_by,
        role=Role.OWNER,
    )
    return program


@transaction.atomic
def delete_program_cascade(program_id: uuid.UUID | str) -> None:
    """Soft-delete all memberships, detach all projects, soft-delete the program.

    Three things must happen atomically:

    1. **Memberships are soft-deleted.** ``ProgramMembership.program`` is ``PROTECT``,
       so a naive ``program.delete()`` raises ``ProtectedError`` while any member
       rows exist. The UX brief surfaces this as a combined "Remove all members
       and delete" action; the cascade implements that intent server-side.
    2. **Projects are detached.** Django's ``SET_NULL`` only fires on a hard DELETE,
       not on our soft-delete (``is_deleted=True``). Without an explicit detach
       step, ``Project.program_id`` would continue to reference a soft-deleted
       Program — the UI would display "Phase 2 (deleted)" for those projects
       and the program shell would still try to retrieve a 404'd parent. Setting
       ``program=NULL`` here matches the dialog's promise that projects become
       standalone after deletion.
    3. **The program itself is soft-deleted.** This bumps ``server_version`` so
       sync consumers can drop the row from their caches.

    Args:
        program_id: The program to delete.

    Raises:
        Program.DoesNotExist: if the program is missing or already soft-deleted.
    """
    # Local import: Project is in the projects app; importing at module top
    # would create a circular dependency through the projects → access path.
    from trueppm_api.apps.projects.models import Project

    # Lock the program row so concurrent member-add / project-assign requests
    # cannot land between the cascade steps and re-create a reference to the
    # program we're about to mark deleted.
    program = Program.objects.select_for_update().get(pk=program_id, is_deleted=False)

    for membership in ProgramMembership.objects.select_for_update().filter(
        program=program, is_deleted=False
    ):
        membership.soft_delete()

    # Detach projects — they hold a SET_NULL FK, but SET_NULL only fires on
    # hard delete. soft_delete() on the program would otherwise leave dangling
    # references. We must go through ``Project.save()`` (not ``update()``) so
    # ``server_version`` increments and mobile sync clients pick up the change.
    for project in Project.objects.select_for_update().filter(program=program):
        project.program = None
        project.save(update_fields=["program"])

    program.soft_delete()


@transaction.atomic
def transfer_project_ownership(
    *,
    project: Project,
    new_owner: Any,
    actor: Any,
) -> ProjectMembership:
    """Atomically promote a project member to OWNER, demote the actor to ADMIN.

    Why the target must already be a member: requiring an existing membership
    forces an explicit invite step and gives the audit trail a clean
    "joined → promoted" sequence. Auto-creating membership on transfer would
    surprise the target with admin authority on a project they were never
    knowingly added to.

    Args:
        project: The project whose ownership is being transferred.
        new_owner: The user who will become OWNER.
        actor: The current OWNER initiating the transfer; will be downgraded
            to ADMIN. May be the same user as ``new_owner`` — in that case
            both upserts are no-ops and the function returns the actor's row.

    Returns:
        The new OWNER's ``ProjectMembership`` row.

    Raises:
        ValidationError: if ``new_owner`` has no existing active membership
            on the project.
    """
    # Defense in depth — the view layer gates with ``IsProjectOwner``, but the
    # service is reusable (management commands, signals, future endpoints). If
    # the actor is not actually the OWNER, a naive ``.update()`` is a silent
    # no-op that would promote the target without removing anyone — creating
    # an unauthorized OWNER. Assert and fail loudly before any state changes.
    try:
        actor_row = ProjectMembership.objects.select_for_update().get(
            project=project,
            user=actor,
            is_deleted=False,
        )
    except ProjectMembership.DoesNotExist as exc:
        raise ValidationError("Only an existing project Owner can transfer ownership.") from exc
    if actor_row.role != Role.OWNER:
        raise ValidationError("Only an existing project Owner can transfer ownership.")

    try:
        target = ProjectMembership.objects.select_for_update().get(
            project=project,
            user=new_owner,
            is_deleted=False,
        )
    except ProjectMembership.DoesNotExist as exc:
        raise ValidationError(
            "The new owner must already be a member of this project. "
            "Invite them first, then retry the transfer."
        ) from exc

    if new_owner == actor:
        return target

    # Demote the actor first so the OWNER count never exceeds the previous
    # state mid-transaction — defensive against future single-owner constraints.
    # role_changed_at is stamped alongside role on both rows so the per-project
    # access-evidence timestamp (#590) stays accurate on this path too, not just
    # on the partial_update endpoint.
    now = timezone.now()
    actor_row.role = Role.ADMIN
    actor_row.role_changed_at = now
    actor_row.save(update_fields=["role", "role_changed_at"])

    target.role = Role.OWNER
    target.role_changed_at = now
    target.save(update_fields=["role", "role_changed_at"])
    return target


@transaction.atomic
def transfer_program_sponsorship(
    *,
    program: Program,
    new_owner: Any,
    actor: Any,
    new_lead: Any | None = None,
) -> ProgramMembership:
    """Atomically promote a program member to OWNER and optionally rotate the lead.

    Programs carry both an OWNER membership (RBAC) and a ``lead`` FK (the
    "Program Manager" displayed in the header). Both can move together in a
    sponsorship transfer so the header chip and the access matrix stay in sync.

    Args:
        program: The program whose sponsorship is being transferred.
        new_owner: The user who will become OWNER.
        actor: The current OWNER initiating the transfer; will be downgraded
            to ADMIN.
        new_lead: Optional user to set as ``program.lead``. ``None`` leaves
            the existing lead unchanged; pass ``new_owner`` explicitly to keep
            owner+lead in lockstep.

    Returns:
        The new OWNER's ``ProgramMembership`` row.

    Raises:
        ValidationError: if ``new_owner`` has no existing active program
            membership.
    """
    # Defense in depth (see ``transfer_project_ownership`` for full rationale)
    # — the actor must currently hold the OWNER row, otherwise the demote
    # ``.update()`` is a no-op and the target gets promoted without anyone
    # being removed.
    try:
        actor_row = ProgramMembership.objects.select_for_update().get(
            program=program,
            user=actor,
            is_deleted=False,
        )
    except ProgramMembership.DoesNotExist as exc:
        raise ValidationError("Only an existing program Owner can transfer sponsorship.") from exc
    if actor_row.role != Role.OWNER:
        raise ValidationError("Only an existing program Owner can transfer sponsorship.")

    try:
        target = ProgramMembership.objects.select_for_update().get(
            program=program,
            user=new_owner,
            is_deleted=False,
        )
    except ProgramMembership.DoesNotExist as exc:
        raise ValidationError(
            "The new sponsor must already be a member of this program. "
            "Invite them first, then retry the transfer."
        ) from exc

    if new_owner != actor:
        # role_changed_at is stamped alongside role on both rows so the
        # per-program access-evidence timestamp (#878) stays accurate on this
        # path too, not just on the partial_update endpoint.
        now = timezone.now()
        actor_row.role = Role.ADMIN
        actor_row.role_changed_at = now
        actor_row.save(update_fields=["role", "role_changed_at"])

        target.role = Role.OWNER
        target.role_changed_at = now
        target.save(update_fields=["role", "role_changed_at"])

    if new_lead is not None:
        program.lead = new_lead
        program.save(update_fields=["lead"])

    return target


@transaction.atomic
def split_program(
    *,
    program: Program,
    splits: list[dict[str, Any]],
    actor: Any,
) -> list[Program]:
    """Split a program into sub-programs and close the original (ADR-0156, #967).

    For each entry in ``splits`` a new sub-program is created (owned by ``actor``,
    methodology copied from the parent, all inheritable overrides left NULL so the
    new program inherits workspace defaults), and the entry's projects are moved
    under it. After every split is applied the original program is closed — it
    becomes a read-only shell holding any projects that were not redistributed.

    Only the ``Project.program`` FK moves; tasks, dependencies, baselines,
    memberships, and history are untouched, so each project keeps its full
    schedule and audit trail under its new program. Reassignment goes through
    ``Project.save()`` (not ``.update()``) so ``server_version`` increments and
    mobile sync clients pick up the move — same rationale as
    ``delete_program_cascade``.

    The whole operation is one transaction: either every sub-program, every
    reassignment, and the parent close commit together, or nothing does. A bad
    payload raises before any INSERT so the error message is precise.

    Args:
        program: The program being split. Must be open — callers gate on
            ``IsProgramNotClosed``; once closed by this call a replayed request
            is rejected by that gate, which is what makes a network retry safe.
        splits: ``[{"name": str, "project_ids": [uuid]}, ...]``. Each entry
            becomes one sub-program. ``project_ids`` may be empty (an empty
            sub-program shell, symmetric with ``create_program``).
        actor: The current OWNER initiating the split; becomes OWNER of every
            sub-program.

    Returns:
        The created sub-programs, in input order.

    Raises:
        ValidationError: if a referenced project is not a live member of this
            program, or if a project appears in more than one split.
    """
    # Lock the parent row so a concurrent project-assign / delete cannot land
    # between validation and reassignment (mirrors delete_program_cascade).
    program = Program.objects.select_for_update().get(pk=program.pk)

    member_project_ids = {
        str(pk)
        for pk in Project.objects.filter(program=program, is_deleted=False).values_list(
            "pk", flat=True
        )
    }

    # Validate the full payload up front: every id must be a live member of this
    # program, and no id may be claimed by two sub-programs.
    seen: set[str] = set()
    normalized: list[tuple[str, list[str]]] = []
    for entry in splits:
        name = entry["name"]
        ids = [str(pid) for pid in entry["project_ids"]]
        for pid in ids:
            if pid not in member_project_ids:
                raise ValidationError(f"Project {pid} is not a project of this program.")
            if pid in seen:
                raise ValidationError(f"Project {pid} is assigned to more than one sub-program.")
            seen.add(pid)
        normalized.append((name, ids))

    sub_programs: list[Program] = []
    for name, ids in normalized:
        sub = create_program(
            name=name,
            description="",
            methodology=program.methodology,
            created_by=actor,
        )
        # Filter by program=program as well as pk so a project moved out by a
        # racing request (despite the lock) is never silently captured.
        for project in Project.objects.select_for_update().filter(
            program=program, pk__in=ids, is_deleted=False
        ):
            project.program = sub
            project.save(update_fields=["program"])
        sub_programs.append(sub)

    if not program.is_closed:
        program.is_closed = True
        program.closed_at = timezone.now()
        program.closed_by = actor
        program.save(update_fields=["is_closed", "closed_at", "closed_by"])

    return sub_programs


def revoke_all_refresh_tokens(user: Any) -> int:
    """Blacklist every outstanding simplejwt refresh token for ``user``.

    This is the "sign out every device" primitive (ADR-0209). A password reset
    (and, later, any explicit account-security action) must invalidate all of the
    user's existing sessions, not just the one that triggered the change. The
    SPA's session lives entirely in a JWT access token (in-memory, 15-min TTL) plus
    an httpOnly refresh cookie (#897), so revoking every *refresh* token is the
    complete server-side session revocation: a blacklisted refresh token can no
    longer be exchanged for a new access token, and the old access token self-
    expires within its short TTL.

    Django sessions are intentionally left untouched — the SPA never authenticates
    via ``django.contrib.sessions`` (that framework backs only the admin site and
    the DRF browsable API), so there is no app session to clear there.

    Idempotent: ``get_or_create`` means re-running blacklists nothing twice, and a
    row already blacklisted by rotation stays blacklisted. Safe to call inside the
    reset transaction.

    Args:
        user: The account whose refresh tokens should all be revoked.

    Returns:
        The number of tokens newly blacklisted (already-blacklisted tokens are not
        counted). Zero when the account had no outstanding tokens (e.g. it has
        never logged in on this deployment).
    """
    # Local import: the blacklist app's models are only importable once apps are
    # loaded, and keeping the import lazy lets a lean deploy that removes the
    # token_blacklist app degrade gracefully (the ImportError is swallowed → the
    # password is still reset, sessions just fall back to TTL-only expiry).
    try:
        from rest_framework_simplejwt.token_blacklist.models import (
            BlacklistedToken,
            OutstandingToken,
        )
    except ImportError:  # pragma: no cover - only when the app is uninstalled
        return 0

    revoked = 0
    for token in OutstandingToken.objects.filter(user=user):
        _, created = BlacklistedToken.objects.get_or_create(token=token)
        if created:
            revoked += 1
    return revoked


def revoke_all_personal_access_tokens(user: Any) -> int:
    """Soft-revoke every active Personal Access Token owned by ``user`` (ADR-0211).

    Why this exists: a Personal Access Token is a *full-authority* bearer of the
    user's own credentials — a script authenticating with it acts exactly as the
    user. A password change is the user asserting "my credentials may be
    compromised; cut everything off," so it must invalidate not only live sessions
    (``revoke_all_refresh_tokens``) but also every long-lived personal credential
    they minted. Leaving PATs live after a reset would defeat the whole point of
    the reset — an attacker who phished the old password could keep the account via
    a PAT they created. This is the PAT analogue of the refresh-token revocation and
    is called immediately after it in the same atomic block.

    Scope discipline: only ``owner=user`` (personal) tokens are revoked. Project-
    and program-scoped tokens are *org assets* minted by an Admin/PM — they are not
    the user's personal credentials and are deliberately left untouched, so a
    password reset never breaks a team's CI integration.

    Idempotent: already-revoked tokens are filtered out, so re-running is a no-op.
    Uses a bulk ``update()`` (not per-row ``save()``) because revocation is a
    single indexed write with no ``server_version`` sync semantics on the audit
    path — the tokens are not mobile-synced resources whose version consumers track.

    Args:
        user: The account whose personal access tokens should all be revoked.

    Returns:
        The number of tokens newly revoked (already-revoked tokens are excluded).
    """
    # Local import: the projects app imports from access, so importing ApiToken at
    # module top would create a circular dependency through the access → projects
    # path (mirrors delete_program_cascade's lazy Project import).
    from trueppm_api.apps.projects.models import ApiToken

    return ApiToken.objects.filter(
        owner=user,
        is_deleted=False,
        revoked_at__isnull=True,
    ).update(revoked_at=timezone.now())
