"""Workspace Agents page API: list, detail, pause, resume, scope, revoke (#4814, #4757).

Every route here is the **control plane** and refuses token-authenticated requests:
it authenticates with the JWT authenticator only (a ``tppm_`` bearer is not a JWT and
answers 401), and :class:`IsSignedInPerson` refuses a token principal on any path that
still reaches the view. The check keys on what authenticated the request, not on
``request.auth`` alone: an identity refusal from the token authenticator leaves
``request.auth`` unset, so "no token on ``request.auth``" is not evidence of a person.

Visibility and management rules live in :mod:`trueppm_api.apps.agents.control`.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.core.cache import cache
from django.db.models import Count
from django.http import Http404
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import permissions, status
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from trueppm_api.apps.agents import control
from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionChainHead,
    AgentActionRefusalDetail,
    AgentActionVerdict,
    AgentActorKind,
)
from trueppm_api.apps.agents.serializers import (
    AgentAuditVerifySerializer,
    AgentControlRequestSerializer,
    AgentDetailSerializer,
    AgentListResponseSerializer,
    AgentScopeEditSerializer,
)
from trueppm_api.apps.agents.services import verify_chain
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin
from trueppm_api.apps.projects.agent_scope import (
    AGENT_AREA_LABELS,
    AGENT_AREAS,
    AGENT_LEVELS,
    GRANTABLE_LEVELS,
    ScopeGrantError,
    grant_of,
    intersect,
    principal_ceilings,
)
from trueppm_api.core.authentication import CredentialCutoffJWTAuthentication

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import ApiToken

#: How long a chain verification is reused while the chain head has not moved.
AUDIT_VERIFY_TTL_SECONDS = 600

#: Recent actions shown in an agent's detail panel.
RECENT_ACTIONS_LIMIT = 20


class IsSignedInPerson(BasePermission):
    """Refuse any API-token caller on the agent control plane (threat model, #4814)."""

    message = "Agents are managed by a signed-in person. API tokens cannot use this endpoint."

    def has_permission(self, request: Request, view: APIView) -> bool:
        from trueppm_api.apps.projects.authentication import ProjectApiTokenAuthentication
        from trueppm_api.apps.projects.models import ApiToken

        if isinstance(
            getattr(request, "successful_authenticator", None), ProjectApiTokenAuthentication
        ):
            return False
        if isinstance(getattr(request, "auth", None), ApiToken):
            return False
        user = getattr(request, "user", None)
        return bool(user is not None and user.is_authenticated)


class _AgentsBase(IdempotencyMixin, APIView):
    authentication_classes = [CredentialCutoffJWTAuthentication]  # noqa: RUF012
    permission_classes = [permissions.IsAuthenticated, IsSignedInPerson]  # noqa: RUF012


def _person(user: Any) -> dict[str, Any] | None:
    if user is None:
        return None
    return {"id": user.pk, "name": control.display_name(user)}


def _readable(
    action_project_id: Any, token: ApiToken, viewer: Any, members: set[Any], admin: bool
) -> bool:
    """Whether the viewer may read an action's text: by project membership."""
    if action_project_id is None:
        return admin or token.owner_id == viewer.pk
    return action_project_id in members


def _rows(tokens: list[ApiToken], viewer: Any, *, detail: bool = False) -> list[dict[str, Any]]:
    """Serialize agents with bulk queries (no per-agent N+1)."""
    admin = control.is_workspace_admin(viewer)
    members = set(control.member_project_ids(viewer))
    ids = [t.pk for t in tokens]
    ceilings = principal_ceilings([t.owner for t in tokens])

    since = timezone.now() - timedelta(days=7)
    refusals: dict[Any, int] = defaultdict(int)
    for token_id, project_id, n in (
        AgentAction.objects.filter(
            actor_token_id__in=ids,
            actor_kind=AgentActorKind.MCP_TOKEN,
            verdict=AgentActionVerdict.REFUSED,
            occurred_at__gte=since,
        )
        .values("actor_token_id", "project_id")
        .annotate(n=Count("id"))
        .values_list("actor_token_id", "project_id", "n")
    ):
        refusals[(token_id, project_id)] += n

    latest = {
        a.actor_token_id: a
        for a in AgentAction.objects.filter(
            actor_token_id__in=ids, actor_kind=AgentActorKind.MCP_TOKEN
        )
        .order_by("actor_token_id", "-occurred_at", "-sequence")
        .distinct("actor_token_id")
        .only("actor_token_id", "occurred_at", "verdict", "summary", "project_id")
    }

    programs: dict[Any, dict[Any, str]] = defaultdict(dict)
    for token_id, program_id, program_name in (
        AgentAction.objects.filter(
            actor_token_id__in=ids,
            actor_kind=AgentActorKind.MCP_TOKEN,
            project_id__in=members,
            project__program__isnull=False,
        )
        .values_list("actor_token_id", "project__program_id", "project__program__name")
        .distinct()
    ):
        programs[token_id][program_id] = program_name

    out: list[dict[str, Any]] = []
    for token in tokens:
        grant = grant_of(token)
        ceiling = ceilings.get(token.owner_id, dict.fromkeys(AGENT_AREAS, "none"))
        sees_all = admin or token.owner_id == viewer.pk
        refused = sum(
            n
            for (tid, pid), n in refusals.items()
            if tid == token.pk and (sees_all or pid in members)
        )
        last = latest.get(token.pk)
        last_action = None
        if last is not None:
            readable = _readable(last.project_id, token, viewer, members, admin)
            last_action = {
                "occurred_at": last.occurred_at,
                "verdict": last.verdict,
                "summary": last.summary if readable else "",
                "redacted": not readable,
            }
        row: dict[str, Any] = {
            "id": token.pk,
            "name": token.name,
            "token_prefix": token.token_prefix,
            "principal": _person(token.owner),
            "created_at": token.created_at,
            "last_used_at": token.last_used_at,
            "expires_at": token.expires_at,
            "revoked_at": token.revoked_at,
            "paused": (
                {"paused_at": token.agent_paused_at, "paused_by": _person(token.agent_paused_by)}
                if token.agent_paused_at is not None
                else None
            ),
            "scope": grant,
            "effective_scope": intersect(grant, ceiling),
            "last_action": last_action,
            "refusals_7d": refused,
            "programs": sorted(
                ({"id": pid, "name": name} for pid, name in programs[token.pk].items()),
                key=lambda p: p["name"],
            ),
            "can_manage": control.can_manage(viewer, token, admin=admin),
        }
        if detail:
            recent = (
                AgentAction.objects.filter(actor_token_id=token.pk)
                .select_related("refusal_detail")
                .order_by("-occurred_at", "-sequence")[:RECENT_ACTIONS_LIMIT]
            )
            row["recent_actions"] = [_recent(a, token, viewer, members, admin) for a in recent]
        out.append(row)
    return out


def _recent(
    a: AgentAction, token: ApiToken, viewer: Any, members: set[Any], admin: bool
) -> dict[str, Any]:
    # A control-plane row (pause, scope edit, ...) concerns the agent itself, which the
    # viewer can already see; an agent call is redacted by project membership.
    readable = a.actor_kind == AgentActorKind.PERSON or _readable(
        a.project_id, token, viewer, members, admin
    )
    try:
        constraint = a.refusal_detail.constraint
    except AgentActionRefusalDetail.DoesNotExist:
        constraint = ""
    return {
        "id": a.pk,
        "occurred_at": a.occurred_at,
        "actor_kind": a.actor_kind,
        "action": a.action if readable else "",
        "verdict": a.verdict,
        "constraint": constraint,
        "summary": a.summary if readable else "",
        "redacted": not readable,
    }


class AgentListView(_AgentsBase):
    """Agents the viewer can see across the workspace (#4757)."""

    @extend_schema(
        summary="List agents the caller can see",
        description=(
            "Agents are owner-scoped API tokens without the full scope. A workspace Admin "
            "sees every agent; anyone else sees their own agents and agents that have acted "
            "in a project they are a member of. Token-authenticated requests are refused."
        ),
        parameters=[
            OpenApiParameter("program", str, description="Only agents that acted in this program.")
        ],
        responses={200: AgentListResponseSerializer},
    )
    def get(self, request: Request) -> Response:
        tokens = list(control.visible_agents(request.user).order_by("name", "created_at"))
        rows = _rows(tokens, request.user)
        program = request.query_params.get("program")
        if program:
            rows = [r for r in rows if any(str(p["id"]) == program for p in r["programs"])]
        payload = {
            # `agents`, not `results`: a bounded, unpaginated list (a person holds at
            # most ten tokens) that is not one of the paginated envelope shapes.
            "agents": rows,
            "areas": [{"key": a, "label": AGENT_AREA_LABELS[a]} for a in AGENT_AREAS],
            "grantable_levels": [lvl for lvl in AGENT_LEVELS if lvl in GRANTABLE_LEVELS],
        }
        return Response(AgentListResponseSerializer(payload).data)


class _AgentObjectView(_AgentsBase):
    def get_agent(self, request: Request, pk: Any, *, manage: bool) -> ApiToken:
        token = control.visible_agents(request.user).filter(pk=pk).first()
        if token is None:
            raise Http404
        if manage and not control.can_manage(request.user, token):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied(
                "Only the person this agent acts for, or a workspace Admin, can change it."
            )
        return token

    def respond(self, request: Request, token: ApiToken) -> Response:
        token.refresh_from_db()
        return Response(AgentDetailSerializer(_rows([token], request.user, detail=True)[0]).data)


class AgentDetailView(_AgentObjectView):
    """One agent, with its recent actions."""

    @extend_schema(summary="Retrieve an agent", responses={200: AgentDetailSerializer})
    def get(self, request: Request, pk: Any) -> Response:
        return self.respond(request, self.get_agent(request, pk, manage=False))


def _reason(request: Request) -> str:
    ser = AgentControlRequestSerializer(data=request.data or {})
    ser.is_valid(raise_exception=True)
    return str(ser.validated_data.get("reason", ""))


class AgentPauseView(_AgentObjectView):
    """Pause an agent: every call it makes is refused until resumed."""

    @extend_schema(
        summary="Pause an agent",
        request=AgentControlRequestSerializer,
        responses={200: AgentDetailSerializer},
    )
    def post(self, request: Request, pk: Any) -> Response:
        token = self.get_agent(request, pk, manage=True)
        control.pause(request, token, request.user, _reason(request))
        return self.respond(request, token)


class AgentResumeView(_AgentObjectView):
    """Resume a paused agent."""

    @extend_schema(
        summary="Resume an agent",
        request=AgentControlRequestSerializer,
        responses={200: AgentDetailSerializer},
    )
    def post(self, request: Request, pk: Any) -> Response:
        token = self.get_agent(request, pk, manage=True)
        control.resume(request, token, request.user, _reason(request))
        return self.respond(request, token)


class AgentScopeView(_AgentObjectView):
    """Edit an agent's capability scope, capped at its principal; ``write`` is refused."""

    @extend_schema(
        summary="Edit an agent's capability scope",
        request=AgentScopeEditSerializer,
        responses={200: AgentDetailSerializer},
    )
    def patch(self, request: Request, pk: Any) -> Response:
        token = self.get_agent(request, pk, manage=True)
        ser = AgentScopeEditSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            control.edit_scope(
                request,
                token,
                request.user,
                ser.validated_data["scope"],
                ser.validated_data.get("reason", ""),
            )
        except ScopeGrantError as exc:
            return Response(
                {"scope": [str(exc)], "code": exc.code}, status=status.HTTP_400_BAD_REQUEST
            )
        return self.respond(request, token)


class AgentRevokeView(_AgentObjectView):
    """Revoke an agent's token. Immediate and permanent."""

    @extend_schema(
        summary="Revoke an agent's token",
        request=AgentControlRequestSerializer,
        responses={200: AgentDetailSerializer},
    )
    def post(self, request: Request, pk: Any) -> Response:
        token = self.get_agent(request, pk, manage=True)
        control.revoke(request, token, request.user, _reason(request))
        token.refresh_from_db()
        # A revoked token drops out of the visible set, so serialize it directly.
        return Response(AgentDetailSerializer(_rows([token], request.user, detail=True)[0]).data)


class AgentAuditVerifyView(_AgentsBase):
    """The "Action log verified" line: ``audit_verify`` over the whole chain.

    Reused while the chain head has not moved and for at most
    :data:`AUDIT_VERIFY_TTL_SECONDS`, so a page load cannot turn into a full-chain walk.
    """

    @extend_schema(
        summary="Verify the agent-action hash chain", responses={200: AgentAuditVerifySerializer}
    )
    def get(self, request: Request) -> Response:
        head = AgentActionChainHead.objects.filter(pk=1).only("last_sequence").first()
        key = f"agents:audit_verify:{head.last_sequence if head else 0}"
        cached = cache.get(key)
        if cached is None:
            result = verify_chain()
            cached = {
                "ok": result.ok,
                "record_count": result.record_count,
                "checked_at": timezone.now(),
                "anchor": result.anchor,
                "break_sequence": result.break_sequence,
            }
            cache.set(key, cached, AUDIT_VERIFY_TTL_SECONDS)
        return Response(AgentAuditVerifySerializer(cached).data)
