"""DRF authentication class for project-scoped API tokens (ADR-0068)."""

from __future__ import annotations

import hashlib
import logging
from typing import TYPE_CHECKING, Any

from django.contrib.auth.models import AnonymousUser
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.extensions import OpenApiAuthenticationExtension
from rest_framework import exceptions
from rest_framework.authentication import BaseAuthentication, get_authorization_header

if TYPE_CHECKING:
    from rest_framework.request import Request

    from trueppm_api.apps.projects.models import ProjectApiToken


logger = logging.getLogger(__name__)

TOKEN_PREFIX = "tppm_"
TOKEN_RAW_HEX_LEN = 64  # SHA-256 hex digest length, also = raw token hex length
TOKEN_TOTAL_LEN = len(TOKEN_PREFIX) + TOKEN_RAW_HEX_LEN  # 69


def sha256_hex(raw: str) -> str:
    """Return the SHA-256 hex digest of the raw token (no salt; 256-bit entropy)."""
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


class ProjectApiTokenAuthentication(BaseAuthentication):
    """Authenticate a request via ``Authorization: Bearer tppm_<64-hex>``.

    On success returns ``(token.created_by, token)`` so DRF sets ``request.user``
    to the token's creator (history rows attribute to a real user) and
    ``request.auth`` to the token itself (the throttle and view use it for the
    project_id and the backfill window).

    On any failure returns a generic 401 with no body detail — prevents
    enumeration of valid token prefixes or revocation states.
    """

    keyword = "Bearer"

    def authenticate(self, request: Request) -> tuple[object, ProjectApiToken] | None:
        # Import here so the module can be imported during Django settings load
        # (the apps registry is not yet ready at import time).
        from trueppm_api.apps.projects.models import ProjectApiToken

        auth = get_authorization_header(request).split()
        if not auth or auth[0].lower() != self.keyword.lower().encode("ascii"):
            return None  # let other authenticators try (JWT, Session)
        if len(auth) == 1:
            raise exceptions.AuthenticationFailed("Invalid token header.")
        if len(auth) > 2:
            raise exceptions.AuthenticationFailed("Invalid token header.")
        try:
            raw_token = auth[1].decode("ascii")
        except UnicodeDecodeError as exc:
            raise exceptions.AuthenticationFailed("Invalid token header.") from exc

        # A ``Bearer`` value that is not one of our ``tppm_``-prefixed tokens is
        # almost certainly a JWT (simplejwt also uses ``Bearer``). Defer to the
        # next authenticator instead of raising, so token auth and JWT auth can
        # coexist on the same view when a read viewset additively lists both.
        # This is required for the read-only MCP scaffold (ADR-0186): the MCP
        # viewsets accept *either* a human JWT session *or* an ``mcp:read`` token.
        if not raw_token.startswith(TOKEN_PREFIX):
            return None

        # Cheap structural validation before any DB lookup.  Avoids exposing the
        # DB to malformed input and makes the timing of a malformed ``tppm_``
        # token indistinguishable from "valid prefix, unknown hash" (both return
        # 401 with no body), preventing enumeration of valid token prefixes.
        if len(raw_token) != TOKEN_TOTAL_LEN:
            raise exceptions.AuthenticationFailed("Invalid token.")

        token_body = raw_token[len(TOKEN_PREFIX) :]
        try:
            int(token_body, 16)  # confirm it parses as hex; rejects arbitrary input
        except ValueError as exc:
            raise exceptions.AuthenticationFailed("Invalid token.") from exc

        # Expiry filter (ADR-0214): a Personal Access Token past its ``expires_at``
        # is treated as if it did not exist — no row, generic 401, no enumeration
        # signal. Applies uniformly: project/program tokens leave ``expires_at``
        # null and match the ``isnull`` branch, so they are unaffected. Folding
        # expiry into the same indexed hash lookup keeps the hot path a single
        # query and preserves the timing-safe "no match → no row" property (no
        # Python-side string compare on secrets is introduced).
        token = (
            ProjectApiToken.objects.filter(
                Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()),
                token_hash=sha256_hex(raw_token),
                revoked_at__isnull=True,
                is_deleted=False,
            )
            .select_related("project", "created_by", "owner")
            .first()
        )
        if token is None:
            # Identity refusal (ADR-0112 RC1): a well-formed token that did not resolve.
            # Audit it *only* when the hash matches a real-but-dead token (revoked,
            # expired, or soft-deleted) — that is a real credential being misused and is
            # bounded by the number of tokens ever minted. An unknown hash is someone
            # guessing; auditing those would be an unbounded, chain-locking DoS amplifier,
            # so it is deliberately not recorded.
            self._audit_identity_refusal(request, raw_token)
            raise exceptions.AuthenticationFailed("Invalid token.")

        # last_used_at is updated in a single UPDATE so we don't perturb the
        # token's server_version or audit_history.  The audit row for the
        # specific use is written by the view (which holds the URL kwargs).
        ProjectApiToken.objects.filter(pk=token.pk).update(last_used_at=timezone.now())

        # request.user resolution (ADR-0214):
        #   - Personal Access Token → the ``owner`` (the acting user). Because
        #     request.user becomes the owner, ALL downstream DRF object-level RBAC
        #     applies exactly as that user's own session — a PAT is not a superuser
        #     credential, it sees only what its owner sees.
        #   - Project/program token → the ``created_by`` minter (owner is null), so
        #     django-simple-history attributes task mutations back to the human who
        #     minted the integration.
        #   - Neither present (a project/program token whose SET_NULL minter was
        #     deleted) → AnonymousUser.
        user = token.owner or token.created_by or AnonymousUser()
        return (user, token)

    def _audit_identity_refusal(self, request: Request, raw_token: str) -> None:
        """Record a refused/identity AgentAction for a real-but-dead token, at most once.

        Runs on the authentication-failure path, inside the request's ATOMIC_REQUESTS
        transaction, before ``AuthenticationFailed`` is raised (DRF turns that into a 401
        response, so the transaction still commits and the audit row survives).

        This path runs during authentication, which DRF executes *before* throttling — so
        it must be bounded on its own. Two guards make it safe against a replay flood
        (ADR-0112 RC1):

          * an **unknown** hash writes nothing (an attacker spraying random tokens never
            reaches the chain-locking write);
          * a **known** dead token (revoked/expired/deleted — revocation is precisely the
            response to a leak, so it *will* be replayed) is audited at most **once ever**
            via a cheap indexed ``exists()`` gate before the write, so a replay loop pays
            only one indexed read and never re-takes the global chain lock.

        The write is also best-effort: a failure is logged and swallowed so it can never
        convert the 401 into a 500 (matching the permission-layer refusal path).
        """

        from trueppm_api.apps.agents.models import (
            AgentAction,
            AgentActionRefusalReason,
            AgentActionVerdict,
            AgentActorKind,
            RefusalConstraint,
        )
        from trueppm_api.apps.agents.services import (
            hash_request_payload,
            record_agent_action,
        )
        from trueppm_api.apps.projects.models import ProjectApiToken

        dead = (
            ProjectApiToken.objects.filter(token_hash=sha256_hex(raw_token))
            .select_related("owner")
            .first()
        )
        if dead is None:
            return  # unknown hash — do not audit (unbounded; DoS-safe)

        # Bound a replayed dead token to a single chain-locking write, ever.
        if AgentAction.objects.filter(
            actor_token=dead, refusal_reason=AgentActionRefusalReason.IDENTITY
        ).exists():
            return

        xff = request.META.get("HTTP_X_FORWARDED_FOR")
        source_ip = xff.split(",")[0].strip() if xff else request.META.get("REMOTE_ADDR")
        try:
            record_agent_action(
                actor_kind=AgentActorKind.MCP_TOKEN,
                actor_token=dead,
                principal=dead.owner,
                action="authenticate",
                method=request.method or "",
                capability_used="",
                verdict=AgentActionVerdict.REFUSED,
                refusal_reason=AgentActionRefusalReason.IDENTITY,
                # Finer constraint axis (ADR-0421, #1850): a dead/revoked token is a
                # token_identity refusal; an identity rejection carries no schedule impact.
                refusal_constraint=RefusalConstraint.TOKEN_IDENTITY,
                payload_hash=hash_request_payload(request),
                summary="Rejected a revoked/expired/deleted API token",
                source_ip=source_ip,
            )
        except Exception:
            # Never let an audit-write failure turn the 401 into a 500.
            logger.warning("agent-action identity-refusal audit failed", exc_info=True)

    def authenticate_header(self, request: Request) -> str:
        return self.keyword


