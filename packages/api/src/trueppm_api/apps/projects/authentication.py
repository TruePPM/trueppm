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

# Deliberately generic 401 details — prevent enumeration of token states.
_INVALID_TOKEN_HEADER_DETAIL = "Invalid token header."
_INVALID_TOKEN_DETAIL = "Invalid token."


def sha256_hex(raw: str) -> str:
    """Return the SHA-256 hex digest of the raw token (no salt; 256-bit entropy).

    Encodes as UTF-8 rather than ASCII so a non-ASCII ``raw`` (e.g. a hand-crafted
    ``/api/v1/share/<token>/`` path segment) hashes to a non-matching digest and
    resolves as "unknown token" (→ 404 / 401) instead of raising an unhandled
    ``UnicodeEncodeError`` → 500 (#2126). Minted tokens are always URL-safe ASCII
    (``secrets.token_urlsafe``), for which UTF-8 and ASCII produce identical bytes,
    so every existing ``token_hash`` is unchanged — this only stops the crash.
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


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
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_HEADER_DETAIL)
        if len(auth) > 2:
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_HEADER_DETAIL)
        try:
            raw_token = auth[1].decode("ascii")
        except UnicodeDecodeError as exc:
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_HEADER_DETAIL) from exc

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
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_DETAIL)

        token_body = raw_token[len(TOKEN_PREFIX) :]
        try:
            int(token_body, 16)  # confirm it parses as hex; rejects arbitrary input
        except ValueError as exc:
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_DETAIL) from exc

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
            self._mark_identity_refusal(request)
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_DETAIL)

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
        resolved = token.owner or token.created_by

        # Disabled-account handling (#2832). The invariant: a credential that derives
        # its authority from a human must stop working when that human's account is
        # disabled. Every other authenticator in DEFAULT_AUTHENTICATION_CLASSES already
        # held it — simplejwt rejects an inactive user by default and DRF's
        # SessionAuthentication checks ``user.is_active`` — while this class had no
        # ``is_active`` reference at all, so off-boarding a member killed their sessions
        # and JWTs and left every Personal Access Token they had minted live, bearing
        # their full pre-departure authority. ``IsAuthenticated`` cannot close that:
        # ``User.is_authenticated`` is unconditionally True.
        #
        # This is defense in depth, not the primary control — the workspace off-boarding
        # paths revoke the tokens outright (apps/workspace/views.py). It catches accounts
        # disabled by some *other* path (Django admin, a management command, a future
        # SSO/SCIM deprovision), which never touch ``revoked_at``.
        #
        # The guard is scoped to ``is_personal`` on purpose, and the scope is the whole
        # design decision — read this before widening it:
        #
        #   * A **personal** token IS the human's credential. It exists to act as them
        #     and inherits their permissions wholesale, so disabling the account has to
        #     kill it. That is #2832.
        #   * A **project/program** token is an ORG asset. Its authority comes from its
        #     own project/program scope plus ``IsTokenForProject``; ``created_by`` is
        #     history attribution for whoever minted it, not the source of its rights.
        #     Rejecting it would kill a team's CI the moment an unrelated colleague is
        #     off-boarded — the very outcome ``revoke_all_personal_access_tokens``'s
        #     ``owner=user`` scoping (and the off-boarding path that calls it) exists to
        #     avoid. Downgrading to ``AnonymousUser`` instead is no better: both
        #     token-only views pair ``IsTokenForProject`` with ``IsAuthenticated``, so an
        #     anonymous principal 403s there — same broken pipeline, different status
        #     code. Leaving these tokens alone is therefore the only option that keeps
        #     the promise the revocation scope makes.
        #
        # Residual, pre-existing and deliberately NOT closed here: on the MCP-readable
        # surface a project/program token still resolves ``request.user`` to its minter,
        # so a deactivated minter's memberships still drive that read-only RBAC. That is
        # a property of ADR-0214's attribution model, not of off-boarding, and narrowing
        # it belongs with the MCP guards rather than in the shared base authenticator.
        #
        # The refusal is placed BEFORE the ``last_used_at`` stamp below so a refused
        # request leaves no trace of "use" on the token, exactly as a revoked or expired
        # token does — the stamp means "this credential successfully authenticated," and
        # it would be misleading on a token that did not.
        if token.is_personal and resolved is not None and not resolved.is_active:
            # Same refusal path as a dead token: identical generic 401, same audit
            # bounding, so a caller cannot distinguish "owner disabled" from "revoked"
            # from "never existed" — anti-enumeration is unchanged.
            self._audit_identity_refusal(request, raw_token)
            self._mark_identity_refusal(request)
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_DETAIL)

        # last_used_at is updated in a single UPDATE so we don't perturb the
        # token's server_version or audit_history.  The audit row for the
        # specific use is written by the view (which holds the URL kwargs).
        ProjectApiToken.objects.filter(pk=token.pk).update(last_used_at=timezone.now())

        user = resolved or AnonymousUser()
        return (user, token)

    def _mark_identity_refusal(self, request: Request) -> None:
        """Tag the request so the 401 body carries the taxonomy (#2689).

        Separate from :meth:`_audit_identity_refusal`, which is bounded to one
        write ever per dead token. This mark is free and must happen on **every**
        rejection, or the second replay of a revoked token would get a bare 401
        while the first got an explanation — the sort of inconsistency that reads
        as a bug in the caller.

        ``token_identity`` is disclosable: it describes the credential the caller
        supplied, and reveals nothing about any resource. The response detail
        itself stays ``_INVALID_TOKEN_DETAIL``, so this does not distinguish
        "revoked" from "expired" from "never existed" — the enumeration-resistance
        of that message is unchanged.
        """

        from trueppm_api.apps.agents.models import AgentActionRefusalReason, RefusalConstraint
        from trueppm_api.apps.agents.refusal import mark_refusal

        mark_refusal(
            request,
            AgentActionRefusalReason.IDENTITY,
            RefusalConstraint.TOKEN_IDENTITY,
        )

    def _audit_identity_refusal(self, request: Request, raw_token: str) -> None:
        """Record a refused/identity AgentAction for a real-but-unusable token, at most once.

        "Unusable" is either a dead token (revoked/expired/soft-deleted) or a live token
        whose owning account has been disabled (#2832) — both are a real credential being
        presented after it stopped conferring authority, and both are bounded by the
        number of tokens ever minted.

        Runs on the authentication-failure path, before ``AuthenticationFailed`` is
        raised. The row is **queued**, not written here: DRF turns that exception into a
        401 via ``exception_handler``, which calls ``set_rollback()``, so an INSERT
        issued inside the request's ATOMIC_REQUESTS transaction would execute and then be
        discarded. It is drained by ``AgentActionAuditMiddleware`` once the transaction
        has closed (#3017, ADR-0902).

        This docstring previously claimed the opposite — "the transaction still commits
        and the audit row survives". It did not: a revoked token's 401 left zero rows,
        measured, exactly like the policy refusals #3017 was filed for.

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
        convert the 401 into a 500 (matching the permission-layer refusal path). Since
        the drain runs after this method returns, every value it needs is resolved here
        and captured in the queued kwargs.
        """

        from trueppm_api.apps.agents.deferred import queue_agent_action
        from trueppm_api.apps.agents.models import (
            AgentAction,
            AgentActionRefusalReason,
            AgentActionVerdict,
            AgentActorKind,
            RefusalConstraint,
        )
        from trueppm_api.apps.agents.services import hash_request_payload
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

        # Name the actual refusal class. A responder reading this row for a token whose
        # owner was disabled would otherwise hunt for a revocation that never happened —
        # the row is internal-only (the 401 body stays generic), so it costs no
        # enumeration signal to be accurate here.
        summary = (
            "Rejected an API token whose owning account is disabled"
            if dead.owner is not None and not dead.owner.is_active
            else "Rejected a revoked/expired/deleted API token"
        )

        xff = request.META.get("HTTP_X_FORWARDED_FOR")
        source_ip = xff.split(",")[0].strip() if xff else request.META.get("REMOTE_ADDR")
        queue_agent_action(
            request,
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
            summary=summary,
            source_ip=source_ip,
        )

    def authenticate_header(self, request: Request) -> str:
        return self.keyword


class OwnerScopedApiTokenAuthentication(ProjectApiTokenAuthentication):
    """Owner-scoped-only variant, wired into the *general* endpoint surface (#2547).

    Before this class existed, ``ProjectApiTokenAuthentication`` was never a part of
    any default/general authentication path — the only two views that referenced it
    explicitly (``TaskSyncView``, the acceptance-result ingest view) both additionally
    require ``IsTokenForProject``, which a personal token (``project=None``,
    ``program=None``) can never satisfy. A minted Personal Access Token therefore had
    no endpoint to authenticate against at all, contradicting ADR-0214's description
    of a PAT as a credential that "acts as that user" the way a JWT/session would.

    This class is what ``DEFAULT_AUTHENTICATION_CLASSES`` references (prepended
    before JWT, mirroring ``McpReadableViewMixin.get_authenticators``'s ordering — the
    base class returns ``None`` for a non-``tppm_`` bearer, so JWT still gets a turn).
    It accepts a token here only when **both**:

      * it is owner-scoped (``token.is_personal``) — a project/program token resolves
        ``request.user`` to its ``created_by`` *minter*, not itself. Accepting one on
        the general surface would silently grant that narrow integration credential
        every permission the minting human holds account-wide (every project/program
        they belong to), not just the single project/program it was scoped to — the
        confused-deputy widening ``IsTokenForProject`` exists to prevent on the narrow
        surface, reproduced here for the wide one. Project/program tokens keep
        authenticating exactly as before, only via the base class that
        ``TaskSyncView``/the acceptance-result view and ``McpReadableViewMixin``
        reference directly (which runs *before* this subclass gets a turn on an
        MCP-wrapped view, since the mixin prepends its own bare-class instance).
      * it carries the ``legacy:full`` scope — an ``mcp:read``-only token stays
        confined to the curated, explicitly opted-in MCP-readable surface (which
        checks scope itself via ``TokenHasScope``/``TokenReadOnlyMethods``). Nothing
        on a general (non-MCP-wrapped) view checks token scope, so without this guard
        an ``mcp:read`` token would gain full read/write here — the exact opposite of
        "rejected at every write path" the token's own scope description promises.

    Anything else (project/program-scoped, or owner-scoped without ``legacy:full``)
    is rejected with the same generic 401 as every other failure on the base class —
    a caller cannot distinguish "wrong token type for this surface" from "invalid
    token," preserving the anti-enumeration posture.

    The rejection carries the ``token_identity`` refusal envelope (#2878). *"I minted
    a read-only token and pointed my script at ``/api/v1/tasks/``"* is the most
    likely first-hour integration mistake, and it was answering with a bare
    ``{"detail": "Invalid token."}`` — a caller holding a token they can see is live
    in the UI has no way to reason from that to "wrong scope for this surface". The
    envelope names the *class* of problem (the credential, not the request) without
    weakening the constant ``detail``, so "wrong scope", "revoked", "expired" and
    "never existed" remain indistinguishable and enumeration resistance is unchanged.
    """

    def authenticate(self, request: Request) -> tuple[object, ProjectApiToken] | None:
        result = super().authenticate(request)
        if result is None:
            return None
        _, token = result

        from trueppm_api.apps.projects.models import SCOPE_LEGACY_FULL

        if not token.is_personal or SCOPE_LEGACY_FULL not in (token.scopes or []):
            # Marked, not audited: `_audit_identity_refusal` is deliberately bounded to
            # tokens that have stopped conferring authority at all (revoked/expired/
            # owner disabled). This token is live and legitimate — it is simply on the
            # wrong surface — so auditing it would turn an ordinary misconfiguration
            # into unbounded audit-chain writes on every retry of a misaimed loop.
            self._mark_identity_refusal(request)
            raise exceptions.AuthenticationFailed(_INVALID_TOKEN_DETAIL)
        return result


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
                "TruePPM API token. Send as `Authorization: Bearer tppm_<64-hex>`. "
                "Three token types share this scheme: personal (owner-scoped) tokens "
                "minted in personal settings; project-scoped tokens (ADR-0068) bound to "
                "a single project's task-sync surface; and program-scoped tokens bound to "
                "a program. A token also carries scopes: `legacy:full` (the historical "
                "unrestricted superset) or `mcp:read` (the read-only MCP surface — "
                "owner-scoped tokens only). MCP-token access can be disabled instance-wide "
                "by the operator (TRUEPPM_MCP_ENABLED)."
            ),
        }


class OwnerScopedApiTokenScheme(OpenApiAuthenticationExtension):  # type: ignore[no-untyped-call]
    """drf-spectacular security scheme for the general-endpoint PAT surface (#2547).

    Registered separately from ``ProjectApiTokenScheme`` because
    ``OwnerScopedApiTokenAuthentication`` is a distinct importable class (the
    ``DEFAULT_AUTHENTICATION_CLASSES`` entry) — without its own scheme, every
    endpoint that reaches it only via the default stack (i.e. everything that
    doesn't override ``authentication_classes``) would advertise only ``jwtAuth`` in
    the schema, the same drift ``ProjectApiTokenScheme`` was written to prevent.
    """

    target_class = "trueppm_api.apps.projects.authentication.OwnerScopedApiTokenAuthentication"
    name = "personalApiTokenAuth"

    def get_security_definition(self, auto_schema: Any) -> dict[str, Any]:
        return {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "tppm_<64-hex>",
            "description": (
                "Personal Access Token. Send as `Authorization: Bearer tppm_<64-hex>`. "
                "Authenticates as the token's owner against the general API surface — "
                "identical RBAC to that user's own session, requires the `legacy:full` "
                "scope. Project- and program-scoped integration tokens are never "
                "accepted here (see `projectApiTokenAuth` for their narrow inbound-sync "
                "surface); an owner-scoped `mcp:read`-only token is also rejected here "
                "and stays confined to the read-only MCP surface."
            ),
        }
