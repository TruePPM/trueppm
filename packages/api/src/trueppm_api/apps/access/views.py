"""ViewSets for the access app."""

from __future__ import annotations

import uuid
from typing import Any

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, IntegerField, OuterRef, Q, QuerySet, Subquery
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.serializers import BaseSerializer
from rest_framework.throttling import BaseThrottle, ScopedRateThrottle, UserRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import (
    ExternalStakeholder,
    ProgramMembership,
    ProgramUserDefinedMentionGroup,
    ProjectMembership,
    Role,
    UserDefinedMentionGroup,
)
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
    IsProjectMember,
    IsProjectNotArchived,
    IsProjectOwner,
    McpReadableViewMixin,
    McpScope,
    _membership_role,
    _program_membership_role,
    assert_project_not_archived,
)
from trueppm_api.apps.access.serializers import (
    ExternalStakeholderSerializer,
    MeSerializer,
    ProgramMembershipReadSerializer,
    ProgramMembershipUpdateSerializer,
    ProgramMembershipWriteSerializer,
    ProgramUserDefinedMentionGroupReadSerializer,
    ProgramUserDefinedMentionGroupWriteSerializer,
    ProjectMembershipReadSerializer,
    ProjectMembershipUpdateSerializer,
    ProjectMembershipWriteSerializer,
    UserDefinedMentionGroupReadSerializer,
    UserDefinedMentionGroupWriteSerializer,
    UserSearchResultSerializer,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace.permissions import IsWorkspaceMember
from trueppm_api.core.openapi import (
    ownership_refusal_403,
    state_refusal_400,
    suppress_list_pagination,
)
from trueppm_api.core.request_body import object_body

_PK = str | uuid.UUID

_PERMISSION_DENIED_DETAIL = "You do not have permission to perform this action."
_ROLE_NOT_BELOW_OWN_ERROR = "You cannot assign a role equal to or higher than your own."
_PROGRAM_NOT_FOUND_DETAIL = "Program not found."


def _revive_revoked_membership(
    membership: ProjectMembership | ProgramMembership, *, new_role: int
) -> None:
    """Un-tombstone a revoked membership row in place, at ``new_role`` (#3410).

    ``(project, user)`` / ``(program, user)`` uniqueness is declared
    **unconditionally**, so a revoked (soft-deleted) row keeps occupying its slot.
    Re-adding that member therefore has to reuse the row — an INSERT hits the
    constraint. The group-cascade reconciler resurrects rather than inserts for the
    same reason (``workspace.services._reconcile_pair``), and both paths depend on
    at most one row existing per (scope, user): that reconciler keys its "does a
    row already exist" lookup on it, so a second live row would make its decision
    ambiguous.

    Every field the write serializer accepts is stamped as it would be on a fresh
    add; the server-owned identity survives — the primary key (which is what an
    offline client holds) and ``joined_at``, because this is the same membership
    resuming rather than a new one.

    ``role_changed_at`` is stamped only when the role actually differs from the one
    held at revocation, so re-adding someone at their old role does not fabricate a
    role-change event. This is the rule ``partial_update`` uses and it is
    deliberately **not** what ``_reconcile_pair`` does — that path stamps
    unconditionally on resurrect. The difference is intentional: the reconciler
    cannot see whether a human meant the role to change, whereas this endpoint was
    handed one explicitly.

    ``reinstated_at`` is stamped unconditionally with ``timezone.now()`` on every
    revive (#3436) — unlike ``role_changed_at`` it does not compare against the
    prior state, because a revive is itself the fact being recorded, regardless of
    whether the role also changed. This is what closes the #3410 known limitation:
    ``deleted_version`` is still cleared and ``joined_at`` still reports the
    original join date, but ``reinstated_at`` now gives a caller — human or
    machine — a durable server-side discriminator between "joined once, never
    left" and "was away and came back", without needing ``HistoricalRecords`` or
    an ``AuditEvent`` that this app does not write.

    The save draws a fresh ``sync_seq`` (ADR-0686), which is what makes the row
    re-materialize on the next delta pull: the sync endpoint splits rows into
    'updated' vs 'deleted' purely on the current ``is_deleted`` value, so a client
    holding the tombstone sees an **update** to a row it already knows, never a
    duplicate (ADR-0202).
    """
    membership.is_deleted = False
    membership.deleted_version = None
    membership.reinstated_at = timezone.now()
    if new_role != membership.role:
        membership.role = new_role
        membership.role_changed_at = timezone.now()
    # The row was just SELECTed, so the UPDATE path is known — skip the exists()
    # probe, exactly as ``soft_delete`` and ``restore`` do (#1527).
    membership.save(known_exists=True)


# ---------------------------------------------------------------------------
# Lock-acquisition order (#3438)
# ---------------------------------------------------------------------------
# `create` and `partial_update` on both membership viewsets, `_check_last_owner_
# guard` (both viewsets), and `workspace.services.reconcile_group_access` all
# take `SELECT ... FOR UPDATE` locks on ProjectMembership / ProgramMembership
# rows inside a transaction. Whenever a request needs more than one such row —
# `create` locks the actor's own row plus the target's existing row (if any);
# `partial_update` locks the actor's own row plus the row it patches — they are
# locked together, in a single statement, ordered by ascending `pk`.
#
# The rule is deliberately "ascending pk", not "actor row first" or "target row
# first": a role-based order deadlocks the moment two requests have their actor
# and target reversed on the same pair of rows (Owner A adds/patches Owner B
# while Owner B concurrently adds/patches Owner A) — each transaction would
# hold the row it locked first and block waiting on the other, forever.
# Ordering by an intrinsic, row-level key instead of a role means every
# transaction agrees on which row to lock first regardless of which side of
# the request it is on, so the two requests serialize instead of deadlocking.
# `_check_last_owner_guard` and `reconcile_group_access` each already take a
# single multi-row lock; `order_by("pk")` there keeps them inside the same
# convention rather than leaving their row order database-defined.
# ---------------------------------------------------------------------------


class MembershipGrantThrottle(UserRateThrottle):
    """Per-user rate limit on granting project/program membership (#3645).

    Naming another account on a write is the same directory-shaped exposure
    ``user_search`` (#815) and ``ResourceCatalogThrottle`` (#891) guard against on
    reads — a workspace Admin reaches every active account via the reachable-
    target queryset (#3641). Neither membership viewset set a ``throttle_scope``,
    so ``create`` inherited the default ``user`` scope (1000/min). Shared by both
    ``ProjectMembershipViewSet`` and ``ProgramMembershipViewSet`` — one 60/min
    budget for the account, not one per resource type. The rate is set inline
    (mirroring ``ResourceCatalogThrottle``) so no settings entry is required.
    """

    scope = "membership_grant"
    rate = "60/min"


class ProjectMembershipViewSet(IdempotencyMixin, viewsets.GenericViewSet[ProjectMembership]):
    """Nested CRUD for project memberships.

    URL: /api/v1/projects/{project_pk}/members/
         /api/v1/projects/{project_pk}/members/{pk}/

    Permission matrix:
      list/retrieve  — any project member (Viewer+)
      create         — Owner only (role == Role.OWNER)
      partial_update — Owner only; caller may not assign role >= their own
      destroy        — Owner only for others; any member may self-remove
                       (last-Owner guard prevents stranding a project)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]
    archived_write_exempt = {
        "destroy": (
            "self-removal must survive archiving; removing another member is still "
            "refused, in the destroy body where `is_self` is known"
        )
    }

    def get_permissions(self) -> list[BasePermission]:
        """Express the Owner-only create/partial_update gate at the permission layer.

        The view bodies already enforce ``Role.OWNER`` (and the assign-below-self
        and last-Owner invariants), but a Viewer reached the body before being
        rejected — the role gate was invisible to DRF-level audits and OpenAPI
        security generation (#1351). Adding IsProjectOwner here is defense-in-depth,
        not a behavior change: the in-body checks remain authoritative. ``destroy``
        is deliberately excluded — any member may self-remove (the last-Owner guard
        prevents stranding a project), so it must not require Owner.
        """
        perms: list[BasePermission] = [IsAuthenticated(), IsProjectMember()]
        if self.action in ("create", "partial_update"):
            perms.append(IsProjectOwner())
        if self.action != "destroy":
            # `destroy` is the one action that must survive archiving, and only for the
            # self-removal case (#3414). `IsProjectNotArchived` fires in `has_permission`
            # on this route — before the object is fetched and long before `is_self` is
            # known — so leaving it on the chain would close the "any member may
            # self-remove" path documented above. The archived refusal for removing
            # SOMEONE ELSE is re-asserted in the `destroy` body, where `is_self` exists.
            perms.append(IsProjectNotArchived())
        return perms

    def get_throttles(self) -> list[BaseThrottle]:
        """Scope the directory-shaped-exposure throttle to ``create`` only (#3645).

        ``partial_update``/``destroy`` name an account already on the roster —
        the harvest concern ``MembershipGrantThrottle`` exists for is naming an
        arbitrary reachable account on a grant, not re-touching a known row.
        """
        if self.action == "create":
            return [MembershipGrantThrottle()]
        return super().get_throttles()

    def get_queryset(self) -> QuerySet[ProjectMembership]:
        project_pk = self.kwargs["project_pk"]
        # Annotate each row with the member's count of OTHER active projects (#598)
        # via a correlated subquery — one extra query for the whole page, no N+1.
        # Coalesce to 0 for members who are on no other active project.
        other_active = (
            ProjectMembership.objects.filter(
                user_id=OuterRef("user_id"),
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=project_pk)
            .values("user_id")
            .annotate(c=Count("project_id", distinct=True))
            .values("c")
        )
        return (
            ProjectMembership.objects.select_related("project", "user")
            .filter(project_id=project_pk, is_deleted=False)
            .annotate(
                other_active_count=Coalesce(Subquery(other_active, output_field=IntegerField()), 0)
            )
        )

    def _build_other_project_names_map(
        self, request: Request, memberships: list[ProjectMembership], current_project_pk: _PK
    ) -> dict[object, list[str]]:
        """Map user_id -> names of their other active projects the REQUESTER owns (#598).

        Visibility gate: a project name is revealed only for projects the requesting user
        is OWNER of — never leak the name of a project the requester cannot already see.
        Bounded query cost: one query for the requester's owned projects + one for the
        members' memberships within that owned set (no per-row queries).
        """
        names_map: dict[object, list[str]] = {m.user_id: [] for m in memberships}
        if not memberships:
            return names_map
        owned_ids = set(
            ProjectMembership.objects.filter(
                # IsAuthenticated guarantees a real User, but mypy still sees
                # request.user as User | AnonymousUser for the lookup.
                user=request.user,  # type: ignore[misc]
                role=Role.OWNER,
                is_deleted=False,
                project__is_deleted=False,
                project__is_archived=False,
            )
            .exclude(project_id=current_project_pk)
            .values_list("project_id", flat=True)
        )
        if not owned_ids:
            return names_map
        rows = (
            ProjectMembership.objects.filter(
                user_id__in=list(names_map.keys()),
                is_deleted=False,
                project_id__in=owned_ids,
                # Self-contained active-project gate (defense in depth): owned_ids is
                # already built from active projects, but pin it here too so a future
                # change to owned_ids can't silently surface an archived/deleted name.
                project__is_deleted=False,
                project__is_archived=False,
            )
            .select_related("project")
            .order_by("project__name")
        )
        for row in rows:
            names_map[row.user_id].append(row.project.name)
        return names_map

    def get_serializer_class(self) -> type[BaseSerializer[ProjectMembership]]:
        if self.action in ("partial_update", "update"):
            # An update body carries role only — ``user`` is immutable (#3641).
            return ProjectMembershipUpdateSerializer
        if self.action == "create":
            return ProjectMembershipWriteSerializer
        return ProjectMembershipReadSerializer

    def _get_project_or_404(self) -> Project:
        try:
            return Project.objects.get(pk=self.kwargs["project_pk"], is_deleted=False)
        except Project.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Project not found.") from err

    def _require_actor_role(self, request: Request, project_id: _PK, minimum: int) -> int:
        """Return the actor's role, raising 403 if below minimum."""
        role = _membership_role(request, project_id)
        if role is None or role < minimum:
            raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
        return role

    def _check_last_owner_guard(self, project_id: _PK, exclude_pk: _PK | None = None) -> None:
        """Raise **400** if removing/demoting would strand the project without an Owner."""
        qs = ProjectMembership.objects.filter(
            project_id=project_id, role=Role.OWNER, is_deleted=False
        )
        if exclude_pk:
            qs = qs.exclude(pk=exclude_pk)
        # select_for_update prevents concurrent removal of both owners simultaneously.
        # order_by("pk"): see the module-level "Lock-acquisition order" comment.
        if not qs.order_by("pk").select_for_update().exists():
            raise drf_serializers.ValidationError(
                {"detail": "Cannot remove or demote the last Owner of a project."}
            )

    # -----------------------------------------------------------------------
    # Actions
    # -----------------------------------------------------------------------

    @extend_schema(responses={200: ProjectMembershipReadSerializer(many=True)})
    # This handler returns a bare array, but ProjectMembershipViewSet inherits the
    # default pagination class, so the auto-schema would otherwise declare a
    # Paginated...List envelope the real body violates (#3649). Opt out so the
    # schema matches the response.
    @suppress_list_pagination
    def list(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        # has_permission only checks authentication; enforce membership explicitly
        # because DRF only calls has_object_permission on retrieve/update/destroy.
        if _membership_role(request, project.pk) is None:
            raise PermissionDenied("You must be a member of this project.")
        qs = self.get_queryset()
        # ?self=true: return only the requesting user's own membership row.
        # Used by the frontend useCurrentUserRole() hook for tab-level RBAC.
        if request.query_params.get("self") == "true":
            user_pk = request.user.pk
            assert user_pk is not None  # IsAuthenticated ensures a real user
            qs = qs.filter(user_id=user_pk)
        memberships = list(qs)
        names_map = self._build_other_project_names_map(request, memberships, project.pk)
        serializer = ProjectMembershipReadSerializer(
            memberships,
            many=True,
            context={"request": request, "other_project_names_map": names_map},
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()
        names_map = self._build_other_project_names_map(request, [instance], project.pk)
        return Response(
            ProjectMembershipReadSerializer(
                instance,
                context={"request": request, "other_project_names_map": names_map},
            ).data
        )

    @extend_schema(
        responses={
            201: ProjectMembershipReadSerializer,
            400: state_refusal_400(
                "Refused on the request: the role is at or above the caller's own, or "
                "``user`` names an account the caller cannot reach (#3641). The "
                "unreachable-target message is identical to the one a nonexistent id "
                "gets, so the field is not an existence oracle."
            ),
        }
    )
    def create(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.OWNER)

        # The write serializer bounds ``user`` to the accounts this caller may name
        # (reachable_membership_targets, #3641) — it needs the request to do that,
        # and resolves nobody without it.
        serializer = ProjectMembershipWriteSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)

        # Role is optional on add (ADR-0363, #157): fall back to the project's
        # configured default when the caller does not name one. The strictly-below-
        # your-own guard below then applies to the resolved role exactly as it does
        # to an explicit one — a default is never a way around it.
        new_role = serializer.validated_data.get("role")
        if new_role is None:
            new_role = project.default_member_role

        user = serializer.validated_data["user"]
        # The (project, user) unique constraint is unconditional, so the row a
        # revoked member left behind still owns the slot. Deciding on the *live*
        # rows only let a re-add sail past the guard straight into the constraint,
        # which surfaced as a 500 (#3410); the decision has to be made on the row
        # whatever its is_deleted state, and the row is locked so a concurrent add
        # cannot slip between the read and the write. Under ATOMIC_REQUESTS that
        # lock is held to the request's commit, not to the end of this block — so
        # the 409 on a live duplicate now also holds it briefly. Accepted: the
        # contention is confined to one (project, user) pair.
        # ``of=("self",)`` keeps the lock on the membership row — a bare
        # select_for_update alongside select_related would lock the joined auth_user
        # row too, on every add. select_related is what stops the read serializer's
        # ``user_detail`` from lazy-loading the user the caller already named.
        #
        # The actor's own membership row is locked in the SAME statement (#3438):
        # reading the actor's role ceiling via the request-cached, unlocked
        # `_membership_role()` — as this endpoint did before — left a TOCTOU window
        # where a concurrent demotion of the actor between the initial permission
        # check and this write could let them grant at their pre-demotion ceiling.
        # See the module-level "Lock-acquisition order" comment for why the two
        # rows are locked together, ordered by pk, rather than "actor, then
        # target".
        actor_pk = request.user.pk
        assert actor_pk is not None  # IsAuthenticated ensures a real user
        with transaction.atomic():
            locked = {
                m.user_id: m
                for m in (
                    ProjectMembership.objects.select_for_update(of=("self",))
                    .select_related("user")
                    .filter(project=project, user_id__in={actor_pk, user.pk})
                    .order_by("pk")
                )
            }
            actor_membership = locked.get(actor_pk)
            if actor_membership is None or actor_membership.is_deleted:
                raise PermissionDenied("You are not a member of this project.")
            actor_role = actor_membership.role
            if actor_role < Role.OWNER:
                raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
            # Caller may only assign roles strictly below their own — read from the
            # row just locked, not the unlocked cache read this replaced.
            if new_role >= actor_role:
                raise drf_serializers.ValidationError({"role": _ROLE_NOT_BELOW_OWN_ERROR})

            existing = locked.get(user.pk)
            if existing is not None and not existing.is_deleted:
                return Response(
                    {"detail": "User is already a member of this project."},
                    status=status.HTTP_409_CONFLICT,
                )
            if existing is not None:
                # A direct re-add supersedes any group provenance the revoked row
                # carried. Group reconciliation only revokes rows it owns
                # (source_group IS NOT NULL) and never touches a direct grant, so
                # leaving the FK set would let a later reconcile revoke a
                # membership an Owner granted by hand.
                existing.source_group = None
                _revive_revoked_membership(existing, new_role=new_role)
                instance = existing
            else:
                # Pass the resolved role explicitly — it may have come from the
                # project default rather than the request payload, so it is not in
                # validated_data.
                try:
                    # Savepoint so a lost INSERT race (no row existed to lock, two
                    # requests both got here) leaves the outer transaction usable
                    # and answers 409 instead of the 500 this guard exists to avoid.
                    with transaction.atomic():
                        instance = serializer.save(project=project, role=new_role)
                except IntegrityError:
                    # Narrow the 409 to the uniqueness race this branch exists for.
                    # If a (project, user) row is present now, another request won
                    # the INSERT. Anything else — an FK violation from a
                    # concurrently hard-deleted user, or a constraint added to this
                    # table later — must not be answered "already a member", so
                    # re-raise it rather than masking it as a benign conflict.
                    if not ProjectMembership.objects.filter(project=project, user=user).exists():
                        raise
                    return Response(
                        {"detail": "User is already a member of this project."},
                        status=status.HTTP_409_CONFLICT,
                    )

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(user.pk)

        # Audit + notify only on the success path reached above (#3645). Written
        # synchronously — record_audit_event's own contract — so it rolls back
        # with the request if anything after this point fails; DRF's
        # exception_handler calls set_rollback() on every APIException, so a
        # refusal can never reach here to begin with.
        from trueppm_api.apps.notifications.models import NotificationEventType
        from trueppm_api.apps.notifications.services import create_event_notifications
        from trueppm_api.apps.workspace.models import AuditEventType
        from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

        record_audit_event(
            event_type=AuditEventType.MEMBER_ADDED,
            actor=request.user,
            target_type="member",
            target_id=instance.pk,
            target_label=_actor_label(user),
            metadata={"project_id": project_id, "role": Role(new_role).label, "source": "grant"},
        )
        actor_label = _actor_label(request.user)
        role_label = Role(new_role).label
        subject = f"You were added to {project.name}"
        body = f"{actor_label} added you to {project.name} as {role_label}."
        transaction.on_commit(
            lambda: create_event_notifications(
                event_type=NotificationEventType.MEMBERSHIP_GRANTED,
                recipient_ids=[user.pk],
                subject=subject,
                body=body,
                project_id=project_id,
            )
        )

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "member_added",
                {"membership_id": membership_id, "user_id": user_id, "role": new_role},
            )
        )

        return Response(
            ProjectMembershipReadSerializer(instance).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(
        responses={
            200: ProjectMembershipReadSerializer,
            400: state_refusal_400(
                "Refused on the request: the role is at or above the caller's own, "
                "demoting this member would strand the project without an Owner, or the "
                "body carried ``user`` — a membership's account is fixed at creation "
                "(#3641)."
            ),
        }
    )
    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()
        old_role = instance.role  # snapshot before serializer.save() mutates it in place

        serializer = ProjectMembershipUpdateSerializer(
            instance, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)

        new_role = serializer.validated_data.get("role")

        # M4 fix: lock the actor's own membership row with SELECT FOR UPDATE inside
        # an atomic block to close the TOCTOU window where a concurrent demotion
        # could allow the actor to assign a role >= their effective role at save
        # time. Locked together with `instance` (the row being patched), in one
        # statement ordered by ascending pk — see the module-level
        # "Lock-acquisition order" comment for why "actor row, then instance" can
        # deadlock and pk order cannot.
        #
        # When a role change is requested, every current Owner's row is folded
        # into this SAME statement too (security-review, #3438): a role change
        # might trip the last-Owner guard below, which takes its own
        # select_for_update() on the project's other Owner rows. Taking that as
        # a SECOND, separate statement after this one reopens exactly the
        # deadlock this comment warns about — this transaction would hold
        # {actor, instance} and then reach for the Owner set, while a
        # concurrent transaction with three or more Owners racing could be
        # holding one of those Owner rows and reaching for {actor, instance} in
        # the opposite order. Locking the superset up front, in one
        # ascending-pk pass, means `_check_last_owner_guard`'s own query below
        # only ever re-locks rows this statement already holds — a no-op, not a
        # wait. We don't yet know under lock whether `instance` is actually an
        # Owner, so this widens whenever a role change is requested at all,
        # not only when the pre-lock `instance.role` looks like one; the
        # over-inclusion when it turns out not to be a demotion is harmless.
        with transaction.atomic():
            lock_filter = Q(pk=instance.pk) | Q(
                project=project, user=request.user, is_deleted=False
            )
            if new_role is not None:
                lock_filter |= Q(project=project, role=Role.OWNER, is_deleted=False)
            locked_rows = list(
                ProjectMembership.objects.select_for_update().filter(lock_filter).order_by("pk")
            )
            actor_membership = next(
                (m for m in locked_rows if m.user_id == request.user.pk and not m.is_deleted),
                None,
            )
            if actor_membership is None:
                raise PermissionDenied("You are not a member of this project.") from None

            actor_role = actor_membership.role
            if actor_role < Role.OWNER:
                raise PermissionDenied(_PERMISSION_DENIED_DETAIL)

            if new_role is not None:
                # Cannot assign role >= actor's own.
                if new_role >= actor_role:
                    raise drf_serializers.ValidationError({"role": _ROLE_NOT_BELOW_OWN_ERROR})
                # Last-Owner guard: if demoting an Owner, ensure another Owner exists.
                # Its own select_for_update() only re-locks rows already held above.
                if instance.role == Role.OWNER and new_role < Role.OWNER:
                    self._check_last_owner_guard(project.pk, exclude_pk=instance.pk)
                # Stamp role_changed_at only on an actual role change (#590) so a
                # no-op PATCH that re-sends the same role does not falsely advance
                # the per-project access-evidence timestamp.
                if new_role != instance.role:
                    serializer.save(role_changed_at=timezone.now())
                else:
                    serializer.save()
            else:
                serializer.save()

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(instance.user_id)
        role_val = instance.role

        # Audit + notify only when the role actually changed (#3645) — a no-op
        # PATCH (unchanged role) or a role_title-only PATCH must not fabricate a
        # role-change event. Written synchronously, same rationale as `create`.
        if new_role is not None and new_role != old_role:
            from trueppm_api.apps.notifications.models import NotificationEventType
            from trueppm_api.apps.notifications.services import create_event_notifications
            from trueppm_api.apps.workspace.models import AuditEventType
            from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

            record_audit_event(
                event_type=AuditEventType.MEMBER_ROLE_CHANGED,
                actor=request.user,
                target_type="member",
                target_id=instance.pk,
                target_label=_actor_label(instance.user),
                metadata={
                    "project_id": project_id,
                    "old_role": Role(old_role).label,
                    "new_role": Role(new_role).label,
                },
            )
            actor_label = _actor_label(request.user)
            old_role_label = Role(old_role).label
            new_role_label = Role(new_role).label
            target_user_id = instance.user_id
            subject = f"Your role changed on {project.name}"
            body = (
                f"{actor_label} changed your role on {project.name} from "
                f"{old_role_label} to {new_role_label}."
            )
            transaction.on_commit(
                lambda: create_event_notifications(
                    event_type=NotificationEventType.MEMBERSHIP_ROLE_CHANGED,
                    recipient_ids=[target_user_id],
                    subject=subject,
                    body=body,
                    project_id=project_id,
                )
            )

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "member_role_changed",
                {"membership_id": membership_id, "user_id": user_id, "role": role_val},
            )
        )

        return Response(ProjectMembershipReadSerializer(instance).data)

    @extend_schema(
        responses={
            204: None,
            400: state_refusal_400(
                "Refused on the roster's own state: removing this member would leave "
                "the project with no Owner. Verified against the last-Owner guard in "
                "``destroy`` (#3319)."
            ),
            403: ownership_refusal_403(
                "The caller is not a member, is below Owner and removing someone else, "
                "or holds a role at or below the target's (#3365)."
            ),
        }
    )
    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        instance = self.get_object()

        is_self = instance.user == request.user

        if is_self:
            # Any member may remove themselves; require at least Viewer membership.
            actor_role = _membership_role(request, project.pk)
            if actor_role is None:
                raise PermissionDenied("You are not a member of this project.")
        else:
            # Removing another member is an ordinary roster write, so it obeys the
            # archived read-only contract (#3414). Checked here rather than by keeping
            # `IsProjectNotArchived` on the chain because `has_permission` runs before
            # `is_self` is known, and refusing there would also close self-removal —
            # which must survive archiving the way share-link and token revocation do.
            assert_project_not_archived(project.pk)
            # Removing another member requires Owner.
            actor_role = self._require_actor_role(request, project.pk, Role.OWNER)
            # Owner may only remove members with a lower role than themselves.
            if instance.role >= actor_role:
                # 403, not 400: a peer's role is a fact about the *caller's*
                # authority over the target, not about the request (#3365).
                raise PermissionDenied(
                    "You can only remove members with a role lower than your own."
                )

        # Last-Owner guard — atomic with select_for_update, pk-ordered like every
        # other multi-row lock on this table (see the module-level "Lock-
        # acquisition order" comment). `destroy` never locks the actor's own row —
        # unlike `create`/`partial_update` it does not assign a role, so there is
        # no ceiling to protect from a concurrent demotion; the actor's removal
        # *authority* (`actor_role` above) is read unlocked, same as before #3438,
        # which is scoped to the role-ceiling TOCTOU on grants, not this one.
        if instance.role == Role.OWNER:
            with transaction.atomic():
                self._check_last_owner_guard(project.pk, exclude_pk=instance.pk)
                instance.soft_delete()
        else:
            instance.soft_delete()

        # Audit the revocation (#3645) — written synchronously after the
        # soft_delete() above succeeds, same rationale as create/partial_update.
        # No notification: the issue scopes notify to "added or role-changed",
        # not removed.
        from trueppm_api.apps.workspace.models import AuditEventType
        from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

        record_audit_event(
            event_type=AuditEventType.MEMBER_REMOVED,
            actor=request.user,
            target_type="member",
            target_id=instance.pk,
            target_label=_actor_label(instance.user),
            metadata={
                "project_id": str(project.pk),
                "role": Role(instance.role).label,
                "self_removal": is_self,
            },
        )

        project_id = str(project.pk)
        membership_id = str(instance.pk)
        user_id = str(instance.user_id)
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id, "member_removed", {"membership_id": membership_id, "user_id": user_id}
            )
        )

        return Response(status=status.HTTP_204_NO_CONTENT)