# drf-spectacular's OpenApiAuthenticationExtension registers subclasses via an
# untyped __init_subclass__, which mypy --strict flags as an untyped call on the
# class definition. The registration is the documented extension mechanism.
class ProjectApiTokenScheme(OpenApiAuthenticationExtension):  # type: ignore[no-untyped-call]
    """drf-spectacular security scheme for project-scoped API tokens (#1016).

    Without this, drf-spectacular cannot map ``ProjectApiTokenAuthentication`` to a
    security scheme, so endpoints that override ``authentication_classes`` with it
    (``TaskSyncView``) silently inherit the global ``jwtAuth`` in the schema —
    integrators read the schema, send a JWT, and get 401. Registering the scheme
    here (next to the auth class, imported whenever a view references it) makes the
    schema advertise the correct ``Authorization: Bearer tppm_<64-hex>`` contract.
    """

    target_class = "trueppm_api.apps.projects.authentication.ProjectApiTokenAuthentication"
    name = "projectApiTokenAuth"

    def get_security_definition(self, auto_schema: Any) -> dict[str, Any]:
        return {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "tppm_<64-hex>",
            "description": (
                "Project-scoped API token (ADR-0068). Send as "
                "`Authorization: Bearer tppm_<64-hex>`. Mint one in project settings; "
                "it is scoped to a single project and the task-sync surface."
            ),
        }
