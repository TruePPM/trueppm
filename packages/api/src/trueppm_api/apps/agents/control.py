"""Agent control plane: visibility, pause, resume, scope edit and revoke (#4814, #4757).

An *agent* here is a controlled agent: an owner-scoped API token carrying ``mcp:read``
and not the full scope
(:func:`~trueppm_api.apps.projects.agent_scope.is_controlled_agent`). This module is the only
writer of its control state (``ApiToken.agent_paused_at`` / ``agent_paused_by`` /
``agent_scope`` / ``revoked_at`` through this surface), and each write appends a
``PERSON`` row to the same hash chain the agent's own calls are recorded in, inside
the same transaction as the state change — so the log proves who paused, resumed,
widened or revoked what, and the flag and its record commit or roll back together.

A control row's ``principal`` is the **agent's** principal (its owner), not the person
who acted, so the row lands in the owner's own ``/agent-actions/`` log beside the
agent's calls. The acting person is named, with their user id, in the hashed
``summary``: an Admin pausing Alice's agent writes a row in Alice's log that says the
Admin did it, and the chain proves that sentence was not edited afterwards.

Who may act (the "decision for the architect" on #4814, settled here):

* **see** an agent — its principal; a workspace Admin (every agent); anyone who is a
  live member of a project the agent has acted in. Which is a per-person view over
  projects the viewer can already read, so it is OSS; an org-wide agent inventory with
  policy over it is Enterprise.
* **manage** an agent — its principal, or a workspace Admin. An Admin's edit is still
  capped at the *principal's* ceiling (``agent_scope.validate_grant``), and an Admin's
  pause is shown to the principal by name.

The views in front of this module refuse every token-authenticated request, so an
agent can never resume itself, widen its own scope or revoke another agent.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from trueppm_api.apps.agents.models import (
    AgentAction,
    AgentActionVerdict,
    AgentActorKind,
    RefusalConstraint,
)
from trueppm_api.apps.agents.services import hash_request_payload, record_agent_action
from trueppm_api.apps.projects.agent_scope import grant_of, validate_grant
from trueppm_api.apps.projects.models import FULL_SCOPE_ALIASES, SCOPE_MCP_READ, ApiToken

if TYPE_CHECKING:
    from django.db.models import QuerySet
    from rest_framework.request import Request

#: Capability recorded on a control-plane chain row.
CONTROL_CAPABILITY = "agent:control"

#: Window over which refusal Inbox items for one (agent, constraint) are coalesced.
#: A looping agent therefore produces one Inbox row per window, not one per call.
REFUSAL_COALESCE_WINDOW = timedelta(minutes=15)

#: Notification event type for a refused or paused agent call
#: (``NotificationEventType.AGENT_REFUSED``).
AGENT_REFUSED_EVENT = "agent.refused"

#: Constraints that produce an Inbox item for the principal. Both describe the agent's
#: own configuration, which the principal can act on; neither names a resource.
_INBOX_CONSTRAINTS = frozenset({RefusalConstraint.AGENT_PAUSED, RefusalConstraint.CAPABILITY_SCOPE})


def agent_tokens() -> QuerySet[ApiToken]:
    """Every live controlled agent: personal, ``mcp:read``, not full scope, not revoked,
    deleted or expired.

    The queryset form of :func:`~trueppm_api.apps.projects.agent_scope.is_controlled_agent`.
    A personal ``webhooks:manage`` token is deliberately absent: ``AgentControlGuard``
    does not bind it, so the page must not offer a Pause that would do nothing.
    """
    now = timezone.now()
    return (
        ApiToken.objects.filter(owner__isnull=False, is_deleted=False, revoked_at__isnull=True)
        .filter(scopes__contains=[SCOPE_MCP_READ])
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gt=now))
        .exclude(scopes__overlap=list(FULL_SCOPE_ALIASES))
    )


def is_workspace_admin(user: Any) -> bool:
    """Whether ``user`` holds the workspace ADMIN role or above."""
    from trueppm_api.apps.workspace.models import WorkspaceRole
    from trueppm_api.apps.workspace.permissions import workspace_role_for_user

    role = workspace_role_for_user(user)
    return role is not None and role >= WorkspaceRole.ADMIN


def member_project_ids(user: Any) -> QuerySet[Any]:
    """Live project ids ``user`` is a live member of (the agent-actions log's scope)."""
    from trueppm_api.apps.access.models import ProjectMembership

    return ProjectMembership.objects.filter(
        user=user, is_deleted=False, project__is_deleted=False
    ).values_list("project_id", flat=True)


def visible_agents(user: Any, *, admin: bool | None = None) -> QuerySet[ApiToken]:
    """Agents ``user`` may see. Filtered here, server-side, never by the client."""
    qs = agent_tokens().select_related("owner", "agent_paused_by")
    if admin if admin is not None else is_workspace_admin(user):
        return qs
    acted_in_my_projects = AgentAction.objects.filter(
        actor_kind=AgentActorKind.MCP_TOKEN,
        project_id__in=member_project_ids(user),
        actor_token__isnull=False,
    ).values("actor_token_id")
    return qs.filter(Q(owner=user) | Q(pk__in=acted_in_my_projects))


def can_manage(user: Any, token: ApiToken, *, admin: bool | None = None) -> bool:
    """The principal, or a workspace Admin."""
    if token.owner_id is not None and token.owner_id == getattr(user, "pk", None):
        return True
    return admin if admin is not None else is_workspace_admin(user)


def _actor_label(actor: Any) -> str:
    """The acting person as written into a hashed control-row summary: name and id."""
    return f"{display_name(actor)} (user {getattr(actor, 'pk', '?')})"


def display_name(user: Any) -> str:
    """A person's display name for human UI and the hashed control-row summary."""
    if user is None:
        return "a deleted account"
    full = (user.get_full_name() or "").strip()
    return full or user.get_username()


def _record_control(
    request: Request, token: ApiToken, actor: Any, action: str, summary: str
) -> None:
    """Append the control event to the hash chain, in the caller's transaction.

    ``principal`` is the agent's owner; ``actor`` is named in ``summary`` (see the
    module docstring). ``actor`` is accepted so the call sites read as who-did-what.
    """
    from trueppm_api.core.throttling import resolve_client_ip

    del actor  # recorded in the summary by the caller
    record_agent_action(
        actor_kind=AgentActorKind.PERSON,
        actor_token=token,
        principal=token.owner,
        action=action,
        method=request.method or "POST",
        capability_used=CONTROL_CAPABILITY,
        verdict=AgentActionVerdict.ALLOWED,
        payload_hash=hash_request_payload(request),
        object_type="ApiToken",
        object_id=str(token.pk),
        summary=summary,
        source_ip=resolve_client_ip(request),
    )


def _reason_suffix(reason: str) -> str:
    reason = (reason or "").strip()
    return f" Reason: {reason}" if reason else ""


def _locked(token: ApiToken) -> ApiToken:
    return ApiToken.objects.select_for_update(of=("self",)).select_related("owner").get(pk=token.pk)


def pause(request: Request, token: ApiToken, actor: Any, reason: str = "") -> ApiToken:
    """Pause the agent. Idempotent: pausing a paused agent records nothing."""
    with transaction.atomic():
        row = _locked(token)
        if row.agent_paused_at is None:
            row.agent_paused_at = timezone.now()
            row.agent_paused_by = actor
            row.save(update_fields=["agent_paused_at", "agent_paused_by", "server_version"])
            _record_control(
                request,
                row,
                actor,
                "agent.pause",
                f"Agent {row.name} (tppm_{row.token_prefix}) paused by {_actor_label(actor)}."
                + _reason_suffix(reason),
            )
    return row


def resume(request: Request, token: ApiToken, actor: Any, reason: str = "") -> ApiToken:
    """Resume a paused agent. Idempotent."""
    with transaction.atomic():
        row = _locked(token)
        if row.agent_paused_at is not None:
            row.agent_paused_at = None
            row.agent_paused_by = None
            row.save(update_fields=["agent_paused_at", "agent_paused_by", "server_version"])
            _record_control(
                request,
                row,
                actor,
                "agent.resume",
                f"Agent {row.name} (tppm_{row.token_prefix}) resumed by {_actor_label(actor)}."
                + _reason_suffix(reason),
            )
    return row


def edit_scope(
    request: Request, token: ApiToken, actor: Any, requested: object, reason: str = ""
) -> ApiToken:
    """Replace the agent's grant, capped at its principal's ceiling.

    ``requested`` is merged over the current grant (areas left out keep their level),
    then validated against the **principal** — never the editor — so a workspace Admin
    cannot grant above the person the agent acts for.

    Raises:
        ScopeGrantError: the request is malformed, asks for ``write``, or exceeds the
            principal.
    """
    from trueppm_api.apps.projects.agent_scope import ScopeGrantError

    with transaction.atomic():
        row = _locked(token)
        before = grant_of(row)
        if not isinstance(requested, dict):
            raise ScopeGrantError("scope must be an object of area → level.", code="invalid_scope")
        after = validate_grant({**before, **requested}, row.owner)
        if after != before:
            row.agent_scope = after
            row.save(update_fields=["agent_scope", "server_version"])
            diff = {
                area: [before[area], after[area]] for area in after if before[area] != after[area]
            }
            _record_control(
                request,
                row,
                actor,
                "agent.scope_edit",
                f"Agent {row.name} (tppm_{row.token_prefix}) scope changed by "
                f"{_actor_label(actor)}: {json.dumps(diff, sort_keys=True)}."
                + _reason_suffix(reason),
            )
    return row


def revoke(request: Request, token: ApiToken, actor: Any, reason: str = "") -> ApiToken:
    """Revoke the agent's token. Immediate: the authenticator reads ``revoked_at`` per call.

    Mirrors ``MyApiTokenViewSet.destroy``: a webhook the token registered dies with it,
    and the token's own lifecycle log gets a ``revoked`` row, in this transaction.
    """
    from trueppm_api.apps.projects.models import ApiTokenAuditAction, ApiTokenAuditEntry
    from trueppm_api.apps.webhooks.models import deactivate_webhooks_set_by_token
    from trueppm_api.core.throttling import resolve_client_ip

    with transaction.atomic():
        row = _locked(token)
        if row.revoked_at is None:
            row.revoked_at = timezone.now()
            row.save(update_fields=["revoked_at", "server_version"])
            webhooks_deactivated = deactivate_webhooks_set_by_token(row.pk)
            ApiTokenAuditEntry.objects.create(
                owner=row.owner,
                token=row,
                token_prefix=row.token_prefix,
                actor=actor,
                action=ApiTokenAuditAction.REVOKED.value,
                source_ip=resolve_client_ip(request),
                detail={
                    "name": row.name,
                    "webhooks_deactivated": webhooks_deactivated,
                    "via": "agents",
                },
            )
            _record_control(
                request,
                row,
                actor,
                "agent.revoke",
                f"Agent {row.name} (tppm_{row.token_prefix}) token revoked by "
                f"{_actor_label(actor)}." + _reason_suffix(reason),
            )
    return row


def notify_refusal(action: AgentAction) -> None:
    """Put a refused agent call in its principal's Inbox, coalesced (#4814).

    Only for a refusal of the agent's own configuration (paused, out of scope) by an
    agent token, sent to the principal. One row per (agent, constraint) per
    :data:`REFUSAL_COALESCE_WINDOW`: a later refusal updates that row's count and marks
    it unread, so a looping agent cannot fill an inbox. The body names the operation
    attempted and the agent, never project data — what was attempted is the view name,
    which the principal's own agent chose. Gated by the principal's notification
    preference for this event; the row itself is created by the notifications service.
    """
    from trueppm_api.apps.agents.models import AgentActionRefusalDetail
    from trueppm_api.apps.notifications.models import Notification
    from trueppm_api.apps.notifications.services import (
        create_event_notifications,
        event_in_app_enabled,
    )
    from trueppm_api.apps.projects.agent_scope import is_controlled_agent

    if (
        action.verdict != AgentActionVerdict.REFUSED
        or action.actor_kind != AgentActorKind.MCP_TOKEN
    ):
        return
    if action.principal_id is None or action.actor_token_id is None:
        return
    try:
        constraint = action.refusal_detail.constraint
    except AgentActionRefusalDetail.DoesNotExist:
        return
    if constraint not in _INBOX_CONSTRAINTS:
        return

    token = action.actor_token
    if not is_controlled_agent(token):
        return
    # The principal's "When one of your agents is refused" preference, read through the
    # notifications service like every other event, so turning it off stops both a new
    # item and the refresh of a coalesced one.
    if not event_in_app_enabled(action.principal_id, AGENT_REFUSED_EVENT):
        return
    if constraint == RefusalConstraint.AGENT_PAUSED:
        subject = f"Refused: agent {token.name} is paused"
        why = "It is paused, so every call it makes is refused until it is resumed."
    else:
        subject = f"Refused: agent {token.name} is outside its capability scope"
        why = "Its capability scope does not include what it asked for."
    subject = subject[:255]

    now = timezone.now()
    existing = (
        Notification.objects.filter(
            recipient_id=action.principal_id,
            event_type=AGENT_REFUSED_EVENT,
            subject=subject,
            is_archived=False,
            created_at__gte=now - REFUSAL_COALESCE_WINDOW,
        )
        .order_by("-created_at")
        .first()
    )
    count = AgentAction.objects.filter(
        actor_token_id=action.actor_token_id,
        verdict=AgentActionVerdict.REFUSED,
        refusal_detail__constraint=constraint,
        occurred_at__gte=now - REFUSAL_COALESCE_WINDOW,
    ).count()
    times = "once" if count <= 1 else f"{count} times"
    body = (
        f"{why}\n"
        f"Attempted: {action.method} {action.action}.\n"
        f"Agent: {token.name} (tppm_{token.token_prefix}), refused {times} in the last "
        "15 minutes.\n"
        "Nothing changed in the schedule."
    )
    if existing is not None:
        existing.body = body
        existing.is_read = False
        existing.read_at = None
        existing.save(update_fields=["body", "is_read", "read_at"])
        return
    create_event_notifications(
        event_type=AGENT_REFUSED_EVENT,
        recipient_ids=[action.principal_id],
        subject=subject,
        body=body,
        project_id=None,
    )