class UserDefinedMentionGroupViewSet(
    IdempotencyMixin, viewsets.GenericViewSet[UserDefinedMentionGroup]
):
    """Nested CRUD for user-defined @mention groups (ADR-0212, #515).

    URL: ``/api/v1/projects/{project_pk}/mention-groups/``
         ``/api/v1/projects/{project_pk}/mention-groups/{pk}/``
         ``…/{pk}/add-member/``  ``…/{pk}/remove-member/``
         ``…/{pk}/mute/``  ``…/{pk}/unmute/``

    Permission matrix (ADR-0212 §3):
      list / retrieve            — any project member (Viewer+)
      create / update / destroy  — Project Admin+  (group lifecycle is a PM act)
      add-member / remove-member — Project Scheduler+  (roster curation)
      mute / unmute              — any member (their own subscription only)
    """

    permission_classes = [IsAuthenticated, IsProjectMember, IsProjectNotArchived]

    def get_serializer_class(self) -> type[BaseSerializer[UserDefinedMentionGroup]]:
        if self.action in ("create", "partial_update", "update"):
            return UserDefinedMentionGroupWriteSerializer
        return UserDefinedMentionGroupReadSerializer

    def get_queryset(self) -> QuerySet[UserDefinedMentionGroup]:
        project_pk = self.kwargs["project_pk"]
        return (
            UserDefinedMentionGroup.objects.filter(project_id=project_pk, is_deleted=False)
            .prefetch_related("members", "muted_by")
            .order_by("name")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["project_id"] = self.kwargs["project_pk"]
        return ctx

    def _get_project_or_404(self) -> Project:
        try:
            return Project.objects.get(pk=self.kwargs["project_pk"], is_deleted=False)
        except Project.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound("Project not found.") from err

    def _require_actor_role(self, request: Request, project_id: _PK, minimum: int) -> int:
        role = _membership_role(request, project_id)
        if role is None or role < minimum:
            raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
        return role

    def _broadcast(self, project_id: str, group_id: str, change: str) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Deferred to on_commit (ADR-0083) so a rolled-back write never notifies
        # open Members tabs; the group is also a VersionedModel, so clients that
        # miss the transient event reconcile via the sync delta.
        transaction.on_commit(
            lambda: broadcast_board_event(
                project_id,
                "mention_group_changed",
                {"group_id": group_id, "change": change},
            )
        )

    def _read_response(self, instance: UserDefinedMentionGroup, *, code: int = 200) -> Response:
        # Re-fetch through the prefetching queryset so member/mute counts on the
        # response reflect the write without an N+1.
        fresh = self.get_queryset().get(pk=instance.pk)
        return Response(
            UserDefinedMentionGroupReadSerializer(
                fresh, context=self.get_serializer_context()
            ).data,
            status=code,
        )

    # -- lifecycle (Admin+) --------------------------------------------------

    @extend_schema(responses={200: UserDefinedMentionGroupReadSerializer(many=True)})
    # This handler returns a bare array, but UserDefinedMentionGroupViewSet inherits
    # the default pagination class, so the auto-schema would otherwise declare a
    # Paginated...List envelope the real body violates (#3649). Opt out so the
    # schema matches the response.
    @suppress_list_pagination
    def list(self, request: Request, **kwargs: object) -> Response:
        self._get_project_or_404()
        serializer = UserDefinedMentionGroupReadSerializer(
            self.get_queryset(), many=True, context=self.get_serializer_context()
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_project_or_404()
        return self._read_response(self.get_object())

    def create(self, request: Request, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.ADMIN)
        serializer = UserDefinedMentionGroupWriteSerializer(
            data=request.data, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save(project=project, created_by=request.user)
        self._broadcast(str(project.pk), str(instance.pk), "created")
        return self._read_response(instance, code=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.ADMIN)
        instance = self.get_object()
        serializer = UserDefinedMentionGroupWriteSerializer(
            instance, data=request.data, partial=True, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save()
        self._broadcast(str(project.pk), str(instance.pk), "updated")
        return self._read_response(instance)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        project = self._get_project_or_404()
        # Defense in depth. `IsProjectNotArchived` used to bypass the check for ANY
        # action named "destroy" — the exemption was matched by action name, for
        # ProjectViewSet's own delete — and this nested viewset names its delete
        # "destroy" too, so the invariant had to be re-asserted here or it was lost.
        # #3414 scoped the bypass to ProjectViewSet, so the permission class now covers
        # this route on its own; the check below is retained per ADR-0184's additive
        # doctrine rather than deleted as redundant.
        if project.is_archived:
            raise PermissionDenied(
                "This project is archived and cannot be modified. Unarchive it first."
            )
        self._require_actor_role(request, project.pk, Role.ADMIN)
        instance = self.get_object()
        instance.soft_delete()
        self._broadcast(str(project.pk), str(instance.pk), "deleted")
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -- membership (Scheduler+) --------------------------------------------

    def _member_user_or_400(self, project_id: _PK) -> Any:
        """Resolve request.data['user'] to a User that is an active project member."""
        user_id = object_body(self.request).get("user")
        if not user_id:
            raise drf_serializers.ValidationError({"user": "This field is required."})
        User = get_user_model()
        try:
            user = User.objects.get(pk=user_id)
        except (User.DoesNotExist, ValueError, TypeError) as err:
            raise drf_serializers.ValidationError({"user": "User not found."}) from err
        # A mention group may only contain current project members — a group
        # member who is not on the project would be filtered out at resolution
        # anyway, so reject the add up front.
        if not ProjectMembership.objects.filter(
            project_id=project_id, user=user, is_deleted=False
        ).exists():
            raise drf_serializers.ValidationError({"user": "User is not a member of this project."})
        return user

    def _mutate_membership(self, request: Request, *, add: bool) -> Response:
        project = self._get_project_or_404()
        self._require_actor_role(request, project.pk, Role.SCHEDULER)
        instance = self.get_object()
        user = self._member_user_or_400(project.pk)
        if add:
            instance.members.add(user)
        else:
            instance.members.remove(user)
        # Bump server_version so the membership change flows through the sync
        # delta (the M2M write alone does not touch the parent row).
        instance.save(update_fields=["server_version"])
        self._broadcast(
            str(project.pk), str(instance.pk), "member_added" if add else "member_removed"
        )
        return self._read_response(instance)

    # Explicit request= / responses= on all four roster actions (#2840). Without
    # them drf-spectacular falls back to get_serializer_class(), which returns the
    # *read* serializer for a custom action — a read serializer has no writable
    # fields, so the published operation carried NO requestBody at all even though
    # ``user`` is required. A generated SDK method took no arguments, leaving the
    # caller no path that could ever send the body the endpoint 400s without.
    @extend_schema(
        summary="Add a project member to this @mention group",
        request=inline_serializer(
            name="MentionGroupAddMemberRequest",
            fields={"user": drf_serializers.UUIDField()},
        ),
        responses={200: UserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="add-member")
    def add_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=True)

    @extend_schema(
        summary="Remove a member from this @mention group",
        request=inline_serializer(
            name="MentionGroupRemoveMemberRequest",
            fields={"user": drf_serializers.UUIDField()},
        ),
        responses={200: UserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="remove-member")
    def remove_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=False)

    # -- mute / unmute (any member, self only) ------------------------------

    def _mutate_mute(self, request: Request, *, mute: bool) -> Response:
        project = self._get_project_or_404()
        # Any project member may mute/unmute a group for THEMSELVES only.
        self._require_actor_role(request, project.pk, Role.VIEWER)
        instance = self.get_object()
        if mute:
            instance.muted_by.add(request.user)  # type: ignore[arg-type]
        else:
            instance.muted_by.remove(request.user)  # type: ignore[arg-type]
        return self._read_response(instance)

    # ``request=None`` is asserted, not inferred: mute/unmute act on the caller's
    # own subscription and read nothing from the body. The pre-#2840 schema
    # happened to publish no requestBody here (the read-serializer fallback has no
    # writable fields), but that was an accident of the fallback, not a statement —
    # adding one writable field to the read serializer would have silently
    # published a body these endpoints ignore.
    @extend_schema(
        summary="Mute this @mention group for yourself",
        request=None,
        responses={200: UserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="mute")
    def mute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=True)

    @extend_schema(
        summary="Unmute this @mention group for yourself",
        request=None,
        responses={200: UserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="unmute")
    def unmute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=False)


class ProgramUserDefinedMentionGroupViewSet(
    IdempotencyMixin, viewsets.GenericViewSet[ProgramUserDefinedMentionGroup]
):
    """Nested CRUD for program-scoped user-defined @mention groups (ADR-0248, #516).

    URL: ``/api/v1/programs/{program_pk}/mention-groups/``
         ``/api/v1/programs/{program_pk}/mention-groups/{pk}/``
         ``…/{pk}/add-member/``  ``…/{pk}/remove-member/``
         ``…/{pk}/mute/``  ``…/{pk}/unmute/``

    Permission matrix (ADR-0248 §3) — tiers in program vocabulary, ordinals in
    parentheses because "Program Admin" is ``Role.OWNER`` (400) here, not
    ``Role.ADMIN`` (#3503):
      list / retrieve            — any program member (Viewer+, 1)
      create / update / destroy  — Program Admin (400)  (group lifecycle is an
                                   owner act)
      add-member / remove-member — Program Manager+ (300)  (roster curation)
      mute / unmute              — any member (their own subscription only)
    """

    permission_classes = [IsAuthenticated, IsProgramMember, IsProgramNotClosed]

    def get_permissions(self) -> list[BasePermission]:
        """Surface the Owner-only lifecycle gate at the permission layer (#1351).

        The action bodies already enforce ``Role.OWNER`` via ``_require_actor_role``,
        but that in-body check is invisible to DRF-level audits and OpenAPI security
        generation. Adding ``IsProgramOwner`` for the lifecycle actions is
        defense-in-depth over the authoritative in-body checks — mirroring the
        sibling membership viewsets. Membership (add/remove) and mute are Admin+ /
        any-member, so they keep the base classes only.
        """
        perms: list[BasePermission] = [
            IsAuthenticated(),
            IsProgramMember(),
            IsProgramNotClosed(),
        ]
        if self.action in ("create", "partial_update", "destroy"):
            perms.append(IsProgramOwner())
        return perms

    def get_serializer_class(
        self,
    ) -> type[BaseSerializer[ProgramUserDefinedMentionGroup]]:
        if self.action in ("create", "partial_update", "update"):
            return ProgramUserDefinedMentionGroupWriteSerializer
        return ProgramUserDefinedMentionGroupReadSerializer

    def get_queryset(self) -> QuerySet[ProgramUserDefinedMentionGroup]:
        program_pk = self.kwargs["program_pk"]
        return (
            ProgramUserDefinedMentionGroup.objects.filter(program_id=program_pk, is_deleted=False)
            .prefetch_related("members", "muted_by")
            .order_by("name")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        ctx["program_id"] = self.kwargs["program_pk"]
        return ctx

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound(_PROGRAM_NOT_FOUND_DETAIL) from err

    def _require_actor_role(self, request: Request, program_id: _PK, minimum: int) -> int:
        role = _program_membership_role(request, program_id)
        if role is None or role < minimum:
            raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
        return role

    def _broadcast(self, program_id: str, group_id: str, change: str) -> None:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # A program isn't board-scoped, so fan the refresh out to every live
        # project in the program — any open Members tab in the program reconciles.
        # Deferred to on_commit (ADR-0083) so a rolled-back write never notifies;
        # the group is also a VersionedModel, so a missed transient event is
        # reconciled via the sync delta.
        project_ids = list(
            Project.objects.filter(program_id=program_id, is_deleted=False).values_list(
                "id", flat=True
            )
        )

        def _emit() -> None:
            for project_id in project_ids:
                broadcast_board_event(
                    str(project_id),
                    "mention_group_changed",
                    {
                        "group_id": group_id,
                        "change": change,
                        "scope": "program",
                        # The web consumer invalidates the program-scoped query key
                        # (['program-mention-groups', program_id]) off this field —
                        # the event rides project channels but targets the program cache.
                        "program_id": program_id,
                    },
                )

        transaction.on_commit(_emit)

    def _read_response(
        self, instance: ProgramUserDefinedMentionGroup, *, code: int = 200
    ) -> Response:
        # Re-fetch through the prefetching queryset so member/mute counts on the
        # response reflect the write without an N+1.
        fresh = self.get_queryset().get(pk=instance.pk)
        return Response(
            ProgramUserDefinedMentionGroupReadSerializer(
                fresh, context=self.get_serializer_context()
            ).data,
            status=code,
        )

    # -- lifecycle (Owner) ---------------------------------------------------

    @extend_schema(responses={200: ProgramUserDefinedMentionGroupReadSerializer(many=True)})
    # This handler returns a bare array, but ProgramUserDefinedMentionGroupViewSet
    # inherits the default pagination class, so the auto-schema would otherwise
    # declare a Paginated...List envelope the real body violates (#3649). Opt out
    # so the schema matches the response.
    @suppress_list_pagination
    def list(self, request: Request, **kwargs: object) -> Response:
        self._get_program_or_404()
        serializer = ProgramUserDefinedMentionGroupReadSerializer(
            self.get_queryset(), many=True, context=self.get_serializer_context()
        )
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_program_or_404()
        return self._read_response(self.get_object())

    def create(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)
        serializer = ProgramUserDefinedMentionGroupWriteSerializer(
            data=request.data, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save(program=program, created_by=request.user)
        self._broadcast(str(program.pk), str(instance.pk), "created")
        return self._read_response(instance, code=status.HTTP_201_CREATED)

    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)
        instance = self.get_object()
        serializer = ProgramUserDefinedMentionGroupWriteSerializer(
            instance, data=request.data, partial=True, context=self.get_serializer_context()
        )
        serializer.is_valid(raise_exception=True)
        instance = serializer.save()
        self._broadcast(str(program.pk), str(instance.pk), "updated")
        return self._read_response(instance)

    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        # IsProgramNotClosed bypasses the closed check for any action named
        # "destroy" (its bypass set exists so a closed Program can be deleted
        # directly). This nested viewset also names its delete "destroy", so the
        # closed read-only invariant must be re-asserted explicitly here — every
        # other write action (create/update/add-member/…) is already blocked by the
        # permission because it is not in that bypass set. Mirrors the project
        # sibling's archived re-assertion.
        if program.is_closed:
            raise PermissionDenied(
                "This program is closed and cannot be modified. Reopen it first."
            )
        self._require_actor_role(request, program.pk, Role.OWNER)
        instance = self.get_object()
        instance.soft_delete()
        self._broadcast(str(program.pk), str(instance.pk), "deleted")
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -- membership (Admin+) -------------------------------------------------

    def _member_user_or_400(self, program_id: _PK) -> Any:
        """Resolve request.data['user'] to a User who is a member of the program.

        A program group may only contain users who hold a live ``ProjectMembership``
        on *some* project in the program (the ADR-0248 §2 union) — a user with no
        membership anywhere in the program would be filtered out at resolution
        anyway, so reject the add up front.
        """
        user_id = object_body(self.request).get("user")
        if not user_id:
            raise drf_serializers.ValidationError({"user": "This field is required."})
        User = get_user_model()
        try:
            user = User.objects.get(pk=user_id)
        except (User.DoesNotExist, ValueError, TypeError) as err:
            raise drf_serializers.ValidationError({"user": "User not found."}) from err
        if not ProjectMembership.objects.filter(
            project__program_id=program_id,
            project__is_deleted=False,
            user=user,
            is_deleted=False,
        ).exists():
            raise drf_serializers.ValidationError(
                {"user": "User is not a member of any project in this program."}
            )
        return user

    def _mutate_membership(self, request: Request, *, add: bool) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.ADMIN)
        instance = self.get_object()
        user = self._member_user_or_400(program.pk)
        if add:
            instance.members.add(user)
        else:
            instance.members.remove(user)
        # Bump server_version so the membership change flows through the sync
        # delta (the M2M write alone does not touch the parent row).
        instance.save(update_fields=["server_version"])
        self._broadcast(
            str(program.pk), str(instance.pk), "member_added" if add else "member_removed"
        )
        return self._read_response(instance)

    # Same #2840 fallback trap as the project-scoped mirror above: the read
    # serializer has no writable fields, so the published operation declared no
    # requestBody while ``user`` is required.
    @extend_schema(
        summary="Add a program member to this @mention group",
        request=inline_serializer(
            name="ProgramMentionGroupAddMemberRequest",
            fields={"user": drf_serializers.UUIDField()},
        ),
        responses={200: ProgramUserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="add-member")
    def add_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=True)

    @extend_schema(
        summary="Remove a member from this @mention group",
        request=inline_serializer(
            name="ProgramMentionGroupRemoveMemberRequest",
            fields={"user": drf_serializers.UUIDField()},
        ),
        responses={200: ProgramUserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="remove-member")
    def remove_member(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_membership(request, add=False)

    # -- mute / unmute (any member, self only) ------------------------------

    def _mutate_mute(self, request: Request, *, mute: bool) -> Response:
        program = self._get_program_or_404()
        # Any program member may mute/unmute a group for THEMSELVES only.
        self._require_actor_role(request, program.pk, Role.VIEWER)
        instance = self.get_object()
        if mute:
            instance.muted_by.add(request.user)  # type: ignore[arg-type]
        else:
            instance.muted_by.remove(request.user)  # type: ignore[arg-type]
        return self._read_response(instance)

    @extend_schema(
        summary="Mute this @mention group for yourself",
        request=None,
        responses={200: ProgramUserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="mute")
    def mute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=True)

    @extend_schema(
        summary="Unmute this @mention group for yourself",
        request=None,
        responses={200: ProgramUserDefinedMentionGroupReadSerializer},
    )
    @action(detail=True, methods=["post"], url_path="unmute")
    def unmute(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        return self._mutate_mute(request, mute=False)


class ExternalStakeholderViewSet(IdempotencyMixin, viewsets.ModelViewSet[ExternalStakeholder]):
    """Program-scoped CRUD for the external stakeholder registry (#1658, ADR-0264).

    URL: ``/api/v1/programs/{program_pk}/external-stakeholders/``
         ``/api/v1/programs/{program_pk}/external-stakeholders/{pk}/``

    A registry of non-account people (client sponsors, vendor contacts, external
    reviewers) who are included in the ``@program-stakeholders`` mention fan-out
    alongside the program's Viewer-role members. Delivery of email to these
    addresses is **deferred to #1675** — this surface manages the registry only.

    Permission matrix: program **Admin+** (Owner/Admin) for every action, list
    included — managing who is externally pinged is an administrative act, so a
    Scheduler/Member/Viewer/non-member is denied. ``IsProgramAdmin`` is the
    existing program-management gate (Role.ADMIN threshold); reused verbatim rather
    than reinvented. ``IsProgramNotClosed`` blocks writes to a closed program while
    still allowing reads (GET passes it).
    """

    permission_classes = [IsAuthenticated, IsProgramAdmin, IsProgramNotClosed]
    serializer_class = ExternalStakeholderSerializer
    lookup_field = "pk"
    # A program's stakeholder list is small and read whole by the settings UI; a
    # plain array (no pagination envelope) matches the sibling program-group hook.
    pagination_class = None

    def get_queryset(self) -> QuerySet[ExternalStakeholder]:
        # Scope to the URL's program AND live rows only — never trust a body-supplied
        # program id (IDOR-safe). The queryset is the sole authority on which program
        # a stakeholder belongs to, for both list and detail (update/destroy) routes.
        program_pk = self.kwargs["program_pk"]
        return (
            ExternalStakeholder.objects.filter(program_id=program_pk, is_deleted=False)
            .select_related("created_by")
            .order_by("name", "email")
        )

    def get_serializer_context(self) -> dict[str, Any]:
        ctx = dict(super().get_serializer_context())
        # The serializer's per-program email-uniqueness check reads this.
        ctx["program_id"] = self.kwargs["program_pk"]
        return ctx

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound(_PROGRAM_NOT_FOUND_DETAIL) from err

    def perform_create(self, serializer: BaseSerializer[ExternalStakeholder]) -> None:
        program = self._get_program_or_404()
        # Stamp program from the URL and created_by from the caller — both are
        # server-controlled, never client-supplied.
        serializer.save(program=program, created_by=self.request.user)

    def perform_destroy(self, instance: ExternalStakeholder) -> None:
        # IsProgramNotClosed's bypass set includes "destroy" (so a closed Program can
        # itself be deleted). This nested viewset also names its delete "destroy", so
        # re-assert the closed read-only invariant explicitly — mirroring the sibling
        # ProgramUserDefinedMentionGroupViewSet.destroy. create/update are already
        # blocked (they are not in the bypass set).
        program = self._get_program_or_404()
        if program.is_closed:
            raise PermissionDenied(
                "This program is closed and cannot be modified. Reopen it first."
            )
        # Soft-delete: flip the flag so the email frees up for re-add and the
        # partial-unique constraint stops binding this row.
        instance.is_deleted = True
        instance.save(update_fields=["is_deleted", "updated_at"])


class UserSearchView(APIView):
    """GET /api/v1/users/search/?q=<term> — workspace user typeahead for member invite.

    Returns up to 10 active users matching username or email (case-insensitive).
    The email is matched but never returned (#815, ADR-0061 amended): the previous
    serializer echoed every matched user's email, so a single authenticated account
    could paginate the typeahead to harvest the whole workspace's email list. The
    substantive fix is dropping ``email`` from the payload + a per-user throttle.
    Defense in depth:

    - ``IsWorkspaceMember`` — a deactivated membership (or, once explicit
      memberships/multi-workspace land, a non-member) is denied. In a single-
      workspace OSS deploy every active account is an implicit member, so this is
      the semantically-correct gate rather than an added restriction today; and
    - a per-user 60/min throttle (``user_search`` scope) bounds bulk scraping.

    Returns an empty list when q is fewer than 2 characters.
    """

    permission_classes = [IsWorkspaceMember]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "user_search"

    @extend_schema(responses={200: UserSearchResultSerializer(many=True)})
    def get(self, request: Request) -> Response:
        q = (request.query_params.get("q") or "").strip()
        if len(q) < 2:
            return Response([])
        User = get_user_model()
        qs = User.objects.filter(
            Q(username__icontains=q) | Q(email__icontains=q),
            is_active=True,
        ).order_by("username")[:10]
        return Response(UserSearchResultSerializer(qs, many=True).data)


class MeView(McpReadableViewMixin, APIView):
    """GET /api/v1/auth/me/ — current user identity.

    Returns display name and initials derived from auth.User fields.
    No project context — role is project-scoped and available separately.
    """

    # ADR-0678 (#2482): identity echo — no project-scoped rows to withhold.
    mcp_scope = McpScope.NO_PROJECT_DATA

    permission_classes = [IsAuthenticated]

    @extend_schema(responses={200: MeSerializer})
    def get(self, request: Request) -> Response:
        return Response(MeSerializer(request.user).data)


class ProgramMembershipViewSet(IdempotencyMixin, viewsets.GenericViewSet[ProgramMembership]):
    """Nested CRUD for program memberships (ADR-0070).

    URL: ``/api/v1/programs/{program_pk}/members/``
         ``/api/v1/programs/{program_pk}/members/{pk}/``

    Permission matrix mirrors :class:`ProjectMembershipViewSet`:
      list/retrieve  — any program member (Viewer+)
      create         — Owner only; cannot assign role >= caller's own
      partial_update — Owner only; cannot assign role >= caller's own; last-Owner guard
      destroy        — Owner only for others; self-remove allowed; last-Owner guard

    Why membership is Owner-only while program *configuration* is Admin+
    (:class:`IsProgramAdmin` on rename/methodology/calendar/health/visibility/
    sharing/rollup/risk): the asymmetry is intentional (#2017 product decision).
    Deciding *who* belongs to a program and at *what* role is a sovereignty
    (ownership) decision — it grants or revokes another person's access — which
    is categorically distinct from reconfiguring a program whose membership is
    already scoped. Admins may tune an already-scoped program; only Owners may
    change its roster. Do not "fix" this by lowering the gate to Admin+.
    """

    permission_classes = [IsAuthenticated, IsProgramMember, IsProgramNotClosed]

    def get_permissions(self) -> list[BasePermission]:
        """Express the create/update role floors at the permission layer (#1351).

        ``create`` is Owner-only, so IsProgramOwner is added as defense-in-depth
        over the in-body ``_require_actor_role(OWNER)`` check.

        ``partial_update`` carries **Admin**, not Owner: a ``role_title``-only PATCH
        (benign descriptive metadata, #565) is permitted at Admin+, and the body
        escalates to the Owner gate only when ``role`` changes. Gating the whole
        action on Owner here would regress that Admin metadata branch. Admin is the
        floor the body already enforces, and stating it here is what keeps a
        below-Admin caller's refusal a **403 about their authority** rather than a
        400 from whichever field validator happened to run first — the convention
        ``destroy`` states at the bottom of this class (#3365). It matters since
        #3641: ``user`` is now refused by the serializer, which runs before the
        in-body role check.

        ``destroy`` allows self-remove, so it is excluded.
        """
        perms: list[BasePermission] = [
            IsAuthenticated(),
            IsProgramMember(),
            IsProgramNotClosed(),
        ]
        if self.action == "create":
            perms.append(IsProgramOwner())
        elif self.action in ("partial_update", "update"):
            perms.append(IsProgramAdmin())
        return perms

    def get_throttles(self) -> list[BaseThrottle]:
        """Scope the directory-shaped-exposure throttle to ``create`` only (#3645).

        See the project twin (``ProjectMembershipViewSet.get_throttles``) — one
        shared ``membership_grant`` budget across both membership surfaces.
        """
        if self.action == "create":
            return [MembershipGrantThrottle()]
        return super().get_throttles()

    def get_queryset(self) -> QuerySet[ProgramMembership]:
        program_pk = self.kwargs["program_pk"]
        return ProgramMembership.objects.select_related("program", "user").filter(
            program_id=program_pk, is_deleted=False
        )

    def get_serializer_class(self) -> type[BaseSerializer[ProgramMembership]]:
        if self.action in ("partial_update", "update"):
            # An update body carries role/role_title only — ``user`` is immutable (#3641).
            return ProgramMembershipUpdateSerializer
        if self.action == "create":
            return ProgramMembershipWriteSerializer
        return ProgramMembershipReadSerializer

    def _get_program_or_404(self) -> Program:
        try:
            return Program.objects.get(pk=self.kwargs["program_pk"], is_deleted=False)
        except Program.DoesNotExist as err:
            from rest_framework.exceptions import NotFound

            raise NotFound(_PROGRAM_NOT_FOUND_DETAIL) from err

    def _require_actor_role(self, request: Request, program_id: _PK, minimum: int) -> int:
        """Return the actor's program role, raising 403 if below minimum."""
        role = _program_membership_role(request, program_id)
        if role is None or role < minimum:
            raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
        return role

    def _check_last_owner_guard(self, program_id: _PK, exclude_pk: _PK | None = None) -> None:
        """Raise **400** if removing/demoting would leave the program with zero Owners."""
        qs = ProgramMembership.objects.filter(
            program_id=program_id, role=Role.OWNER, is_deleted=False
        )
        if exclude_pk:
            qs = qs.exclude(pk=exclude_pk)
        # order_by("pk"): see the module-level "Lock-acquisition order" comment.
        if not qs.order_by("pk").select_for_update().exists():
            raise drf_serializers.ValidationError(
                {"detail": "Cannot remove or demote the last Owner of a program."}
            )

    # -----------------------------------------------------------------------
    # Actions
    # -----------------------------------------------------------------------

    @extend_schema(responses={200: ProgramMembershipReadSerializer(many=True)})
    # This handler returns a bare array, but ProgramMembershipViewSet inherits the
    # default pagination class, so the auto-schema would otherwise declare a
    # Paginated...List envelope the real body violates (#3649). Opt out so the
    # schema matches the response.
    @suppress_list_pagination
    def list(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        # has_permission only checks authentication + membership-at-program-pk
        # for nested routes; the queryset filters by program_id, so an authenticated
        # non-member would see an empty list. Enforce explicitly to return 403.
        if _program_membership_role(request, program.pk) is None:
            raise PermissionDenied("You must be a member of this program.")
        qs = self.get_queryset()
        # ?self=true: only the caller's own membership row — used by the frontend
        # useCurrentProgramRole() hook for tab-level RBAC.
        if request.query_params.get("self") == "true":
            user_pk = request.user.pk
            assert user_pk is not None
            qs = qs.filter(user_id=user_pk)
        serializer = ProgramMembershipReadSerializer(qs, many=True)
        return Response(serializer.data)

    def retrieve(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        self._get_program_or_404()
        instance = self.get_object()
        return Response(ProgramMembershipReadSerializer(instance).data)

    @extend_schema(
        responses={
            201: ProgramMembershipReadSerializer,
            400: state_refusal_400(
                "Refused on the request: the role is at or above the caller's own, or "
                "``user`` names an account the caller cannot reach (#3641) — see the "
                "project twin."
            ),
        }
    )
    def create(self, request: Request, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        self._require_actor_role(request, program.pk, Role.OWNER)

        # See the project twin: ``user`` is caller-scoped and needs the request.
        serializer = ProgramMembershipWriteSerializer(
            data=request.data, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)

        new_role = serializer.validated_data["role"]
        user = serializer.validated_data["user"]
        # Mirrors ProjectMembershipViewSet.create exactly — ProgramMembership
        # carries the same unconditional (program, user) constraint and therefore
        # carried the same 500 on re-adding a revoked member (#3410). See
        # ``_revive_revoked_membership`` for why the row is reused rather than
        # re-inserted, and what an offline client sees.
        #
        # The actor's own membership row is locked in the SAME statement (#3438),
        # together with the target's existing row (if any), ordered by pk — see
        # the module-level "Lock-acquisition order" comment. Reading the actor's
        # role ceiling via the request-cached, unlocked `_program_membership_role()`
        # — as this endpoint did before — left a TOCTOU window where a concurrent
        # demotion of the actor between the initial permission check and this
        # write could let them grant at their pre-demotion ceiling.
        actor_pk = request.user.pk
        assert actor_pk is not None  # IsAuthenticated ensures a real user
        with transaction.atomic():
            locked = {
                m.user_id: m
                for m in (
                    ProgramMembership.objects.select_for_update(of=("self",))
                    .select_related("user")
                    .filter(program=program, user_id__in={actor_pk, user.pk})
                    .order_by("pk")
                )
            }
            actor_membership = locked.get(actor_pk)
            if actor_membership is None or actor_membership.is_deleted:
                raise PermissionDenied("You are not a member of this program.")
            actor_role = actor_membership.role
            if actor_role < Role.OWNER:
                raise PermissionDenied(_PERMISSION_DENIED_DETAIL)
            # Caller may only assign roles strictly below their own — read from the
            # row just locked, not the unlocked cache read this replaced.
            if new_role >= actor_role:
                raise drf_serializers.ValidationError({"role": _ROLE_NOT_BELOW_OWN_ERROR})

            existing = locked.get(user.pk)
            if existing is not None and not existing.is_deleted:
                return Response(
                    {"detail": "User is already a member of this program."},
                    status=status.HTTP_409_CONFLICT,
                )
            if existing is not None:
                # Stamped as a fresh add would leave it: an omitted role_title
                # means "unset", never "inherit whatever the revoked row carried".
                existing.role_title = serializer.validated_data.get("role_title", "")
                _revive_revoked_membership(existing, new_role=new_role)
                instance = existing
            else:
                try:
                    # Savepoint — see the project-side twin for why the INSERT
                    # answers 409 rather than 500 when two adds race.
                    with transaction.atomic():
                        instance = serializer.save(program=program)
                except IntegrityError:
                    # Narrowed to the uniqueness race — see the project-side twin.
                    if not ProgramMembership.objects.filter(program=program, user=user).exists():
                        raise
                    return Response(
                        {"detail": "User is already a member of this program."},
                        status=status.HTTP_409_CONFLICT,
                    )

        # Audit + notify only on the success path reached above (#3645) — see the
        # project twin's create() for the full rationale. A program has no owning
        # project, so the notification's ``project_id`` is deliberately None: the
        # inbox row is still recipient-scoped and readable without one (only the
        # ADR-0663 scheduled digests were expected to omit it before this).
        from trueppm_api.apps.notifications.models import NotificationEventType
        from trueppm_api.apps.notifications.services import create_event_notifications
        from trueppm_api.apps.workspace.models import AuditEventType
        from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

        record_audit_event(
            event_type=AuditEventType.MEMBER_ADDED,
            actor=request.user,
            target_type="member",
            target_id=instance.pk,
            target_label=_actor_label(user),
            metadata={
                "program_id": str(program.pk),
                "role": Role(new_role).label,
                "source": "grant",
            },
        )
        actor_label = _actor_label(request.user)
        role_label = Role(new_role).label
        program_name = program.name
        subject = f"You were added to {program_name}"
        body = f"{actor_label} added you to {program_name} as {role_label}."
        recipient_id = user.pk
        transaction.on_commit(
            lambda: create_event_notifications(
                event_type=NotificationEventType.MEMBERSHIP_GRANTED,
                recipient_ids=[recipient_id],
                subject=subject,
                body=body,
                project_id=None,
            )
        )

        return Response(
            ProgramMembershipReadSerializer(instance).data, status=status.HTTP_201_CREATED
        )

    @extend_schema(
        responses={
            200: ProgramMembershipReadSerializer,
            400: state_refusal_400(
                "Refused on the request: the role is at or above the caller's own, "
                "demoting this member would strand the program without an Owner, or the "
                "body carried ``user`` — a membership's account is fixed at creation "
                "(#3641)."
            ),
        }
    )
    def partial_update(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        instance = self.get_object()
        old_role = instance.role  # snapshot before serializer.save() mutates it in place

        serializer = ProgramMembershipUpdateSerializer(
            instance, data=request.data, partial=True, context={"request": request}
        )
        serializer.is_valid(raise_exception=True)
        new_role = serializer.validated_data.get("role")

        # Changing the access role stays Owner-only (the ADR-0070 matrix). The
        # freeform role_title (#565) is benign descriptive metadata — not enforced
        # anywhere — so a role_title-only PATCH is allowed at Admin+. A request that
        # also touches role is privileged and falls back to the Owner gate.
        #
        # Reassigning the *member identity* is no longer a privileged change here
        # because it is no longer a change at all: the serializer refuses ``user`` on
        # update at any role (#3641). Swapping the account behind a live row was a
        # second route to the same address harvest, and it rewrote who held access
        # while keeping the row's ``joined_at`` access evidence.
        required_role = Role.OWNER if new_role is not None else Role.ADMIN

        # Lock the actor's membership row inside an atomic block to close the
        # TOCTOU window where a concurrent demotion could let the actor assign
        # a role >= their effective role at save time. Locked together with
        # `instance` (the row being patched), in one statement ordered by
        # ascending pk — see the module-level "Lock-acquisition order" comment
        # for why "actor row, then instance" can deadlock and pk order cannot.
        #
        # See the project twin for why every current Owner's row is folded into
        # this SAME statement whenever a role change is requested at all
        # (security-review, #3438): `_check_last_owner_guard`'s own lock below
        # would otherwise be a second, separately-ordered statement, reopening
        # the deadlock this comment exists to close.
        with transaction.atomic():
            lock_filter = Q(pk=instance.pk) | Q(
                program=program, user=request.user, is_deleted=False
            )
            if new_role is not None:
                lock_filter |= Q(program=program, role=Role.OWNER, is_deleted=False)
            locked_rows = list(
                ProgramMembership.objects.select_for_update().filter(lock_filter).order_by("pk")
            )
            actor_membership = next(
                (m for m in locked_rows if m.user_id == request.user.pk and not m.is_deleted),
                None,
            )
            if actor_membership is None:
                raise PermissionDenied("You are not a member of this program.") from None

            actor_role = actor_membership.role
            if actor_role < required_role:
                raise PermissionDenied(_PERMISSION_DENIED_DETAIL)

            if new_role is not None:
                if new_role >= actor_role:
                    raise drf_serializers.ValidationError({"role": _ROLE_NOT_BELOW_OWN_ERROR})
                if instance.role == Role.OWNER and new_role < Role.OWNER:
                    self._check_last_owner_guard(program.pk, exclude_pk=instance.pk)
                # Stamp role_changed_at only on an actual role change (#878) so a
                # no-op PATCH that re-sends the same role does not falsely advance
                # the per-program access-evidence timestamp.
                if new_role != instance.role:
                    serializer.save(role_changed_at=timezone.now())
                else:
                    serializer.save()
            else:
                serializer.save()

        # Audit + notify only when the role actually changed (#3645) — a
        # role_title-only PATCH (Admin+ tier) must not fabricate a role-change
        # event. See the project twin's partial_update() for the full rationale.
        if new_role is not None and new_role != old_role:
            from trueppm_api.apps.notifications.models import NotificationEventType
            from trueppm_api.apps.notifications.services import create_event_notifications
            from trueppm_api.apps.workspace.models import AuditEventType
            from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

            record_audit_event(
                event_type=AuditEventType.MEMBER_ROLE_CHANGED,
                actor=request.user,
                target_type="member",
                target_id=instance.pk,
                target_label=_actor_label(instance.user),
                metadata={
                    "program_id": str(program.pk),
                    "old_role": Role(old_role).label,
                    "new_role": Role(new_role).label,
                },
            )
            actor_label = _actor_label(request.user)
            old_role_label = Role(old_role).label
            new_role_label = Role(new_role).label
            program_name = program.name
            target_user_id = instance.user_id
            subject = f"Your role changed on {program_name}"
            body = (
                f"{actor_label} changed your role on {program_name} from "
                f"{old_role_label} to {new_role_label}."
            )
            transaction.on_commit(
                lambda: create_event_notifications(
                    event_type=NotificationEventType.MEMBERSHIP_ROLE_CHANGED,
                    recipient_ids=[target_user_id],
                    subject=subject,
                    body=body,
                    project_id=None,
                )
            )

        return Response(ProgramMembershipReadSerializer(instance).data)

    @extend_schema(
        responses={
            204: None,
            400: state_refusal_400(
                "Refused on the roster's own state: removing this member would leave "
                "the program with no Owner. Verified against the last-Owner guard in "
                "``destroy`` (#3319)."
            ),
            403: ownership_refusal_403(
                "The caller is not a member, is below Owner and removing someone else, "
                "or holds a role at or below the target's (#3365)."
            ),
        }
    )
    def destroy(self, request: Request, pk: object = None, **kwargs: object) -> Response:
        program = self._get_program_or_404()
        instance = self.get_object()

        is_self = instance.user == request.user

        if is_self:
            actor_role = _program_membership_role(request, program.pk)
            if actor_role is None:
                raise PermissionDenied("You are not a member of this program.")
        else:
            actor_role = self._require_actor_role(request, program.pk, Role.OWNER)
            if instance.role >= actor_role:
                # 403, not 400: a peer's role is a fact about the *caller's*
                # authority over the target, not about the request (#3365).
                raise PermissionDenied(
                    "You can only remove members with a role lower than your own."
                )

        # See the project twin: `destroy` never locks the actor's own row (no role
        # is assigned here), so `_check_last_owner_guard`'s pk-ordered lock is the
        # only one this path takes.
        if instance.role == Role.OWNER:
            with transaction.atomic():
                self._check_last_owner_guard(program.pk, exclude_pk=instance.pk)
                instance.soft_delete()
        else:
            instance.soft_delete()

        # Audit the revocation (#3645) — see the project twin's destroy() for the
        # full rationale. No notification: scoped to "added or role-changed".
        from trueppm_api.apps.workspace.models import AuditEventType
        from trueppm_api.apps.workspace.services import _actor_label, record_audit_event

        record_audit_event(
            event_type=AuditEventType.MEMBER_REMOVED,
            actor=request.user,
            target_type="member",
            target_id=instance.pk,
            target_label=_actor_label(instance.user),
            metadata={
                "program_id": str(program.pk),
                "role": Role(instance.role).label,
                "self_removal": is_self,
            },
        )

        return Response(status=status.HTTP_204_NO_CONTENT)
