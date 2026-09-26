"""Key resolution and key availability endpoints (ADR-1237 §5, §6).

``GET /api/v1/resolve/`` turns whatever a person pasted — a project or program
key, a retired key, a UUID, or a ``PLAT-T-10`` reference — into the UUIDs every
other endpoint takes. ``GET /api/v1/keys/`` backs the create form's live key
suggestion and availability check.

The security property of the resolver is that it cannot tell a caller anything
about an object they cannot read. That is structural, not a check: every lookup
runs against ONE queryset that is already restricted to what the caller can
read, intersected with the token's scope, so there is no "found it, now check
permission" branch whose timing or body could differ. Missing, hidden,
out-of-token-scope and retired-key-of-a-hidden-project all fall out of the same
empty queryset and return the same bytes. A future "fast path" that looks an
``ObjectKey`` up first and checks access second reintroduces the distinction;
``test_resolve_404_is_indistinguishable`` is the tripwire.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from django.db.models import Exists, OuterRef, Q, QuerySet
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership
from trueppm_api.apps.projects.keys import (
    KIND_PROGRAM,
    KIND_PROJECT,
    KINDS,
    base_key_for,
    is_reserved,
    key_format_error,
    normalize_key,
)
from trueppm_api.apps.projects.models import (
    ApiToken,
    ObjectKey,
    Program,
    Project,
    Risk,
    Sprint,
    Task,
)

#: ``<KEY>-<T|SP|R>-<n>``. The greedy ``.+`` makes the match take the RIGHTMOST
#: marker, so a grandfathered hyphenated key parses: ``GA-SEC-T-10`` is key
#: ``GA-SEC``, task 10 (ADR-1237 §2).
_REF_RE = re.compile(r"(?P<key>.+)-(?P<marker>T|SP|R)-(?P<n>[0-9]{1,9})", re.IGNORECASE)

#: The one 404 body. Built here, once, and returned verbatim from every
#: not-found branch so the four cases cannot drift apart byte-wise.
_NOT_FOUND_BODY = {"detail": "Not found."}

_MAX_REF_LENGTH = 128

RESOLVE_RESPONSE = inline_serializer(
    "ResolveResponse",
    {
        "type": serializers.ChoiceField(choices=["project", "program", "task", "sprint", "risk"]),
        "id": serializers.UUIDField(),
        "project_id": serializers.UUIDField(allow_null=True),
        "program_id": serializers.UUIDField(allow_null=True),
        "key": serializers.CharField(
            allow_null=True,
            help_text=(
                "The CURRENT key of the project (or program) the ref belongs to — a "
                "retired key resolves, and this is what it was renamed to. Null for a "
                "project that has no key yet (addressable by UUID only)."
            ),
        ),
        "canonical_ref": serializers.CharField(
            help_text=(
                "The current reference form: `PLAT`, `atlas-platform-launch`, "
                "`PLAT-T-10`, `PLAT-SP-3`, `PLAT-R-7`. The UUID when the owning "
                "project has no key."
            )
        ),
    },
)

KEY_SUGGESTION_RESPONSE = inline_serializer(
    "KeySuggestionResponse",
    {
        "available": serializers.BooleanField(
            required=False,
            help_text="Present only when `key` was sent. Whether that key can be used.",
        ),
        "reason": serializers.ChoiceField(
            choices=["taken", "reserved", "invalid"],
            allow_null=True,
            required=False,
            help_text=(
                "Present only when `key` was sent. Why it is unavailable: `taken` "
                "(held now or before by some project/program — never says which), "
                "`reserved` (`new`, `settings`, `trash`, or UUID-shaped), or `invalid` "
                "(does not match the format). Null when available."
            ),
        ),
        "suggestion": serializers.CharField(
            help_text=(
                "A free key: derived from `name`, or the next free suffix of `key` "
                "(`PLAT` → `PLAT2`). Free at the time of the call only."
            )
        ),
    },
)

_ERROR_RESPONSE = inline_serializer("KeyRequestError", {"detail": serializers.CharField()})


def _bad_request(detail: str) -> Response:
    return Response({"detail": detail}, status=status.HTTP_400_BAD_REQUEST)


def _kind(request: Request) -> str | None:
    kind = (request.query_params.get("kind") or "").strip().lower()
    return kind if kind in KINDS else None


def _user(request: Request) -> Any:
    # IsAuthenticated has already run; the Any keeps AnonymousUser out of the lookup type.
    return request.user


def readable_projects(request: Request) -> QuerySet[Project]:
    """Projects the caller can read, intersected with the token's scope (ADR-1237 §5).

    Readable is the same rule ``ProjectScopedViewSet`` applies: a live
    ``ProjectMembership`` on a live project. A project- or program-scoped
    ``ApiToken`` authenticates *as its minter*, so without the intersection it
    would resolve every project the minter can see — the #1712 blast-radius
    problem on a new surface.
    """
    qs = Project.objects.filter(
        is_deleted=False,
        pk__in=ProjectMembership.objects.filter(user=_user(request), is_deleted=False).values(
            "project_id"
        ),
    )
    token = getattr(request, "auth", None)
    if isinstance(token, ApiToken):
        if token.project_id is not None:
            qs = qs.filter(pk=token.project_id)
        elif token.program_id is not None:
            qs = qs.filter(program_id=token.program_id)
    return qs


def readable_programs(request: Request) -> QuerySet[Program]:
    """Programs the caller can read, intersected with the token's scope.

    A project-scoped token resolves no program at all: it was minted for one
    project, and the program around it is not part of that grant.
    """
    qs = Program.objects.filter(is_deleted=False).filter(
        Exists(
            ProgramMembership.objects.filter(
                program=OuterRef("pk"), user=_user(request), is_deleted=False
            )
        )
    )
    token = getattr(request, "auth", None)
    if isinstance(token, ApiToken):
        if token.project_id is not None:
            return qs.none()
        if token.program_id is not None:
            qs = qs.filter(pk=token.program_id)
    return qs


def _match_key(qs: QuerySet[Any], kind: str, key: str) -> Any:
    """The object in ``qs`` whose current or retired key is ``key``, or ``None``.

    ``code`` is matched as well as ``ObjectKey`` so a key written by a pre-0.4 pod
    during the rolling upgrade, which has no row yet, still resolves.
    """
    fk = "program_id" if kind == KIND_PROGRAM else "project_id"
    held = ObjectKey.objects.filter(kind=kind, key__iexact=key).values(fk)
    return qs.filter(Q(code__iexact=key) | Q(pk__in=held)).first()


def _owner_ref(project: Project) -> str | None:
    return project.code or None


def _project_body(project: Project) -> dict[str, Any]:
    return {
        "type": KIND_PROJECT,
        "id": str(project.pk),
        "project_id": str(project.pk),
        "program_id": str(project.program_id) if project.program_id else None,
        "key": _owner_ref(project),
        "canonical_ref": project.code or str(project.pk),
    }


def _program_body(program: Program) -> dict[str, Any]:
    return {
        "type": KIND_PROGRAM,
        "id": str(program.pk),
        "project_id": None,
        "program_id": str(program.pk),
        "key": program.code or None,
        "canonical_ref": program.code or str(program.pk),
    }


def _child_body(project: Project, kind: str, obj: Any, marker: str, number: int) -> dict[str, Any]:
    return {
        "type": kind,
        "id": str(obj.pk),
        "project_id": str(project.pk),
        "program_id": str(project.program_id) if project.program_id else None,
        "key": _owner_ref(project),
        "canonical_ref": f"{project.code}-{marker}-{number}" if project.code else str(obj.pk),
    }


def _resolve_child(project: Project, marker: str, number: int) -> dict[str, Any] | None:
    """Decode a ``T``/``SP``/``R`` number against ``project``.

    Tasks and sprints share the hex ``object_sequence`` short id, so ``T-10`` is
    ``short_id == "0000000A"`` (see ``format_short_id_display``); risks keep their
    own decimal counter, so ``R-7`` is ``short_id == "7"`` (#929).
    """
    if marker == "R":
        risk = Risk.objects.filter(project=project, short_id=str(number), is_deleted=False).first()
        return _child_body(project, "risk", risk, "R", number) if risk else None
    hex_id = f"{number:08X}"
    if marker == "T":
        task = Task.objects.filter(project=project, short_id=hex_id, is_deleted=False).first()
        return _child_body(project, "task", task, "T", number) if task else None
    sprint = Sprint.objects.filter(project=project, short_id=hex_id, is_deleted=False).first()
    return _child_body(project, "sprint", sprint, "SP", number) if sprint else None


class ResolveView(APIView):
    """Resolve a key, retired key, UUID, or ``PLAT-T-10`` reference to UUIDs (ADR-1237 §5).

    Read-only, no side effects, no audit event. Anything the caller cannot read
    — or that does not exist — is the same ``404 {"detail": "Not found."}``.
    """

    permission_classes = [IsAuthenticated]  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "resolve"

    @extend_schema(
        summary="Resolve a project/program key or reference to its ids",
        description=(
            "`ref` is a current key, a retired key, a UUID, or `<KEY>-<T|SP|R>-<n>` "
            "(project kind only). A hyphenated legacy key parses on the rightmost "
            "marker: `GA-SEC-T-10` is task 10 of `GA-SEC`. `key` and `canonical_ref` "
            "are always the CURRENT form, so a client holding a retired key learns "
            "the new one.\n\n"
            "Visibility is the lookup: only projects/programs the caller is a live "
            "member of, intersected with a project/program token's scope, can match. "
            'Everything else — missing, hidden, out of token scope — is `404 {"detail": '
            '"Not found."}`, byte-identical. Throttle scope `resolve`.'
        ),
        parameters=[
            OpenApiParameter("kind", str, OpenApiParameter.QUERY, required=True, enum=list(KINDS)),
            OpenApiParameter("ref", str, OpenApiParameter.QUERY, required=True),
        ],
        responses={
            200: RESOLVE_RESPONSE,
            400: OpenApiResponse(
                response=_ERROR_RESPONSE, description="Missing or invalid kind/ref."
            ),
            404: OpenApiResponse(
                response=_ERROR_RESPONSE,
                description="Nothing the caller can read matches `ref`.",
            ),
        },
    )
    def get(self, request: Request) -> Response:
        kind = _kind(request)
        if kind is None:
            return _bad_request("kind must be 'project' or 'program'.")
        ref = (request.query_params.get("ref") or "").strip()
        if not ref or len(ref) > _MAX_REF_LENGTH:
            return _bad_request("ref is required.")
        body = self._resolve(request, kind, ref)
        if body is None:
            return Response(dict(_NOT_FOUND_BODY), status=status.HTTP_404_NOT_FOUND)
        return Response(body)

    def _resolve(self, request: Request, kind: str, ref: str) -> dict[str, Any] | None:
        if kind == KIND_PROGRAM:
            programs = readable_programs(request)
            try:
                program = programs.filter(pk=uuid.UUID(ref)).first()
            except ValueError:
                program = _match_key(programs, KIND_PROGRAM, ref)
            return _program_body(program) if program is not None else None

        projects = readable_projects(request)
        try:
            project = projects.filter(pk=uuid.UUID(ref)).first()
        except ValueError:
            project = None
        else:
            return _project_body(project) if project is not None else None

        # The whole ref as a key first: a grandfathered code can itself end in
        # something marker-shaped, and addressing the project must win.
        project = _match_key(projects, KIND_PROJECT, ref)
        if project is not None:
            return _project_body(project)
        match = _REF_RE.fullmatch(ref)
        if match is None:
            return None
        project = _match_key(projects, KIND_PROJECT, match["key"])
        if project is None:
            return None
        return _resolve_child(project, match["marker"].upper(), int(match["n"]))


class KeySuggestionView(APIView):
    """Suggest a key from a name, or check one key's availability (ADR-1237 §6).

    **This is an existence oracle, and that is accepted.** A workspace-unique
    namespace cannot refuse a taken key without saying it is taken, so a caller
    learns that *some* project holds ``ACME`` — never which one, its name, or its
    UUID. Scoping this to the caller's membership would silently allow duplicate
    keys; do not "fix" it. Throttled in the same ``resolve`` bucket.
    """

    permission_classes = [IsAuthenticated]  # noqa: RUF012
    throttle_classes = [ScopedRateThrottle]  # noqa: RUF012
    throttle_scope = "resolve"

    @extend_schema(
        summary="Suggest a project/program key, or check one for availability",
        description=(
            "Send `name` to get `{suggestion}` derived from it (`Platform` → `PLAT`, "
            "then `PLAT2` when taken). Send `key` to get `{available, reason, "
            "suggestion}`. A key is taken if any project (or program) holds or ever "
            "held it — keys are never reissued. The response never names the holder. "
            "`object_id` (optional, with `key`) is the project/program being renamed: "
            "its own current and retired keys are reported available, because "
            "renaming back is allowed. Throttle scope `resolve`."
        ),
        parameters=[
            OpenApiParameter("kind", str, OpenApiParameter.QUERY, required=True, enum=list(KINDS)),
            OpenApiParameter("name", str, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("key", str, OpenApiParameter.QUERY, required=False),
            OpenApiParameter("object_id", str, OpenApiParameter.QUERY, required=False),
        ],
        responses={
            200: KEY_SUGGESTION_RESPONSE,
            400: OpenApiResponse(
                response=_ERROR_RESPONSE, description="Missing kind, or neither name nor key."
            ),
        },
    )
    def get(self, request: Request) -> Response:
        from trueppm_api.apps.projects.services import derive_key, is_key_taken, suggest_free_key

        kind = _kind(request)
        if kind is None:
            return _bad_request("kind must be 'project' or 'program'.")
        raw_key = (request.query_params.get("key") or "").strip()
        name = (request.query_params.get("name") or "").strip()
        if raw_key:
            if len(raw_key) > _MAX_REF_LENGTH:
                return _bad_request("key is too long.")
            key = normalize_key(raw_key, kind)
            problem = key_format_error(key, kind)
            if problem is not None:
                reserved = is_reserved(key)
                base = key if reserved else base_key_for(raw_key, kind)
                return Response(
                    {
                        "available": False,
                        "reason": "reserved" if reserved else "invalid",
                        "suggestion": suggest_free_key(base, kind),
                    }
                )
            exclude = self._renamed_object(request, kind)
            if is_key_taken(kind, key, exclude=exclude):
                return Response(
                    {
                        "available": False,
                        "reason": "taken",
                        "suggestion": suggest_free_key(key, kind),
                    }
                )
            return Response({"available": True, "reason": None, "suggestion": key})
        if name:
            if len(name) > 255:
                return _bad_request("name is too long.")
            return Response({"suggestion": derive_key(name, kind)})
        return _bad_request("Send name or key.")

    def _renamed_object(self, request: Request, kind: str) -> Any:
        """The object being renamed, when the caller can read it; else ``None``.

        Resolved through the same readable querysets as the resolver, so naming
        an object you cannot see simply has no effect.
        """
        raw = (request.query_params.get("object_id") or "").strip()
        if not raw:
            return None
        try:
            pk = uuid.UUID(raw)
        except ValueError:
            return None
        qs: QuerySet[Any] = (
            readable_programs(request) if kind == KIND_PROGRAM else readable_projects(request)
        )
        return qs.filter(pk=pk).first()
