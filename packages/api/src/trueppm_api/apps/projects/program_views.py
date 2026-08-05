"""ViewSets for the Program entity (ADR-0070).

Programs are top-level (not project-scoped), so they live in their own viewset
rather than under the ProjectViewSet nesting. Membership is nested separately
in the access app, mirroring how :class:`ProjectMembershipViewSet` lives next
to :class:`ProjectViewSet`.

This module is intentionally thin — the heavy lifting (atomic creation, cascade
delete, role checks) is in :mod:`trueppm_api.apps.access.services` and
:mod:`trueppm_api.apps.access.permissions`.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from typing import Any, cast

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q, QuerySet, Subquery
from django.http import FileResponse, Http404, HttpResponse, HttpResponseBase
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import filters, pagination, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import BasePermission, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from trueppm_api.apps.access.models import ProgramMembership
from trueppm_api.apps.access.permissions import (
    IsProgramAdmin,
    IsProgramMember,
    IsProgramNotClosed,
    IsProgramOwner,
    IsProgramScheduler,
    McpReadableViewMixin,
    McpScope,
)
from trueppm_api.apps.access.services import (
    create_program,
    delete_program_cascade,
    hard_delete_program,
    transfer_program_sponsorship,
)
from trueppm_api.apps.idempotency.mixins import IdempotencyMixin

# DirectoryPagination is defined in views.py (which does not import this module, so
# the module-level import is cycle-safe) and shared so /programs/ matches /projects/
# on the raised page ceiling (ADR-0401).
from trueppm_api.apps.profiles.services import annotate_is_pinned
from trueppm_api.apps.projects.bulk_settings import (
    BulkFieldsRequestSerializer,
    ProgramBulkFieldsSerializer,
    ProjectBulkFieldsSerializer,
    apply_bulk_fields,
    build_bulk_response,
)
from trueppm_api.apps.projects.models import (
    ExportJobStatus,
    Methodology,
    Program,
    ProgramExportJob,
    ProgramImportJob,
    Project,
    Task,
    TaskStatus,
    format_short_id_display,
)
from trueppm_api.apps.projects.serializers import (
    ProgramExportJobSerializer,
    ProgramImportJobSerializer,
    ProgramRiskPolicySerializer,
    ProgramRollupConfigSerializer,
    ProgramSerializer,
    ProjectSerializer,
    SeedImportRequestSerializer,
)
from trueppm_api.apps.projects.views import (
    _SCHEDULE_NOT_COMPUTED,
    PIN_ENDPOINT_DESCRIPTION,
    PIN_LIMIT_RESPONSE,
    PROGRAM_PIN_RESPONSE,
    DirectoryPagination,
    _resolve_allocation_window,
    _ScheduleNotComputedError,
    pin_limit_detail,
)
from trueppm_api.apps.workspace.permissions import IsWorkspaceAdmin
from trueppm_api.core.openapi import suppress_list_pagination

# Upper bound on sub-programs created by a single split call (#967). Generous
# enough for "one sub-program per project" on a large program, but caps the
# unbounded-empty-program creation vector.
_MAX_SPLITS = 50


class _SeedImporterThrottle(UserRateThrottle):
    """Shared base for the two actions that run the seed importer (#2402).

    ``import_seed`` and ``load_sample`` both call ``import_seed()``, by a wide
    margin the most expensive write in the API. Each call hard-deletes the
    caller's prior program carrying the same code (memberships → projects →
    cascade over tasks, dependencies, sprints, risks, baselines) and rebuilds the
    document synchronously inside one transaction: per-row saves with
    ``simple_history`` rows attached, the v2 replay timeline, and the
    forecast-history backfill. The bundled default sample alone costs ~3,700
    sequential DB round-trips, and holds a ``select_for_update()`` throughout.

    Left on the general ``user`` default of 1000/min a single authenticated
    member could drive a thousand full teardown-and-rebuild cycles a minute —
    the resource-exhaustion shape the ``monte_carlo`` scopes already guard
    against, at a higher per-call cost. The two actions get *separate* buckets so
    loading a demo never spends a user's real import allowance.

    Subclasses ``UserRateThrottle`` (as ``ShareLinkMintThrottle`` does) rather
    than ``ScopedRateThrottle`` deliberately: these are attached per-action
    through the ``@action(throttle_classes=[…])`` kwarg, so the view carries no
    ``throttle_scope`` attribute. ``ScopedRateThrottle.allow_request`` re-reads
    the scope off the view and silently returns True when it finds none, which
    would clobber a class-level ``scope`` and leave the endpoint unthrottled
    while *looking* bounded. ``UserRateThrottle`` resolves the scope from the
    class at construction and already keys the bucket per user.

    ADR-0604's global kill switch neutralizes these scopes along with every other
    one — it nulls each rate in ``DEFAULT_THROTTLE_RATES``, and a ``None`` rate
    makes ``SimpleRateThrottle.allow_request`` return True immediately.
    """


class LoadSampleThrottle(_SeedImporterThrottle):
    """Caps bundled-sample demo loads per account (#2402)."""

    scope = "sample_load"


class SeedImportThrottle(_SeedImporterThrottle):
    """Caps caller-supplied seed imports per account (#2402).

    Strictly cheaper to abuse than :class:`LoadSampleThrottle`: the payload is
    caller-supplied, so the per-call cost is chosen by the attacker rather than
    fixed by a bundled fixture.
    """

    scope = "seed_import"


class SampleDownloadThrottle(UserRateThrottle):
    """Caps bundled-fixture downloads per account (#2490).

    Deliberately *not* a sibling of :class:`_SeedImporterThrottle`: a download
    streams a file off disk and touches no table, so it belongs in a far more
    generous tier than the teardown-and-rebuild those two guard.

    Subclasses ``UserRateThrottle`` rather than ``ScopedRateThrottle`` for the
    same reason the importer throttles do: attached per-action through
    ``@action(throttle_classes=[…])``, the view carries no ``throttle_scope``
    attribute, and ``ScopedRateThrottle.allow_request`` silently returns True
    when it cannot find one — leaving the endpoint unthrottled while *looking*
    bounded.
    """

    scope = "sample_download"


def _if_none_match_matches(header: str | None, etag: str) -> bool:
    """Return True when an ``If-None-Match`` header covers ``etag`` (#2490).

    Minimal RFC 9110 §13.1.2 handling for the one endpoint that needs it: ``*``
    matches anything, otherwise the comma-separated candidate list is compared
    against our strong tag, tolerating the ``W/`` weak prefix a proxy may add.
    """
    if not header:
        return False
    candidates = [part.strip() for part in header.split(",")]
    if "*" in candidates:
        return True
    return any(candidate.removeprefix("W/") == etag for candidate in candidates)


class SampleCatalogEntrySerializer(serializers.Serializer[Any]):
    """One bundled demo fixture, as advertised by the catalog (#375, #2490).

    Response-only — the catalog is a read of files inside the installed package,
    so nothing here is ever deserialized from a request.

    The nullable fields are the honest ones. ``available`` is False when the
    registry names a file this installation does not have; the counts and
    ``schema_version`` are null when the file is present but could not be parsed.
    Neither case hides the fixture from the listing, because the bytes are what
    an auditor came for and a failed summary is our problem, not theirs.
    """

    key = serializers.CharField(help_text="Registry key, e.g. `atlas-platform-launch`.")
    title = serializers.CharField()
    description = serializers.CharField()
    filename = serializers.CharField(help_text="Name the download is served under.")
    available = serializers.BooleanField(
        help_text="False when the registered fixture is missing from this installation."
    )
    size_bytes = serializers.IntegerField(allow_null=True)
    sha256 = serializers.CharField(
        allow_null=True,
        help_text=(
            "SHA-256 of the exact bytes the download serves, and the value of its "
            "`ETag`. Proves transport integrity — not provenance."
        ),
    )
    schema_version = serializers.CharField(allow_null=True)
    project_count = serializers.IntegerField(allow_null=True)
    task_count = serializers.IntegerField(allow_null=True)
    resource_count = serializers.IntegerField(allow_null=True)
    download_url = serializers.CharField(
        help_text="Server-built download path. Clients link this rather than assembling it."
    )


@dataclass(frozen=True)
class _SeedPayloadProblem:
    """A request-level reason a seed body could not be read at all (#2418).

    Distinguished from a *document* problem, which is what validation reports.
    ``is_document_level`` marks the case the dry run answers with ``200
    {valid: false}`` rather than a 400: unparseable JSON is a fact about the
    file the operator handed us, and telling them so is the entire job of a dry
    run. An oversize upload is a fact about the *request* and stays a 400 on
    both paths — we never read it, so we have nothing to diagnose.
    """

    detail: str
    is_document_level: bool


#: Request-level control fields that ride alongside a seed document but are not
#: part of it (ADR-0726 §1). Declared by ``SeedImportRequestSerializer``.
_SEED_CONTROL_FIELDS = frozenset({"replace", "expected_program_id"})


def _discard_seed_payload(path: str) -> None:
    """Drop a stored seed payload whose import never produced a job row.

    The retention purge reclaims payloads by walking ``ProgramImportJob`` rows,
    so an object written for a request that then refused is invisible to it
    permanently. Best-effort: a storage error here must not turn a clean 409 into
    a 500, and a leaked object is recoverable by an operator while a wrong status
    code is not.
    """
    import logging

    from django.core.files.storage import default_storage

    try:
        default_storage.delete(path)
    except Exception:  # pragma: no cover - storage drift; the 409 still stands
        logging.getLogger(__name__).warning("could not discard orphaned seed payload %s", path)


def _read_seed_json_body(
    request: Request, max_bytes: int, too_large: _SeedPayloadProblem
) -> tuple[Any, _SeedPayloadProblem | None]:
    """Read a seed document from a raw JSON request body.

    This path used to be capped only by DATA_UPLOAD_MAX_MEMORY_SIZE (100 MB), so
    posting the same document as a body instead of a file bypassed
    SEED_MAX_UPLOAD_MB entirely. Gate on the raw bytes: ``request.body`` is the
    undecoded payload, so this measures what actually arrived rather than a
    declared Content-Length that may be absent under chunked transfer-encoding.
    """
    try:
        raw = request.body
    except Exception:
        # Stream already consumed (a multipart request with no ``file`` part
        # reaches here). Fall back to the parsed form data, which is bounded by
        # DATA_UPLOAD_MAX_MEMORY_SIZE and carries no document.
        raw = None

    if raw is None:
        data = request.data
    else:
        if len(raw) > max_bytes:
            return None, too_large
        try:
            data = json.loads(raw.decode("utf-8")) if raw else request.data
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            return None, _SeedPayloadProblem(
                detail=f"Request body is not valid JSON: {exc}",
                is_document_level=True,
            )

    if hasattr(data, "items"):
        # On the multipart path the control fields sit beside ``file`` and never
        # touch the document. On the JSON-body path there is only one object, so
        # they arrive *inside* it — and the seed schema is
        # ``additionalProperties: false``, which would reject the whole document
        # with "'replace' was unexpected". Strip them here so both request shapes
        # present the same document to the validator.
        return {k: v for k, v in data.items() if k not in _SEED_CONTROL_FIELDS}, None
    return data, None


def _read_seed_multipart(
    request: Request, max_bytes: int, too_large: _SeedPayloadProblem
) -> tuple[Any, _SeedPayloadProblem | None]:
    """Read a seed document from the multipart ``file`` part."""
    upload = request.FILES.get("file")
    if upload is None:
        return request.data, None

    # Bound the in-memory parse: an authenticated user must not be able
    # to exhaust memory with a giant upload (mirrors the MSP importer).
    if upload.size is not None and upload.size > max_bytes:
        return None, too_large
    try:
        return json.loads(upload.read().decode("utf-8")), None
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return None, _SeedPayloadProblem(
            detail=f"Uploaded file is not valid JSON: {exc}",
            is_document_level=True,
        )


def _read_seed_payload(request: Request) -> tuple[Any, _SeedPayloadProblem | None]:
    """Read a seed document from a multipart ``file`` or a raw JSON body.

    Shared by the real import and the dry run so the two cannot drift on the
    upload ceiling or the accepted request shapes — a dry run whose parse rules
    differ from the import's would answer a question nobody asked.
    """
    from django.conf import settings

    max_bytes = settings.SEED_MAX_UPLOAD_MB * 1024 * 1024
    too_large = _SeedPayloadProblem(
        detail=f"Seed file too large. Maximum: {settings.SEED_MAX_UPLOAD_MB} MB.",
        is_document_level=False,
    )

    # Branch on the declared content type, NOT on ``request.FILES``. Reading
    # ``FILES`` on a DRF Request calls ``_load_data_and_files()``, which runs the
    # parser — so probing it first would perform the very JSON parse this
    # function exists to bound, and any size check after it could only change the
    # response, never the memory cost.
    if not (request.content_type or "").startswith("multipart/"):
        return _read_seed_json_body(request, max_bytes, too_large)
    return _read_seed_multipart(request, max_bytes, too_large)


class SeedValidateThrottle(UserRateThrottle):
    """Caps seed dry runs per account (#2418).

    Deliberately *not* a :class:`_SeedImporterThrottle` subclass: the dry run
    never reaches the importer, so it carries none of the teardown-and-rebuild
    cost that bucket exists to bound. It still needs a bound of its own —
    JSON-Schema validation is CPU proportional to a caller-sized document — but
    a looser one, and in a separate bucket so iterating on a file until it
    validates cannot exhaust the allowance for importing the file that finally
    passes.
    """

    scope = "seed_validate"


def _seed_replace_conflict(*, allow_null: bool = False) -> Any:
    """A fresh schema for "the program a confirmed re-import would tear down".

    A factory rather than a module constant because the same shape is nested
    inside two different response envelopes (the ``409`` refusal and the dry
    run's ``replaces`` key), and a DRF serializer instance binds to one parent —
    sharing a single instance across both would be a latent binding bug.

    The counts are the substance of it: a program *name* is not enough
    information to consent to destroying 812 tasks (ADR-0726 §1).

    ``allow_null`` differs per envelope and must not be hoisted into the shared
    shape: a ``409`` refusal always names the conflict that caused it, while the
    dry run reports ``null`` whenever nothing collides — which is its ordinary
    answer, not an edge case (#2649).
    """
    return inline_serializer(
        "SeedReplaceConflict",
        {
            "program_id": serializers.UUIDField(),
            "name": serializers.CharField(),
            "code": serializers.CharField(),
            "project_count": serializers.IntegerField(),
            "task_count": serializers.IntegerField(),
        },
        allow_null=allow_null,
    )


SEED_REPLACE_CONFLICT_RESPONSE = inline_serializer(
    "SeedReplaceConflictResponse",
    {
        "detail": serializers.CharField(),
        "code": serializers.CharField(),
        "conflict": _seed_replace_conflict(),
    },
)

# The ``202`` envelope (ADR-0726 §6). ``program_id`` exists the moment this
# returns — the shell is created inside the request — so a client can navigate
# straight to it while the subtree is still building.
SEED_IMPORT_QUEUED_RESPONSE = inline_serializer(
    "SeedImportQueuedResponse",
    {
        "queued": serializers.BooleanField(),
        "program_id": serializers.UUIDField(),
        "import_request_id": serializers.UUIDField(),
        "replaced_program_id": serializers.UUIDField(allow_null=True),
    },
)


# Response envelope for the seed dry run (#2418).
#
# ``valid`` is the answer; ``errors`` is the complete JSON-path-anchored
# diagnostic list (empty when valid). The remaining fields echo what the
# *document claims to be*, so an operator can confirm they grabbed the right
# file before pointing a wipe-then-recreate import (ADR-0109) at a live program
# slug — they are read defensively and may be ``null`` on a document too
# malformed to state them.
#
# Declared via ``inline_serializer`` rather than a Serializer subclass because
# the envelope's ``errors`` key would shadow ``Serializer.errors``, the base
# property DRF uses to report validation failures. This serializer only ever
# describes a response shape — it is never instantiated to validate input — but
# a field named after a base-class property is a trap for whoever tries later.
SEED_VALIDATE_RESPONSE = inline_serializer(
    "SeedValidateResponse",
    {
        "valid": serializers.BooleanField(),
        "errors": serializers.ListField(child=serializers.CharField()),
        "schema_version": serializers.CharField(allow_null=True),
        "program_slug": serializers.CharField(allow_null=True),
        "program_name": serializers.CharField(allow_null=True),
        "project_count": serializers.IntegerField(),
        "task_count": serializers.IntegerField(),
        "resource_count": serializers.IntegerField(),
        # ADR-0726 §7: what importing this document would tear down, or null.
        # Computed at the view layer, never inside ``inspect_seed`` — that
        # function is pure and lives in a module that never imports the ORM, and
        # the dry run's "persists nothing" guarantee is structural because of it.
        #
        # Nullable, and that is the common case (#2649): ``preview_replacement``
        # answers ``None`` for a free slug, a slug owned by someone else, and any
        # document too malformed to state one — so a client must treat the key as
        # present-but-null, never as proof of a collision.
        "replaces": _seed_replace_conflict(allow_null=True),
    },
)


class LoadSampleResponseSerializer(serializers.Serializer[Any]):
    """Response envelope for the load-sample action (#1054).

    ``landing_project_id`` is the project whose first open sprint was assigned to
    the caller — the board a contributor should land on so their assigned work is
    immediately visible; ``null`` when the sample has no open sprint (e.g. the
    waterfall-only sample), in which case the client falls back to the program
    overview. ``sample_key`` echoes the loaded sample so the client renders the
    matching "Start exploring" guidance without having to guess the default.
    """

    program = ProgramSerializer()
    landing_project_id = serializers.UUIDField(allow_null=True)
    sample_key = serializers.CharField()


class ProgramViewSet(McpReadableViewMixin, IdempotencyMixin, viewsets.ModelViewSet[Program]):
    """CRUD for programs.

    URL: ``/api/v1/programs/``

    Permission matrix (ADR-0070 §RBAC):
      list      — IsAuthenticated; queryset filtered to programs the caller is a member of
      retrieve  — IsProgramMember (Viewer+)
      create    — IsAuthenticated; caller auto-becomes OWNER via ``create_program``
      update    — IsProgramAdmin
      destroy   — IsProgramOwner; cascade-removes memberships in one transaction
    """

    # ADR-0678 (#2482): Program rows are filtered on the program's own denial, but
    # five detail actions read CHILD PROJECT data — schedule, rollup, projects,
    # task_search, resource_contention — which the row filter cannot reach. Each
    # scopes explicitly; see ADR-0678 threat-model finding T1.
    mcp_scope = McpScope.AGGREGATE

    serializer_class = ProgramSerializer
    pagination_class = DirectoryPagination
    # Parity with ProjectViewSet: name/code substring search so the program
    # switchers and command palette stay findable past the default page (ADR-0401).
    filter_backends = [filters.SearchFilter, filters.OrderingFilter]
    search_fields = ["name", "code"]
    ordering_fields = ["name"]

    def get_permissions(self) -> list[BasePermission]:
        # ADR-0186 §E: append the read-only MCP token guards around the
        # action-specific RBAC list so a mcp:read token is confined to safe
        # methods on every action (no write-branch leak); human auth passes both.
        return [*self._rbac_permissions(), *self.mcp_token_guards()]

    def _rbac_permissions(self) -> list[BasePermission]:
        if self.action in ("update", "partial_update"):
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        if self.action == "bulk_fields":
            # Workspace → programs matrix (ADR-0161): org-level workspace-admin authority.
            # Program has no workspace FK — the workspace is the singleton — so this is the
            # org-wide admin gate, not a per-program one.
            return [IsAuthenticated(), IsWorkspaceAdmin()]
        if self.action == "bulk_project_fields":
            # Program → projects matrix (ADR-0161): program-admin authority over the
            # program's own projects. The program PK in the URL is the IDOR boundary;
            # closed programs are not bulk-editable.
            return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
        if self.action in (
            "destroy",
            "close",
            "reopen",
            "transfer_sponsorship",
            "split",
            "remove_sample",
        ):
            # Lifecycle actions bypass the IsProgramNotClosed gate via the
            # class's _CLOSE_BYPASS_ACTIONS set — otherwise an Owner could
            # never reopen or delete a closed program.
            return [IsAuthenticated(), IsProgramOwner(), IsProgramNotClosed()]
        if self.action in ("rollup_config", "risk_policy"):
            # Method-level split: GET is read-open to any program member
            # (closed programs remain readable for audit/forensics); PATCH
            # requires admin and is blocked on closed programs. DRF evaluates
            # permissions before dispatch, so the discriminator is the HTTP
            # method on the request.
            if self.request.method == "PATCH":
                return [IsAuthenticated(), IsProgramAdmin(), IsProgramNotClosed()]
            return [IsAuthenticated(), IsProgramMember()]
        if self.action in ("rollup", "schedule"):
            # Computed overview rollup / merged program schedule — read-only. Open
            # to any program member, including on closed programs (overview and the
            # cross-project schedule stay available for forensics/archival).
            # Per-project task redaction inside the schedule payload (ADR-0120 D5)
            # is enforced in the action body, not here — a program member who cannot
            # read a member project still reaches the endpoint but sees only that
            # project's ExternalTaskCards.
            return [IsAuthenticated(), IsProgramMember()]
        if self.action == "export":
            # Program seed export — Admin+ for BOTH the GET sync JSON seed and the
            # POST async .tar.gz bundle (#1957, mirroring the project-side gate).
            # The seed dumps team-private data raw across every member project
            # (story points, committed/completed/capacity velocity, per-member
            # effort) with no ADR-0104 field-gating (deferred to 0.5, #1959), so a
            # Viewer/Member reaching it is a bulk ADR-0104 bypass. Bulk export at
            # program grain is a program-admin action. Stays available on closed
            # programs (portability for archival/forensics).
            return [IsAuthenticated(), IsProgramAdmin()]
        if self.action in ("export_jobs", "export_job_detail", "export_job_download"):
            # Async program export bundle list / poll / download (#1958, ADR-0219):
            # Admin+, matching the POST enqueue. Available on closed programs;
            # object-level cross-program IDOR (a job_id from another program) is
            # closed in the action bodies via program-scoped lookups.
            return [IsAuthenticated(), IsProgramAdmin()]
        if self.action == "import_job_detail":
            # Poll one seed import job (ADR-0726). Admin+, matching the export
            # job poll: the summary reports the program's entity counts, and the
            # error detail can echo validation diagnostics naming projects and
            # tasks the caller must already be entitled to see. The importing
            # caller is the program's OWNER by construction, so this never locks
            # anyone out of a job they started. Object-level cross-program IDOR is
            # closed in the action body via the program-scoped lookup.
            return [IsAuthenticated(), IsProgramAdmin()]
        if self.action == "mention_reach":
            # Who @program-stakeholders actually reaches (ADR-0697). Admin+, matching
            # the external-stakeholder registry's own floor (ADR-0264 §3) — the strip
            # this backs only ever renders beside a list the caller can already read,
            # so a lower floor buys nothing, and the internal arm is a partial
            # disclosure of membership across projects the caller may hold no grant
            # on (ADR-0070's explicit-grants boundary). No IsProgramNotClosed: it is
            # a read, and a closed program's alias stays inspectable for forensics.
            return [IsAuthenticated(), IsProgramAdmin()]
        if self.action == "resource_contention":
            # Resource allocation/contention data is Scheduler+ even on read
            # (web-rule 94, matching the per-project resource-allocation gate);
            # a Viewer or Member must not see who is staffed where.
            return [IsAuthenticated(), IsProgramScheduler()]
        if self.action in ("retrieve", "projects", "integrations_summary", "task_search"):
            # ``task_search`` backs the cross-project dependency picker (ADR-0120
            # D5): a create-assist read, gated exactly like ``projects`` — any
            # program member. ``IsProgramNotClosed`` is a no-op for the GET (it
            # only blocks writes) but is kept for parity with this read group; a
            # closed program is still browsable. The real authorization is the
            # per-project readability narrowing inside the action body (only
            # projects the caller can read are searched), which enforces the D5
            # "creator needs read access to both tasks" rule — the edge itself is
            # created later via the per-project ``/dependencies/`` POST, not here.
            return [IsAuthenticated(), IsProgramMember(), IsProgramNotClosed()]
        return [IsAuthenticated()]

    def perform_update(self, serializer: serializers.BaseSerializer[Program]) -> None:
        # ADR-0441: reassigning a program's working calendar (a different default, or
        # cleared to inherit the workspace) re-points every member project that sets no
        # calendar of its own, so capture the before-value and fan out a CPM recompute
        # to the inheriting projects only when ``calendar`` actually changes. Other
        # program-field edits (name, methodology, sharing, …) never touch scheduling.
        old_calendar_id = serializer.instance.calendar_id if serializer.instance else None
        instance = serializer.save()
        if instance.calendar_id != old_calendar_id:
            from trueppm_api.apps.projects.views import _recalc_projects_for_program_calendar

            _recalc_projects_for_program_calendar(instance.pk)

    def get_queryset(self) -> QuerySet[Program]:
        """Programs visible to the current user (those they have membership on).

        Annotates ``_my_role`` (caller's role on each program), ``project_count``,
        and ``member_count`` so the serializer can render the role chip and
        counts without N+1 queries.
        """
        user = self.request.user
        if not (user and user.is_authenticated):
            return Program.objects.none()

        my_role_sq = ProgramMembership.objects.filter(
            program=OuterRef("pk"),
            user=user,
            is_deleted=False,
        ).values("role")[:1]

        qs = (
            Program.objects.filter(
                is_deleted=False,
                memberships__user=user,
                memberships__is_deleted=False,
            )
            # select_related on ``lead`` so ProgramSerializer.lead_detail does not
            # incur one extra User query per program on list responses (#523).
            # select_related ``calendar`` + prefetch its exceptions so
            # ProgramSerializer.effective_calendar (ADR-0441, with holiday_count) does
            # not N+1 the program list. The workspace-tier calendar is the shared
            # singleton, resolved once via the serializer's ``_sharing_workspace`` cache.
            .select_related("lead", "calendar")
            .prefetch_related("calendar__exceptions")
            .annotate(
                _my_role=Subquery(my_role_sq),
                project_count=Count(
                    "projects",
                    distinct=True,
                    filter=Q(projects__is_deleted=False),
                ),
                member_count=Count(
                    "memberships",
                    distinct=True,
                    filter=Q(memberships__is_deleted=False),
                ),
                _is_sample=Exists(
                    Project.objects.filter(program=OuterRef("pk"), is_sample=True, is_deleted=False)
                ),
            )
            .order_by("name")
        )
        # `is_pinned` for THIS caller (#2390, ADR-0627). Bound positionally to
        # `user`, so it can answer "did I pin it" and never "who pinned it".
        return annotate_is_pinned(qs, user, field="program")

    # -----------------------------------------------------------------------
    # CRUD
    # -----------------------------------------------------------------------

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        # Pass serializer context so ``validate_lead`` can read ``request.user``:
        # on create the only member-to-be is the creator, so a lead supplied at
        # create must equal the creator (#2025).
        write = ProgramSerializer(data=request.data, context=self.get_serializer_context())
        write.is_valid(raise_exception=True)

        # Service-layer call wraps the Program + OWNER membership in a single
        # transaction — see ADR-0070 §Durable Execution.
        program = create_program(
            name=write.validated_data["name"],
            description=write.validated_data.get("description", ""),
            methodology=write.validated_data.get("methodology", Methodology.HYBRID),
            created_by=request.user,
            lead=write.validated_data.get("lead"),
        )

        # Re-fetch through the get_queryset so the response includes my_role
        # and the count annotations.
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_201_CREATED)

    @extend_schema(
        summary="Dry-run: validate a JSON seed bundle without importing it",
        description=(
            "Runs the full seed validator — JSON-Schema conformance, referential "
            "integrity, node budgets, three-point estimate ordering — and returns "
            "every diagnostic it finds. **Persists nothing.**\n\n"
            'A document that fails validation is `200 {"valid": false}`, not a '
            "`400`: the request succeeded, the *document* is what failed, and the "
            "caller needs the diagnostics either way. A `400` here means the "
            "request itself was unusable (upload over the size ceiling).\n\n"
            "Same authorization as `POST /programs/import/` — a dry run parses an "
            "untrusted document and is not a lighter-privilege surface."
        ),
        responses={200: SEED_VALIDATE_RESPONSE},
    )
    @action(
        detail=False,
        methods=["post"],
        url_path="import/validate",
        throttle_classes=[SeedValidateThrottle],
    )
    def validate_import(self, request: Request) -> Response:
        """Validate a seed document and report every problem, importing nothing.

        The CSV importer has had a preview endpoint since #743; the JSON seed
        has had an equally good validator with no way to run it. That asymmetry
        matters because ``import_seed`` is wipe-then-recreate on the program
        slug (ADR-0109) — an operator pointing it at a live slug could not
        answer *"will this file be accepted?"* without committing to the
        destructive operation first (#2418).

        Persisting nothing is the contract, and it is structural rather than
        merely intended: this calls ``inspect_seed``, a pure function in a
        module that never imports the ORM, and never reaches the importer.

        Permission parity with ``import_seed`` is deliberate — both fall through
        to the ``get_permissions`` ``IsAuthenticated`` default. A dry run parses
        the same untrusted document under the same authorization; the only thing
        it withholds is the write.
        """
        from trueppm_api.apps.projects.seed import SeedReport, inspect_seed
        from trueppm_api.apps.projects.seed.replace import preview_replacement

        payload, problem = _read_seed_payload(request)
        if problem is not None and not problem.is_document_level:
            return Response({"detail": problem.detail}, status=status.HTTP_400_BAD_REQUEST)
        if problem is not None:
            report = SeedReport(
                valid=False,
                errors=[f"$: {problem.detail}"],
                schema_version=None,
                program_slug=None,
                program_name=None,
                project_count=0,
                task_count=0,
                resource_count=0,
            )
        else:
            report = inspect_seed(payload)

        # The destructive half of the answer (ADR-0726 §7). A dry run that says
        # "valid" while withholding "and it will move 3 projects to Trash" is
        # answering the less important question.
        body = asdict(report)
        body["replaces"] = preview_replacement(request.user, payload)
        return Response(body, status=status.HTTP_200_OK)

    def _seed_replace_refusal(
        self,
        user: Any,
        slug: str,
        *,
        replace: bool,
        expected_program_id: Any,
        candidates: list[Any] | None = None,
    ) -> Response | None:
        """The three ``409`` refusals, or ``None`` when the import may proceed.

        Shared between the unlocked pre-check (which decides the refusal before a
        payload is stored, so the ordinary confirm round-trip leaks nothing) and
        the locked re-check inside the transaction (which is authoritative and
        catches a collision created in between). Both must answer identically, so
        they call one function rather than two copies of the same three branches.
        """
        from trueppm_api.apps.projects.seed.replace import (
            describe_conflict,
            resolve_replace_candidates,
        )

        if candidates is None:
            candidates = resolve_replace_candidates(user, slug)
        if not candidates:
            return None

        if expected_program_id is not None:
            named = [p for p in candidates if str(p.pk) == str(expected_program_id)]
            if not named:
                return Response(
                    {
                        "detail": (
                            "expected_program_id does not name the program that would "
                            "be replaced — it may have changed since you checked."
                        ),
                        "code": "seed_replace_mismatch",
                        "conflict": describe_conflict(candidates[0]).as_dict(),
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            candidates = named

        if not replace:
            return Response(
                {
                    "detail": (
                        f'A program you own already uses the code "{slug}". Re-importing '
                        "moves its projects to Trash, where each can be restored "
                        "individually as a standalone project; the program itself is not "
                        "recoverable. Confirm to continue."
                    ),
                    "code": "seed_replace_required",
                    "conflict": describe_conflict(candidates[0]).as_dict(),
                },
                status=status.HTTP_409_CONFLICT,
            )

        if len(candidates) > 1:
            # ``Program.code`` is non-unique by design, so one caller can
            # legitimately own two programs sharing this slug. A single
            # ``conflict`` object can name only one of them, so a bare
            # ``replace=true`` would destroy a program the caller was never shown,
            # never counted, and that no audit field records — exactly what
            # ``expected_program_id`` exists to prevent.
            return Response(
                {
                    "detail": (
                        f"You own {len(candidates)} live programs using the code "
                        f'"{slug}". Re-send with expected_program_id to name the one '
                        "to replace."
                    ),
                    "code": "seed_replace_ambiguous",
                    "conflicts": [describe_conflict(p).as_dict() for p in candidates],
                },
                status=status.HTTP_409_CONFLICT,
            )

        return None

    @extend_schema(
        summary="Queue a JSON seed bundle as a new program",
        request=SeedImportRequestSerializer,
        responses={
            202: OpenApiResponse(
                response=SEED_IMPORT_QUEUED_RESPONSE,
                description=(
                    "Import queued (ADR-0726). The program shell exists at "
                    "`program_id` immediately; its projects and tasks are built in "
                    "the background. Poll GET /programs/{program_id}/import/jobs/"
                    "{import_request_id}/ until `status` is 'success' or 'failed'."
                ),
            ),
            400: OpenApiResponse(
                description="Unreadable request, or a document that fails validation."
            ),
            409: OpenApiResponse(
                response=SEED_REPLACE_CONFLICT_RESPONSE,
                description=(
                    "A live program you own already holds this seed's slug. Re-send "
                    "with `replace=true` to confirm; optionally pin the target with "
                    "`expected_program_id`. The replaced program's projects move to "
                    "Trash individually as standalone projects; the program shell "
                    "itself is not recoverable. `code` is `seed_replace_required`, "
                    "`seed_replace_mismatch`, or `seed_replace_ambiguous`."
                ),
            ),
        },
    )
    @action(
        detail=False,
        methods=["post"],
        url_path="import",
        throttle_classes=[SeedImportThrottle],
    )
    def import_seed(self, request: Request) -> Response:
        """Queue a JSON seed import, returning ``202`` with the program and job ids.

        Accepts either a ``file`` multipart upload or a raw JSON body. The caller
        becomes the program OWNER (same authorization as ``create`` — any
        authenticated user may create a program). ``create_users`` is forced off:
        importing a seed on a live instance must never mint arbitrary logins.

        **The split (ADR-0726 §4).** Validation, the replace decision, the
        replacement itself, and the program shell all happen *here*, inside the
        request; only the O(n) subtree build is queued. Two reasons, both
        deliberate: a destructive act belongs in the request the operator
        authorized rather than behind a queue, and resolving the collision here
        closes the TOCTOU window between "nothing collides" and a worker deleting
        something. What is left to the worker is purely additive, which is why a
        100k-entity document no longer 504s mid-transaction (#2574).

        **Replacement requires consent (#2581).** A live program of the caller's
        whose ``code`` matches this seed's slug is refused with ``409`` unless
        ``replace=true`` is sent. Confirmed, its projects are **soft**-deleted —
        they land in project Trash individually, as standalone projects, and
        offline clients receive tombstones. The program shell itself is not
        recoverable; there is no program Trash (#2587).

        Rate-limited to the ``seed_import`` scope (:class:`SeedImportThrottle`).
        The bucket now bounds *job creation* rather than request CPU, which is
        the correct unit once the build is async — paired with the per-program
        in-flight de-dupe in ``enqueue_program_import``, that is what keeps this
        from trading a CPU exhaustion vector for a queue backlog.

        Permission parity (#1957): import stays ``IsAuthenticated`` (via the
        get_permissions default) deliberately, because program ``create`` is
        likewise ``IsAuthenticated``. The *replace* is separately scoped to
        programs the caller owns outright (#994), so the looser gate on create
        never widens what a seed can destroy.
        """
        import json as _json

        from trueppm_api.apps.access.services import create_program
        from trueppm_api.apps.projects.seed import SeedValidationError, validate_seed
        from trueppm_api.apps.projects.seed.replace import (
            describe_conflict,
            resolve_replace_candidates,
        )
        from trueppm_api.apps.projects.services import (
            enqueue_program_import,
            soft_delete_program_subtree,
            store_seed_payload,
        )

        payload, problem = _read_seed_payload(request)
        if problem is not None:
            return Response({"detail": problem.detail}, status=status.HTTP_400_BAD_REQUEST)

        options = SeedImportRequestSerializer(data=request.data)
        options.is_valid(raise_exception=True)
        replace = bool(options.validated_data.get("replace"))
        expected_program_id = options.validated_data.get("expected_program_id")

        try:
            validate_seed(payload)
        except SeedValidationError as exc:
            # Standardized on the `detail` envelope (#1325). For the line-level
            # import report `detail` is the *list* of validation messages (the FE
            # renders them as discrete items); the single-message errors above use
            # a plain string. seedImportErrors() normalizes both to a string list.
            return Response({"detail": exc.errors}, status=status.HTTP_400_BAD_REQUEST)

        seed_program = payload["program"]
        slug = seed_program["slug"]

        # Decide the refusals BEFORE storing anything. The 409 is the *designed*
        # default path for a re-import — POST, confirm, POST — so storing the
        # payload first would leak one full copy of every ordinary re-import into
        # object storage, referenced by no job row and therefore invisible to the
        # row-driven retention purge forever.
        #
        # This first pass is deliberately unlocked: it only decides whether to
        # answer 409. The authoritative resolve happens under
        # ``select_for_update`` inside the transaction below, and re-runs the same
        # guards, so a collision that appears in between is still caught.
        refusal = self._seed_replace_refusal(
            request.user, slug, replace=replace, expected_program_id=expected_program_id
        )
        if refusal is not None:
            return refusal

        # Past the refusals: persist the payload OUTSIDE the transaction. On an
        # S3-backed deployment this is a multi-megabyte network PUT, and the block
        # below holds SELECT FOR UPDATE on the replaced program and every one of
        # its projects until commit.
        upload = request.FILES.get("file")
        payload_path = store_seed_payload(_json.dumps(payload).encode("utf-8"))

        with transaction.atomic():
            candidates = resolve_replace_candidates(request.user, slug, lock=True)
            replaced_program_id = None
            if candidates:
                # ``expected_program_id`` narrows the teardown to the one program
                # the caller named. Without this the set the caller consented to
                # and the set actually destroyed could differ — see the ambiguity
                # refusal below.
                if expected_program_id is not None:
                    named = [p for p in candidates if str(p.pk) == str(expected_program_id)]
                    if not named:
                        _discard_seed_payload(payload_path)
                        return Response(
                            {
                                "detail": (
                                    "expected_program_id does not name the program that "
                                    "would be replaced — it may have changed since you "
                                    "checked."
                                ),
                                "code": "seed_replace_mismatch",
                                "conflict": describe_conflict(candidates[0]).as_dict(),
                            },
                            status=status.HTTP_409_CONFLICT,
                        )
                    candidates = named

                if not replace or len(candidates) > 1:
                    # A collision that only appeared between the unlocked
                    # pre-check and this locked resolve. Rare (it needs a
                    # concurrent create), so the orphaned payload is cleaned up
                    # here rather than restructured around.
                    _discard_seed_payload(payload_path)
                    return self._seed_replace_refusal(
                        request.user,
                        slug,
                        replace=replace,
                        expected_program_id=expected_program_id,
                        candidates=candidates,
                    ) or Response(
                        {"detail": "The replace could not be confirmed. Try again."},
                        status=status.HTTP_409_CONFLICT,
                    )

                replaced_program_id = candidates[0].pk
                soft_delete_program_subtree(
                    candidates[0], actor=request.user, reason="seed_replace"
                )

            program = create_program(
                name=seed_program["name"],
                description=seed_program.get("description", ""),
                methodology=seed_program["methodology"],
                created_by=request.user,
            )
            program.code = slug
            program.save(update_fields=["code"])

            job = enqueue_program_import(
                program=program,
                requested_by=request.user,
                payload_path=payload_path,
                filename=getattr(upload, "name", "") or "",
                replace=replace,
                replaced_program_id=replaced_program_id,
            )

        program_id = str(program.pk)
        return Response(
            {
                "queued": True,
                "program_id": program_id,
                "import_request_id": str(job.pk),
                "replaced_program_id": (str(replaced_program_id) if replaced_program_id else None),
            },
            status=status.HTTP_202_ACCEPTED,
        )

    @extend_schema(
        summary="Poll one async program seed import job's status",
        responses={200: ProgramImportJobSerializer},
    )
    @action(
        detail=True,
        methods=["get"],
        url_path=r"import/jobs/(?P<job_id>[0-9a-f-]{36})",
    )
    def import_job_detail(
        self, request: Request, pk: str | None = None, job_id: str | None = None
    ) -> Response:
        """Poll an async seed import job (ADR-0726, #2574).

        The mirror of ``export_job_detail``, and scoped the same way: the job is
        looked up against the resolved (membership-checked) program, so a
        ``job_id`` belonging to another program 404s rather than leaking
        (object-level IDOR guard).
        """
        program = self.get_object()
        # The URL regex admits 36-char strings that are not UUIDs (36 dashes,
        # say). Passing one to a UUID pk filter raises Django's ValidationError,
        # which DRF does not map — a 500 where the caller should simply get a 404.
        try:
            parsed_job_id = uuid.UUID(str(job_id))
        except (TypeError, ValueError) as exc:
            raise Http404("Import job not found") from exc
        job = ProgramImportJob.objects.filter(program=program, pk=parsed_job_id).first()
        if job is None:
            raise Http404("Import job not found")
        return Response(ProgramImportJobSerializer(job).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Pin or unpin this program for the requesting user",
        description=PIN_ENDPOINT_DESCRIPTION,
        request=None,
        responses={
            200: PROGRAM_PIN_RESPONSE,
            204: None,
            400: OpenApiResponse(
                response=PIN_LIMIT_RESPONSE,
                description="Pin limit reached (`code: pin_limit_reached`).",
            ),
        },
    )
    @action(detail=True, methods=["post", "delete"], url_path="pin")
    def pin(self, request: Request, pk: str | None = None) -> Response:
        """Pin (POST) or unpin (DELETE) this program for the current user (#2390).

        Any member who can read the program may pin it — a pin grants nothing
        and reveals nothing. Scoped to ``request.user``; see ADR-0627 §D5.
        """
        from trueppm_api.apps.profiles.services import PinLimitReached, set_pin

        program = self.get_object()
        if request.method == "DELETE":
            set_pin(request.user, program=program, pinned=False)
            return Response(status=status.HTTP_204_NO_CONTENT)
        try:
            set_pin(request.user, program=program, pinned=True)
        except PinLimitReached as exc:
            return Response(
                {"detail": pin_limit_detail(exc.limit), "code": "pin_limit_reached"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response({"is_pinned": True}, status=status.HTTP_200_OK)

    @extend_schema(
        methods=["GET"],
        summary="Export the program as a downloadable JSON seed file",
        responses={
            200: OpenApiResponse(
                # The GET path serves the canonical seed as an application/json
                # object (attachment), so declare OBJECT — matching the sibling
                # project export. BINARY declared a string/binary body that the
                # real JSON response violates under response_schema_conformance
                # (#2213).
                response=OpenApiTypes.OBJECT,
                description=(
                    "A downloadable canonical JSON seed document describing this program "
                    "and its member projects, delivered as a file attachment. Round-trips "
                    "back through the importer."
                ),
            )
        },
    )
    @extend_schema(
        methods=["POST"],
        summary="Queue a richer asynchronous program export bundle",
        request=None,
        responses={
            202: OpenApiResponse(
                response=ProgramExportJobSerializer,
                description=(
                    "An async program export job (ADR-0219, #1958). The job builds a "
                    ".tar.gz containing the canonical JSON seed plus, per member project, "
                    "MS Project XML, task attachments, time entries, and the audit/change "
                    "history. Poll GET .../export/jobs/{job_id}/ until status is 'success', "
                    "then fetch download_url. Admin+ only; an in-flight job is returned "
                    "rather than queuing a duplicate build."
                ),
            ),
        },
    )
    @action(detail=True, methods=["get", "post"], url_path="export")
    def export(self, request: Request, pk: str | None = None) -> HttpResponse:
        """GET: synchronous JSON seed (#616). POST: queue the async bundle (#1958).

        Both paths are Admin+ (#1957, see get_permissions). The GET path returns the
        canonical JSON seed as a synchronous attachment; the POST path (ADR-0219)
        enqueues the richer async ``.tar.gz`` bundle across every member project and
        returns ``202`` with the job row.
        """
        program = self.get_object()

        if request.method == "POST":
            from trueppm_api.apps.projects.services import enqueue_program_export

            job = enqueue_program_export(program=program, requested_by=request.user)
            return Response(ProgramExportJobSerializer(job).data, status=status.HTTP_202_ACCEPTED)

        from trueppm_api.apps.projects.seed.exporter import dump_seed, export_program

        body = dump_seed(export_program(program))
        filename = f"{program.code or program.pk}.json"
        response = HttpResponse(body, content_type="application/json")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response

    @extend_schema(
        summary="List this program's async export jobs",
        responses={200: ProgramExportJobSerializer(many=True)},
    )
    @action(detail=True, methods=["get"], url_path="export/jobs")
    def export_jobs(self, request: Request, pk: str | None = None) -> Response:
        """List recent async export jobs for this program (#1958, ADR-0219). Admin+.

        Page-number envelope so an integrator can tell a truncated list from a
        complete one. Scoped to the resolved (membership-checked) program, so no
        cross-program rows leak.
        """
        program = self.get_object()
        jobs = ProgramExportJob.objects.filter(program=program)
        paginator = pagination.PageNumberPagination()
        page = paginator.paginate_queryset(jobs, request, view=self)
        data = ProgramExportJobSerializer(page if page is not None else jobs, many=True).data
        return paginator.get_paginated_response(data)

    @extend_schema(
        summary="Poll one async program export job's status",
        responses={200: ProgramExportJobSerializer},
    )
    @action(
        detail=True,
        methods=["get"],
        url_path=r"export/jobs/(?P<job_id>[0-9a-f-]{36})",
    )
    def export_job_detail(
        self, request: Request, pk: str | None = None, job_id: str | None = None
    ) -> Response:
        """Poll an async program export job (#1958, ADR-0219). Admin+.

        The job is looked up scoped to the resolved program, so a ``job_id``
        belonging to another program 404s rather than leaking (object-level IDOR
        guard).
        """
        program = self.get_object()
        job = get_object_or_404(ProgramExportJob, pk=job_id, program=program)
        return Response(ProgramExportJobSerializer(job).data)

    @extend_schema(
        summary="Download a completed async program export bundle",
        responses={
            (200, "application/gzip"): OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description="The program export .tar.gz as a file attachment.",
            ),
            409: OpenApiResponse(
                response=OpenApiTypes.OBJECT, description="Export is not ready yet."
            ),
            410: OpenApiResponse(
                response=OpenApiTypes.OBJECT, description="Download link has expired."
            ),
        },
    )
    @action(
        detail=True,
        methods=["get"],
        url_path=r"export/jobs/(?P<job_id>[0-9a-f-]{36})/download",
    )
    def export_job_download(
        self, request: Request, pk: str | None = None, job_id: str | None = None
    ) -> Any:
        """Stream a completed program export bundle (#1958, ADR-0219). Admin+.

        Authenticated — the archive contains the whole program including its audit
        history, so it is never served from a raw, unauthenticated storage URL.
        ``409`` if not ready, ``410 Gone`` once the link has expired. The job is
        program-scoped so a ``job_id`` from another program 404s (IDOR guard).
        """
        from django.core.files.storage import default_storage

        program = self.get_object()
        job = get_object_or_404(ProgramExportJob, pk=job_id, program=program)
        if job.status != ExportJobStatus.SUCCESS or not job.file_path:
            return Response({"detail": "Export is not ready yet."}, status=status.HTTP_409_CONFLICT)
        if job.expires_at is not None and job.expires_at < timezone.now():
            return Response(
                {"detail": "This export has expired. Request a new one."},
                status=status.HTTP_410_GONE,
            )
        try:
            handle = default_storage.open(job.file_path, "rb")
        except (FileNotFoundError, OSError) as exc:
            raise Http404("Export archive is no longer available.") from exc
        return FileResponse(
            handle,
            as_attachment=True,
            filename=f"program-{program.code or program.pk}.tar.gz",
            content_type="application/gzip",
        )

    @extend_schema(
        summary="Within-program resource contention (cross-project allocation)",
        parameters=[
            OpenApiParameter(
                name="start",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window start (ISO 8601 `YYYY-MM-DD`). Defaults to the earliest task "
                    "SPAN start (`scheduled_start`, ADR-0752, falling back to "
                    "`early_start`) across all member projects."
                ),
            ),
            OpenApiParameter(
                name="end",
                type=OpenApiTypes.DATE,
                location=OpenApiParameter.QUERY,
                required=False,
                description=(
                    "Window end (ISO 8601 `YYYY-MM-DD`). Defaults to the latest "
                    "`early_finish` across all member projects."
                ),
            ),
            OpenApiParameter(
                name="resource",
                type=OpenApiTypes.UUID,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Repeatable. Filter to specific resource IDs.",
            ),
            OpenApiParameter(
                name="status",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.QUERY,
                required=False,
                many=True,
                description="Repeatable. Filter tasks by status value.",
            ),
        ],
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "{program_id, window_start, window_end, resources}. Each resource is "
                    "{id, name, email, max_units, tasks[]} and each task span is "
                    "{assignment_id, id, name, project_id, project_name, early_start, "
                    "early_finish, scheduled_start, units, status} — aggregated across "
                    "every member project of the program and tagged with its source "
                    "project, so a caller can surface people over-allocated across "
                    "sibling projects in overlapping windows. scheduled_start "
                    "(ADR-0752) is the task's SPAN start; the client renders "
                    "scheduled_start..early_finish, falling back to early_start when "
                    "scheduled_start is null. Overallocation detection stays "
                    "client-side per ADR-0031."
                ),
            ),
            400: OpenApiResponse(
                description="Malformed `start`/`end` date, or `start` is after `end`."
            ),
            409: OpenApiResponse(description="No member project has a computed schedule yet."),
        },
    )
    @action(detail=True, methods=["get"], url_path="resource-contention")
    def resource_contention(self, request: Request, pk: str | None = None) -> Response:
        """Cross-project resource allocation for the within-program contention view (#1149).

        The program-scoped counterpart to ``ProjectViewSet.resource_allocation`` (#85):
        returns each resource with their task spans across **every member project of this
        program**, each span tagged with its source project, so the client can show who is
        over-allocated across sibling projects in overlapping windows (the contention the
        GA-launch sample program deliberately creates).

        This is OSS, within-program **visibility** only — it surfaces contention data but
        does not level resources or cross a program boundary. Cross-program leveling and the
        portfolio heat map remain Enterprise. Overallocation detection is intentionally
        client-side (ADR-0031): the caller receives the merged spans and sums daily units
        against each resource's ``max_units``.

        Windowed and rendered on the task's SPAN (``scheduled_start``..``early_finish``,
        ADR-0752), not on ``early_start``..``early_finish`` (#2677) — the same defect
        fixed for ``ProjectViewSet.resource_allocation`` and for the utilization heat map
        (#2623): since ADR-0132, ``early_start`` is the *remaining-work* window for an
        in-progress task and narrows toward ``early_finish`` as ``percent_complete``
        rises, which would otherwise misreport cross-project contention as work is
        reported. ``scheduled_start`` falls back to ``early_start`` via ``Coalesce`` for
        rows a CPM run has not yet populated it on.

        Query parameters mirror the per-project endpoint:
          start    (YYYY-MM-DD, optional) — window start; defaults to the earliest
                   task span start across all member projects. Returns 409 if no
                   member project has CPM dates yet.
          end      (YYYY-MM-DD, optional) — window end; defaults to the latest early_finish.
          resource (UUID, optional, repeatable) — filter to specific resource IDs.
          status   (string, optional, repeatable) — filter tasks by status value.
        """
        from django.db.models import DateField
        from django.db.models.functions import Coalesce

        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids
        from trueppm_api.apps.resources.models import TaskResource

        program = self.get_object()

        # Member projects (non-deleted) — the contention scope. With no live
        # projects (or none scheduled) and no explicit window, the window cannot
        # be resolved and the endpoint returns 409 like the per-project one.
        # ADR-0678 T1 (#2482): the contention scope aggregates CHILD PROJECT task
        # spans, each tagged with its source project, so an opted-out project would
        # otherwise surface its schedule through its parent program.
        member_qs = program.projects.filter(is_deleted=False)
        _excluded = mcp_excluded_project_ids(request)
        if _excluded is not None:
            member_qs = member_qs.exclude(pk__in=_excluded)
        member_project_ids = list(member_qs.values_list("id", flat=True))

        # --- Resolve window bounds across all member projects ---
        base_tasks = Task.objects.filter(project_id__in=member_project_ids, is_deleted=False)

        try:
            window_start, window_end = _resolve_allocation_window(request, base_tasks)
        except _ScheduleNotComputedError:
            return Response(
                {"detail": _SCHEDULE_NOT_COMPUTED},
                status=status.HTTP_409_CONFLICT,
            )
        except ValueError as exc:
            # False positive: the only ValueError raised here is the curated
            # _parse_window_date message ("'start'/'end' must be ISO 8601 …").
            return Response(
                {"detail": str(exc)},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_400_BAD_REQUEST,
            )

        if window_start > window_end:
            return Response(
                {"detail": "'start' must not be after 'end'."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # --- Optional filters ---
        resource_ids = request.query_params.getlist("resource")
        status_filters = request.query_params.getlist("status")

        # --- Single query: all assignments across member projects in the window ---
        # Tasks with null CPM dates are retained (unscheduled); the client renders
        # them outside the contention math, mirroring the per-project endpoint.
        # _span_start (ADR-0752 / #2677): the task's SPAN start, not the
        # remaining-work window early_start narrows to as percent_complete
        # rises. Mirrors the per-project resource_allocation annotation.
        qs = (
            TaskResource.objects.filter(
                task__project_id__in=member_project_ids,
                task__is_deleted=False,
            )
            .select_related("resource", "task", "task__project")
            .annotate(
                _span_start=Coalesce(
                    "task__scheduled_start", "task__early_start", output_field=DateField()
                )
            )
            .order_by("resource__name", "task__project__name", "task__early_start")
        )

        if resource_ids:
            qs = qs.filter(resource__id__in=resource_ids)

        if status_filters:
            qs = qs.filter(task__status__in=status_filters)

        qs = qs.exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            task__early_finish__lt=window_start,
        ).exclude(
            task__early_finish__isnull=False,
            task__early_start__isnull=False,
            _span_start__gt=window_end,
        )

        # --- Build response grouped by resource, each span tagged with its project ---
        resources_map: dict[str, dict[str, Any]] = {}
        for assignment in qs:
            resource = assignment.resource
            rid = str(resource.id)
            if rid not in resources_map:
                resources_map[rid] = {
                    "id": rid,
                    "name": resource.name,
                    "email": resource.email,
                    "max_units": str(resource.max_units),
                    "tasks": [],
                }
            task = assignment.task
            resources_map[rid]["tasks"].append(
                {
                    "assignment_id": str(assignment.id),
                    "id": str(task.id),
                    "name": task.name,
                    "project_id": str(task.project_id),
                    "project_name": task.project.name,
                    "early_start": task.early_start.isoformat() if task.early_start else None,
                    "early_finish": task.early_finish.isoformat() if task.early_finish else None,
                    # ADR-0752: the task's SPAN start, read-only CPM output.
                    # Null until the next recalculation after upgrade; the
                    # client falls back to early_start (same fallback the
                    # Coalesce above applies server-side for windowing).
                    "scheduled_start": task.scheduled_start.isoformat()
                    if task.scheduled_start
                    else None,
                    "units": str(assignment.units),
                    "status": task.status,
                }
            )

        return Response(
            {
                "program_id": str(program.id),
                "window_start": window_start.isoformat(),
                "window_end": window_end.isoformat(),
                "resources": list(resources_map.values()),
            }
        )

    @extend_schema(
        summary="List bundled demo samples available to the loader",
        responses={200: SampleCatalogEntrySerializer(many=True)},
    )
    # The catalog is a fixed-size list of the fixtures baked into the image — it is
    # returned as a bare array and is never paginated. ProgramViewSet does set a
    # pagination_class, so without this opt-out the auto-schema declares a
    # PaginatedSampleCatalogEntryList envelope no response can satisfy (#2515,
    # cf. the `projects` action below and #2213).
    @suppress_list_pagination
    @action(detail=False, methods=["get"], url_path="samples")
    def samples(self, request: Request) -> Response:
        """List the bundled samples, with the provenance to audit them (#375, #2490).

        Beyond the loader's title/description, each entry carries what someone
        deciding whether to trust the fixture actually needs: its size, a SHA-256
        of the exact bytes this instance will serve, the schema version, and the
        entity counts. The counts answer the question the demo loader otherwise
        forces on faith — *how much is this about to write into my database?*

        Counts, digest and size all come from one read of one file
        (``sample_metadata``), so a client that verifies the digest has verified
        the same bytes the counts describe.

        A fixture that is present but unparseable reports ``null`` counts and
        stays downloadable: failing to summarize a file is no reason to withhold
        it from someone who wants to read it themselves.
        """
        from trueppm_api.apps.projects.seed.samples import SAMPLES, sample_metadata

        entries = []
        for sample in SAMPLES.values():
            meta = sample_metadata(sample)
            entries.append(
                {
                    "key": sample.key,
                    "title": sample.title,
                    "description": sample.description,
                    "filename": sample.filename,
                    "available": meta.available,
                    "size_bytes": meta.size_bytes,
                    "sha256": meta.sha256,
                    "schema_version": meta.schema_version,
                    "project_count": meta.project_count,
                    "task_count": meta.task_count,
                    "resource_count": meta.resource_count,
                    "download_url": reverse("program-download-sample", kwargs={"key": sample.key}),
                }
            )
        return Response(entries)

    @extend_schema(
        summary="Download a bundled demo sample's JSON seed file",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.BINARY,
                description=(
                    "The exact committed fixture bytes, as a JSON file attachment. "
                    "`ETag` is the same SHA-256 the catalog advertises."
                ),
            ),
            404: OpenApiResponse(description="No such sample key, or the file is missing."),
        },
    )
    @action(
        detail=False,
        methods=["get"],
        url_path=r"samples/(?P<key>[^/.]+)/download",
        url_name="download-sample",
        throttle_classes=[SampleDownloadThrottle],
    )
    def download_sample(self, request: Request, key: str | None = None) -> HttpResponseBase:
        """Stream a bundled fixture's exact bytes so it can be read before import (#2490).

        "Load demo data" writes an entire program on one click. This is how a
        self-hoster reads what it will write first — download the file, inspect
        it, dry-run it through ``POST /programs/import/validate/``, then import.

        **The security of this endpoint rests on one property: the key never
        becomes a path.** ``SAMPLES.get(key)`` is a dict lookup and a miss is a
        404; the fixture path is built inside the registry from the package
        directory and the entry's own filename. There is deliberately no
        sanitizing, no ``..`` stripping and no ``safe_join`` here — every one of
        those constructs implies a path is being assembled from input, and a
        reviewer should read their presence as a bug. A traversal-shaped key is
        not scrubbed; it is simply not a key, so it 404s before any I/O.

        Bytes are streamed rather than parsed and re-serialized: byte-for-byte
        fidelity is the point, and re-encoding would invalidate the digest the
        catalog advertised. The ``ETag`` is that same digest, so a conditional
        request costs nothing and a client can verify what it received.
        """
        from trueppm_api.apps.projects.seed.samples import SAMPLES, sample_metadata

        sample = SAMPLES.get(key or "")
        if sample is None:
            raise Http404("Unknown sample")

        meta = sample_metadata(sample)
        if not meta.available:
            # Registered but absent from disk: a broken install, not a bad
            # request. Still a 404 to the client — there is nothing to serve.
            raise Http404("Sample file is not present in this installation")

        etag = f'"{meta.sha256}"' if meta.sha256 else None
        # Handled here rather than by ConditionalGetMiddleware, which this
        # project does not install. Without it the ETag would be advertised but
        # never honored, so every revalidation would re-send the whole file.
        if etag and _if_none_match_matches(request.headers.get("If-None-Match"), etag):
            not_modified = HttpResponse(status=status.HTTP_304_NOT_MODIFIED)
            not_modified.headers["ETag"] = etag
            return not_modified

        response = FileResponse(
            sample.path.open("rb"),
            as_attachment=True,
            # From the registry entry, never interpolated from the request.
            filename=sample.filename,
            content_type="application/json",
        )
        if etag:
            response.headers["ETag"] = etag
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "private, max-age=0, must-revalidate"
        return response

    @extend_schema(
        summary="Load a bundled sample program",
        responses={201: LoadSampleResponseSerializer},
    )
    @action(
        detail=False,
        methods=["post"],
        url_path="load-sample",
        throttle_classes=[LoadSampleThrottle],
    )
    def load_sample(self, request: Request) -> Response:
        """Load a bundled sample program — the "Load demo data" action (#375, #1054).

        Body: ``{"sample": "<key>"}`` (optional; defaults to the launch demo).
        The caller becomes OWNER (same authorization as ``create``). Demo
        persona accounts are created so the boards render fully.

        Rate-limited to the ``sample_load`` scope (:class:`LoadSampleThrottle`),
        which replaces the viewset's general ``user`` default: one call rebuilds
        an entire program, so even a modest loop is abusive (#2402).

        **Latency:** this runs the whole import synchronously — seconds, not
        milliseconds, and proportional to the fixture. Clients must not apply a
        short request timeout; the web client opts out of its 30 s default for
        this call the same way it does for MSP import.

        The caller is then assigned the first open sprint's tasks (#1054) so a
        contributor who loads the demo from My Work sees their own work right
        away. The response is a ``{program, landing_project_id, sample_key}``
        envelope: ``landing_project_id`` is the board to land that contributor on
        (``null`` when the sample has no open sprint), and ``sample_key`` lets the
        client render the matching post-load "Start exploring" guidance.
        """
        from trueppm_api.apps.projects.seed.importer import SeedReplaceAmbiguous
        from trueppm_api.apps.projects.seed.samples import (
            DEFAULT_SAMPLE,
            UnknownSampleError,
            load_sample,
            prepare_sample_for_user,
        )

        key = request.data.get("sample", DEFAULT_SAMPLE)
        try:
            program = load_sample(key, owner=request.user, create_users=True)
        except SeedReplaceAmbiguous as exc:
            # The demo loader reloads in place, so it passes replace=True — but
            # Program.code is non-unique, and two live sample programs sharing
            # this slug cannot be told apart by a reload. A 409 the caller can
            # act on, not the 500 an unhandled refusal would produce.
            return Response(
                {"detail": str(exc), "code": "seed_replace_ambiguous"},
                status=status.HTTP_409_CONFLICT,
            )
        except UnknownSampleError as exc:
            # Standardized on the `detail` envelope (#1325). False positive: the
            # message only echoes the caller's own submitted sample key.
            return Response(
                {"detail": str(exc)},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_400_BAD_REQUEST,
            )

        landing_project = prepare_sample_for_user(program, request.user)

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(
            {
                "program": ProgramSerializer(fresh).data,
                "landing_project_id": (
                    str(landing_project.id) if landing_project is not None else None
                ),
                "sample_key": key,
            },
            status=status.HTTP_201_CREATED,
        )

    @extend_schema(
        summary="Tear down a sample program",
        responses={204: OpenApiResponse(description="Sample program purged; empty body.")},
    )
    @action(detail=True, methods=["post"], url_path="remove-sample")
    def remove_sample(self, request: Request, pk: str | None = None) -> Response:
        """Tear down a sample program — the "Remove sample data" action (#375).

        Owner-only. Refuses to delete a program that is not sample data, so the
        teardown can never remove real work. Hard-deletes the *entire* program
        subtree (all projects, not only is_sample ones — a sample program holds
        only sample projects). Unlike ``destroy`` this is a hard delete, not a
        soft delete: sample data is disposable, so it is purged outright. Offline
        sync clients reconcile via the ``program_deleted`` broadcast rather than a
        tombstone — acceptable because demo data is never offline-authored.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        is_sample = Project.objects.filter(
            program=program, is_sample=True, is_deleted=False
        ).exists()
        if not is_sample:
            return Response(
                {"detail": "This program is not sample data."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        program_id = str(program.pk)
        with transaction.atomic():
            # Lock the program row so a concurrent member-add / project-assign
            # can't resurrect a PROTECTed reference mid-teardown.
            Program.objects.select_for_update().filter(pk=program.pk).first()
            # hard_delete_program resolves the PROTECT-ing children from _meta rather
            # than listing them here — the hand-written list this replaced covered
            # memberships but not mention groups, so teardown 500'd on any sample
            # program that had one (#2364).
            hard_delete_program(program.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(program_id, "program_deleted", {"id": program_id})
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def destroy(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        instance = self.get_object()
        program_id = str(instance.pk)
        delete_program_cascade(instance.pk)
        # delete_program_cascade detaches projects (program=NULL) — emit a single
        # program-level event rather than fanning out per-project; clients
        # already invalidate project queries on program_deleted.
        transaction.on_commit(
            lambda: broadcast_board_event(program_id, "program_deleted", {"id": program_id})
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    # -----------------------------------------------------------------------
    # Lifecycle actions (#530)
    # -----------------------------------------------------------------------

    @extend_schema(
        summary="Close the program",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="close")
    def close(self, request: Request, pk: str | None = None) -> Response:
        """Mark the program as closed (read-only shell). Owner only (#530).

        Closing a program freezes the program-level surfaces (members, settings,
        ceremonies). Child projects are NOT cascaded — they retain their own
        lifecycle, matching the UI dialog's "projects remain active" warning.
        """
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        if not program.is_closed:
            program.is_closed = True
            program.closed_at = timezone.now()
            program.closed_by = request.user  # type: ignore[assignment]
            program.save(update_fields=["is_closed", "closed_at", "closed_by"])
            program_id = str(program.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(program_id, "program_closed", {"id": program_id})
            )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Reopen a closed program",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="reopen")
    def reopen(self, request: Request, pk: str | None = None) -> Response:
        """Reopen a closed program. Owner only (#530)."""
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        if program.is_closed:
            program.is_closed = False
            program.closed_at = None
            program.closed_by = None
            program.save(update_fields=["is_closed", "closed_at", "closed_by"])
            program_id = str(program.pk)
            transaction.on_commit(
                lambda: broadcast_board_event(program_id, "program_reopened", {"id": program_id})
            )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Transfer program sponsorship to another member",
        responses={200: ProgramSerializer},
    )
    @action(detail=True, methods=["post"], url_path="transfer-sponsorship")
    def transfer_sponsorship(self, request: Request, pk: str | None = None) -> Response:
        """Transfer program sponsorship to another existing member (#530).

        Body: ``{"new_owner_user_id": "<uuid>", "new_lead_user_id": "<uuid>?"}``.
        The new sponsor must already hold a ``ProgramMembership`` at any role —
        invite first if not. The current OWNER is atomically demoted to ADMIN.
        Optionally rotates ``program.lead`` so the program header chip moves
        with the role.
        """
        from django.contrib.auth import get_user_model

        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        program = self.get_object()
        # A non-object JSON body (list, string) has no ``.get`` — treat it as
        # empty so the ``new_owner_user_id is required`` branch returns 400
        # rather than raising AttributeError (500).
        body = request.data if isinstance(request.data, dict) else {}
        new_owner_id = body.get("new_owner_user_id")
        new_lead_id = body.get("new_lead_user_id")

        if not new_owner_id:
            return Response(
                {"detail": "new_owner_user_id is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        User = get_user_model()
        try:
            new_owner = User.objects.get(pk=new_owner_id)
        except (User.DoesNotExist, DjangoValidationError, ValueError):
            return Response(
                {"detail": "User not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        new_lead = None
        if new_lead_id:
            try:
                new_lead = User.objects.get(pk=new_lead_id)
            except (User.DoesNotExist, DjangoValidationError, ValueError):
                return Response(
                    {"detail": "Lead user not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )

        try:
            transfer_program_sponsorship(
                program=program,
                new_owner=new_owner,
                actor=request.user,
                new_lead=new_lead,
            )
        except DjangoValidationError as exc:
            # False positive: surfaces the service's own curated validation
            # message (role/membership reason), not a trace or internal.
            detail = exc.messages[0] if exc.messages else str(exc)
            return Response(
                {"detail": detail},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_400_BAD_REQUEST,
            )

        program_id = str(program.pk)
        transaction.on_commit(
            lambda: broadcast_board_event(
                program_id,
                "program_sponsorship_transferred",
                {"id": program_id, "new_owner_id": str(new_owner.pk)},
            )
        )
        fresh = self.get_queryset().get(pk=program.pk)
        return Response(ProgramSerializer(fresh).data, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Split a program into sub-programs",
        responses={
            200: OpenApiResponse(
                description=(
                    "The closed parent program plus the created sub-programs: "
                    "`{program, sub_programs}`."
                )
            ),
            400: OpenApiResponse(
                description="Invalid payload, or a project does not belong to this program."
            ),
        },
    )
    @action(detail=True, methods=["post"], url_path="split")
    def split(self, request: Request, pk: str | None = None) -> Response:
        """Split a program into sub-programs and close the original (ADR-0156, #967).

        Each entry in ``splits`` becomes a new program owned by the caller
        (methodology copied from the parent, inheritable settings left to inherit
        the workspace defaults); the entry's projects are moved under it. Only the
        ``Project.program`` FK moves, so tasks, dependencies, baselines, and history
        are preserved. The original program is closed afterwards and keeps any
        projects that were not redistributed. The whole operation is atomic.

        Owner only (``IsProgramOwner``); a closed program cannot be split
        (``IsProgramNotClosed``), which also makes a retried request safe — once
        the parent is closed a replay is rejected before it can double-split.

        Body: ``{"splits": [{"name": str, "project_ids": [uuid]}, ...]}``
        """
        from trueppm_api.apps.access.services import split_program
        from trueppm_api.apps.sync.broadcast import broadcast_board_event

        # Owner-only object check (also confirms the program exists).
        program = self.get_object()

        # Guard the top-level body shape first: a non-object JSON body (string/
        # scalar) has no ``.get``, so an unguarded access raises AttributeError →
        # 500. Any non-object body is treated as a missing "splits" → 400 (#2126).
        splits = request.data.get("splits") if isinstance(request.data, dict) else None
        if not isinstance(splits, list) or not splits:
            return Response(
                {"detail": "splits must be a non-empty array."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Bound the number of sub-programs created in one call — even an Owner
        # shouldn't be able to spawn unbounded empty programs in a single request.
        if len(splits) > _MAX_SPLITS:
            return Response(
                {"detail": f"A program can be split into at most {_MAX_SPLITS} sub-programs."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        for split in splits:
            if not isinstance(split, dict):
                return Response(
                    {"detail": "Each split entry must be an object."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if not split.get("name") or not isinstance(split.get("project_ids"), list):
                return Response(
                    {"detail": "Each split must include 'name' and 'project_ids' array."},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            sub_programs = split_program(program=program, splits=splits, actor=request.user)
        except DjangoValidationError as exc:
            # False positive: surfaces the service's own curated validation
            # message (the offending project id is the caller's own input).
            detail = exc.messages[0] if exc.messages else str(exc)
            return Response(
                {"detail": detail},  # codeql[py/stack-trace-exposure]
                status=status.HTTP_400_BAD_REQUEST,
            )

        program_id = str(program.pk)
        sub_ids = [str(sub.pk) for sub in sub_programs]
        transaction.on_commit(
            lambda: broadcast_board_event(
                program_id,
                "program_split",
                {"id": program_id, "sub_program_ids": sub_ids},
            )
        )

        fresh = self.get_queryset().get(pk=program.pk)
        return Response(
            {
                "program": ProgramSerializer(fresh).data,
                "sub_programs": ProgramSerializer(sub_programs, many=True).data,
            },
            status=status.HTTP_200_OK,
        )

    # -----------------------------------------------------------------------
    # Custom actions
    # -----------------------------------------------------------------------

    @extend_schema(
        summary="List projects in this program",
        responses={200: ProjectSerializer(many=True)},
    )
    # This action returns a bare array, but ProgramViewSet sets pagination_class,
    # so the auto-schema would otherwise declare a PaginatedProjectList envelope
    # the real body violates (#2213). Opt out so the schema matches the response.
    @suppress_list_pagination
    @action(detail=True, methods=["get"], url_path="projects")
    def projects(self, request: Request, pk: str | None = None) -> Response:
        """List projects in this program.

        URL: ``GET /api/v1/programs/{pk}/projects/``

        Permission: IsProgramMember (any program role can see the project list,
        but the project itself only opens if the user also has project membership
        — that gate is enforced by the project's own viewset on click-through).
        """
        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids

        program = self.get_object()
        # Per-project overdue / at-risk counts (#560), so the Projects tab reads
        # like a morning standup. Both are conditional COUNTs over the project's
        # own tasks in the SAME query (no N+1) — distinct=True guards against the
        # row-fanout that two filtered aggregates over one reverse relation would
        # otherwise produce. "Incomplete" excludes COMPLETE and soft-deleted rows;
        # "overdue" = past the CPM early_finish; "at-risk" reuses the canonical
        # ≤5-working-days-of-float rule (cf. ProjectViewSet.status_summary).
        today = timezone.localdate()
        incomplete = ~Q(tasks__status=TaskStatus.COMPLETE) & Q(tasks__is_deleted=False)
        qs = (
            Project.objects.filter(program=program, is_deleted=False)
            # ADR-0441: ProjectSerializer.effective_calendar resolves project ?? program
            # ?? workspace and reports holiday_count, so select_related the program-tier
            # calendar and prefetch both tiers' exceptions to keep this list N+1-free.
            # (The workspace-tier calendar is the shared singleton, resolved once via the
            # serializer's cached workspace.)
            .select_related("calendar", "program", "program__calendar")
            .prefetch_related("calendar__exceptions", "program__calendar__exceptions")
            .annotate(
                overdue_count=Count(
                    "tasks",
                    filter=incomplete & Q(tasks__early_finish__lt=today),
                    distinct=True,
                ),
                at_risk_count=Count(
                    "tasks",
                    filter=incomplete
                    & Q(tasks__total_float__isnull=False)
                    & Q(tasks__total_float__lte=5),
                    distinct=True,
                ),
            )
            .order_by("start_date", "name")
        )
        # ADR-0678 T1 (#2482): this lists CHILD PROJECT rows (with per-project task
        # counts), which the mixin's Program-row filter does not reach.
        _excluded = mcp_excluded_project_ids(request)
        if _excluded is not None:
            qs = qs.exclude(pk__in=_excluded)
        # `is_pinned` for THIS caller (#2553). The annotation normally arrives via
        # ProjectViewSet.get_queryset, which this action bypasses by building its
        # own queryset — and ProjectSerializer.get_is_pinned reads the attribute
        # defensively, so the omission degraded to a silent `false` on every row
        # rather than raising. Bound positionally to request.user (ADR-0627 §D5),
        # so it can only ever answer "did I pin this".
        qs = annotate_is_pinned(qs, request.user, field="project")
        return Response(ProjectSerializer(qs, many=True).data)

    @extend_schema(
        summary="Get the program-scoped integrations summary",
        responses={
            200: OpenApiResponse(
                description=(
                    "Summary object with `webhooks` and `api_tokens` sections "
                    "scoped to the program."
                )
            ),
            503: OpenApiResponse(
                description="A subservice failed; body names the `failed` section."
            ),
        },
    )
    @action(detail=True, methods=["get"], url_path="integrations-summary")
    def integrations_summary(self, request: Request, pk: str | None = None) -> Response:
        """Program-scoped integrations summary (ADR-0076).

        URL: ``GET /api/v1/programs/{pk}/integrations-summary/``

        Returns the program's outbound webhooks and inbound API tokens that
        are scoped to the program itself — does NOT bubble up resources from
        child projects (those have their own per-project summaries).

        Same shape and per-section 503 fallback semantics as the project
        endpoint so the frontend can re-use the hook contract.
        """
        import logging

        from django.db.models import Q
        from rest_framework import status as drf_status

        from trueppm_api.apps.projects.views import (
            _summarize_api_tokens,
            _summarize_webhooks,
        )

        logger = logging.getLogger(__name__)

        program = self.get_object()
        sections: dict[str, Any] = {}

        try:
            sections["webhooks"] = _summarize_webhooks(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary webhooks subservice failed")
            return Response(
                {"failed": "webhooks"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        try:
            sections["api_tokens"] = _summarize_api_tokens(Q(program_id=program.id))
        except Exception:
            logger.exception("program integrations-summary api_tokens subservice failed")
            return Response(
                {"failed": "api_tokens"},
                status=drf_status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(sections, status=drf_status.HTTP_200_OK)

    @extend_schema(
        summary="Count who @program-stakeholders reaches",
        responses={
            200: inline_serializer(
                name="ProgramMentionReach",
                fields={
                    "group_key": serializers.CharField(),
                    "viewer_member_count": serializers.IntegerField(),
                    "external_stakeholder_count": serializers.IntegerField(),
                },
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="mention-reach")
    def mention_reach(self, request: Request, pk: str | None = None) -> Response:
        """Who the ``@program-stakeholders`` alias reaches, counted per arm.

        URL: ``GET /api/v1/programs/{pk}/mention-reach/``

        The alias has two arms that ADR-0264 deliberately keeps apart, and this
        endpoint keeps them apart too:

        * ``viewer_member_count`` — exact-``Role.VIEWER`` members across the
          program's live projects, deduplicated by user. Real accounts; they get a
          durable in-app notification today.
        * ``external_stakeholder_count`` — registry rows with no ``User``. They
          receive nothing today; outbound delivery is deferred to #1675.

        **The response carries no total on purpose** (ADR-0697 §1a). Summing the two
        arms would re-assert in the API the very union #1675 removed from the
        resolver — the union under which an internal mention could silently email a
        client. Clients must render the arms separately.

        Computed on read from the same querysets the resolver uses, so the number a
        PM is shown is the number a mention would fan out to. Permission: program
        Admin+.
        """
        from trueppm_api.apps.access.groups import count_program_stakeholder_reach
        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids

        program = self.get_object()

        # ADR-0678 T1 (#2482): the internal arm aggregates CHILD PROJECT membership,
        # which the mixin's row filter — it only ever sees the Program row — cannot
        # reach. Intersect explicitly, exactly as rollup/schedule/projects do. The
        # ADR-0678 T8 audit flag needs no set here: get_object() already ran the
        # mixin's filter, which sets it centrally for a token caller.
        reach = count_program_stakeholder_reach(
            program.pk, exclude_project_ids=mcp_excluded_project_ids(request)
        )
        return Response(
            {
                "group_key": "program-stakeholders",
                "viewer_member_count": reach.viewer_member_count,
                "external_stakeholder_count": reach.external_stakeholder_count,
            }
        )

    @extend_schema(
        summary="Read or update the program rollup KPIs config",
        responses={200: ProgramRollupConfigSerializer},
    )
    @action(detail=True, methods=["get", "patch"], url_path="rollup-config")
    def rollup_config(self, request: Request, pk: str | None = None) -> Response:
        """Read or update the program rollup KPIs config (ADR-0169, #527).

        URL: ``GET|PATCH /api/v1/programs/{pk}/rollup-config/``

        Permission split is method-level (see ``get_permissions``): any
        member can read, only admins can write. Audit is automatic via the
        ``HistoricalRecords()`` already on Program — every successful PATCH
        creates a ``HistoricalProgram`` row with the field diff.
        """
        program = self.get_object()
        if request.method == "GET":
            return Response(ProgramRollupConfigSerializer(program).data)

        serializer = ProgramRollupConfigSerializer(program, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        # Re-serialize from the fresh instance so the response carries any
        # field-level normalization (de-duped KPI list) applied by the
        # serializer's validators.
        return Response(ProgramRollupConfigSerializer(program).data)

    @extend_schema(
        summary="Compute the program KPI rollup across its projects",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Program rollup computed on read (ADR-0088): aggregation_policy, "
                    "policy_available (whether that policy could be honored), project_count "
                    "(contributing projects), program_health (the program health dot), and "
                    "kpis — a per-KPI map where an available KPI is "
                    "{available: true, value, unit?} and a deferred KPI is "
                    "{available: false, reason}."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="rollup")
    def rollup(self, request: Request, pk: str | None = None) -> Response:
        """Computed rollup of the enabled KPIs across the program's projects.

        URL: ``GET /api/v1/programs/{pk}/rollup/``

        Consumes the #527 config (``rollup_enabled_kpis`` +
        ``rollup_aggregation_policy``) and returns the rolled-up values per
        ADR-0088 — the program health dot, the active policy (and whether it
        could be honored), the contributing project count, and a per-KPI map
        where deferred KPIs carry ``{"available": False, "reason": ...}``.

        Read-only and computed on demand (no persisted rollup row), so it always
        reflects the projects' current state. Permission: any program member.
        """
        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids
        from trueppm_api.apps.projects.program_rollup import compute_program_rollup

        program = self.get_object()
        return Response(
            compute_program_rollup(
                program,
                # ADR-0678 T1 (#2482): this is a program-scoped read that aggregates
                # CHILD PROJECT data, so the mixin's row filter (which sees only the
                # Program row) does not reach it. Opted-out projects are dropped here.
                exclude_project_ids=mcp_excluded_project_ids(request),
            )
        )

    @extend_schema(
        summary="Compute the program-true cross-project schedule",
        responses={
            200: OpenApiResponse(
                response=OpenApiTypes.OBJECT,
                description=(
                    "Merged program schedule computed on read: project lanes, "
                    "tasks (full for projects the caller can read, redacted "
                    "ExternalTaskCard shape otherwise), leaf-level links flagged "
                    "cross-project, and the program-true critical path."
                ),
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="schedule")
    def schedule(self, request: Request, pk: str | None = None) -> Response:
        """Merged, program-true critical path across the program's projects.

        URL: ``GET /api/v1/programs/{pk}/schedule/``

        Loads every member project's tasks and every accepted cross-project edge
        into one engine graph and runs the deterministic CPM once (ADR-0120 D3
        read side; render-don't-derive per ADR-0115) — the source the #1118
        program schedule view consumes. Computed on demand; nothing is persisted,
        so it always reflects current project state.

        Permission: any program member (closed programs stay readable for
        forensics). Tasks in member projects the requester cannot read are
        redacted to the ADR-0120 D5 ExternalTaskCard shape — never their
        description, assignee, status, or points, only title and program-true
        CPM dates. ``can_access_project`` is the per-project membership predicate;
        injecting it keeps the schedule service request-agnostic.
        """
        from trueppm_api.apps.access.permissions import _membership_role
        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids
        from trueppm_api.apps.projects.program_schedule import compute_program_schedule

        program = self.get_object()
        return Response(
            compute_program_schedule(
                program,
                can_access_project=lambda project_id: (
                    _membership_role(request, project_id) is not None
                ),
                # ADR-0678 T1 (#2482): opted-out projects are DROPPED from the merged
                # graph, not redacted — the ExternalTaskCard redaction still exposes
                # task titles and program-true CPM dates, which is the wrong answer for
                # a project that explicitly withheld consent.
                exclude_project_ids=mcp_excluded_project_ids(request),
            )
        )

    @extend_schema(
        summary="Search tasks across a program's projects (cross-project dep picker)",
        parameters=[
            OpenApiParameter(
                "q",
                OpenApiTypes.STR,
                description="Case-insensitive substring matched against task name or notes.",
                required=True,
            ),
            OpenApiParameter(
                "exclude_project",
                OpenApiTypes.UUID,
                description=(
                    "Project to omit from results — the picker's own project, whose "
                    "tasks the client already has locally."
                ),
                required=False,
            ),
        ],
        responses={
            200: OpenApiResponse(
                description=(
                    "Slim rows `[{id, name, short_id, short_id_display, qualified_id, "
                    "project_id, project_name}]` for tasks in member projects the "
                    "caller can read."
                )
            )
        },
    )
    @action(detail=True, methods=["get"], url_path="task-search")
    def task_search(self, request: Request, pk: str | None = None) -> Response:
        """Search tasks across a program's projects, to pick a cross-project edge.

        URL: ``GET /api/v1/programs/{pk}/task-search/?q=<term>&exclude_project=<uuid>``

        Backs the ADR-0120 cross-project dependency picker: the schedule picker is
        single-project, so a user cannot today reach a sibling project's task to
        gate against it. This returns a slim, sensitive-field-free list scoped to
        the program's member projects **the caller can actively read** — the D5
        "creator needs read access to both tasks" creation rule. A member project
        the caller cannot read is simply not searched (its tasks are not offered),
        so no unauthorized task titles leak through the picker.

        Slim shape (``[{id, name, short_id, short_id_display, qualified_id,
        project_id, project_name}]``) carries no cost/budget/status/assignee
        fields, so role-based field visibility is moot — project readability is
        the only gate (same rationale as the per-project ``TaskViewSet.search``
        action). ``short_id`` is still returned for callers that need the raw
        value, but ``short_id_display``/``qualified_id`` are what a UI must
        render (#2671) — this hand-built row bypassed ``TaskSerializer``
        entirely and returned the raw hex, which is exactly the leak both the
        cross-project dependency picker (``ScheduleDependencyPicker``) and the
        cross-project relation picker (``RelatedLinkPicker``) inherited from it.
        ``qualified_id`` is where this endpoint matters most: it is the only one
        of the six/seven #2671 sites where results are genuinely cross-project,
        so the project-code prefix is what disambiguates two sibling projects'
        task 3 from each other.
        """
        from django.db.models import Case, IntegerField, Value, When

        from trueppm_api.apps.access.models import ProjectMembership

        program = self.get_object()

        # IsAuthenticated already gates this action; the guard also narrows the
        # type for the membership lookup below.
        user = request.user
        if not (user and user.is_authenticated):
            return Response([], status=status.HTTP_200_OK)

        raw_q = (request.query_params.get("q") or "").strip()
        if not raw_q:
            return Response([], status=status.HTTP_200_OK)
        # DoS guard: a pathological term can't force an unbounded trigram scan.
        q = raw_q[:100]

        exclude_project = request.query_params.get("exclude_project")

        # Member projects the caller can read, minus the picker's own project.
        # Readability is the D5 "read access to both tasks" rule; a non-readable
        # member project is dropped entirely (rather than redacted, as ``schedule``
        # does) because an unpickable task should not appear at all. A single
        # membership query resolves the whole program's readable set — the same
        # ``ProjectMembership`` predicate ``_membership_role`` applies per row, but
        # here in one pass rather than N per-project lookups.
        from trueppm_api.apps.projects.mcp_settings import mcp_excluded_project_ids

        membership_qs = ProjectMembership.objects.filter(
            project__program=program,
            project__is_deleted=False,
            user=user,
            is_deleted=False,
        )
        # ADR-0678 T1 (#2482): the picker searches tasks across CHILD PROJECTS, which
        # the mixin's Program-row filter does not reach. An opted-out project is
        # dropped entirely — the same treatment a non-readable member project gets.
        _excluded = mcp_excluded_project_ids(request)
        if _excluded is not None:
            membership_qs = membership_qs.exclude(project_id__in=_excluded)
        readable_ids = set(membership_qs.values_list("project_id", flat=True))
        # (name, code) per readable project — the code is what lets a result row
        # carry a qualified_id (#2671); before this it was name-only and every
        # row fell back to the ambiguous compact form.
        readable: dict[str, tuple[str, str]] = {}
        for row in Project.objects.filter(
            program=program, is_deleted=False, id__in=readable_ids
        ).values("id", "name", "code"):
            pid = str(row["id"])
            if exclude_project is not None and pid == str(exclude_project):
                continue
            readable[pid] = (row["name"], row["code"] or "")

        if not readable:
            return Response([], status=status.HTTP_200_OK)

        qs = (
            Task.objects.filter(project_id__in=list(readable.keys()), is_deleted=False)
            .filter(Q(name__icontains=q) | Q(notes__icontains=q))
            # Title matches rank above description-only matches; project then name
            # are the stable tiebreaks so grouped results stay deterministic.
            .annotate(
                _name_match=Case(
                    When(name__icontains=q, then=Value(0)),
                    default=Value(1),
                    output_field=IntegerField(),
                )
            )
            .order_by("_name_match", "project_id", "name")
        )
        # `.values()` after an `.annotate()` is typed by django-stubs as the
        # annotated Task row (carrying `_name_match`), not a plain dict, so the
        # index access below trips mypy. The projection genuinely yields dicts;
        # cast to reflect that.
        rows = cast(
            "list[dict[str, Any]]",
            list(qs.values("id", "name", "short_id", "project_id")[:200]),
        )
        results: list[dict[str, Any]] = []
        for task_row in rows:
            project_name, project_code = readable[str(task_row["project_id"])]
            # Same decode + qualify rule as TaskSerializer (#2430) — this row is
            # hand-built rather than serialized through TaskSerializer (the
            # queryset above is a search projection, not a Task instance list),
            # so it must apply the rule itself rather than inherit it.
            display = format_short_id_display(task_row["short_id"], "T")
            qualified = f"{project_code}-{display[2:]}" if project_code and display else display
            results.append(
                {
                    "id": str(task_row["id"]),
                    "name": task_row["name"],
                    "short_id": task_row["short_id"],
                    "short_id_display": display,
                    "qualified_id": qualified,
                    "project_id": str(task_row["project_id"]),
                    "project_name": project_name,
                }
            )
        return Response(results, status=status.HTTP_200_OK)

    @extend_schema(
        summary="Read or update the program risk & dependencies policy",
        responses={200: ProgramRiskPolicySerializer},
    )
    @action(detail=True, methods=["get", "patch"], url_path="risk-policy")
    def risk_policy(self, request: Request, pk: str | None = None) -> Response:
        """Read or update the program risk & deps policy (#529).

        URL: ``GET|PATCH /api/v1/programs/{pk}/risk-policy/``

        Permission split mirrors ``rollup_config`` (see ``get_permissions``):
        any member can read, only admins can write. Audit is automatic via
        the ``HistoricalRecords()`` already on Program — every successful
        PATCH creates a ``HistoricalProgram`` row with the field diff.

        The 5×5 risk matrix surfaced on the same Settings page is
        intentionally out of scope here — those thresholds are workspace-
        wide and read-only at the program level.
        """
        program = self.get_object()
        if request.method == "GET":
            return Response(ProgramRiskPolicySerializer(program).data)

        serializer = ProgramRiskPolicySerializer(program, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(ProgramRiskPolicySerializer(program).data)

    @extend_schema(
        summary="Bulk-set inherited settings across multiple programs",
        request=BulkFieldsRequestSerializer,
        responses={
            200: OpenApiResponse(
                description="Per-program id + new server_version, and the fields applied."
            )
        },
    )
    @action(detail=False, methods=["post"], url_path="bulk-fields")
    def bulk_fields(self, request: Request) -> Response:
        """Set inherited settings on a selection of programs in one call (ADR-0161, #1233).

        URL: ``POST /api/v1/programs/bulk-fields/`` — the Workspace → Programs matrix scope.

        Body ``{"ids": [<program uuid>...], "fields": {"methodology": "AGILE", ...}}``:
        only the named fields on the named programs change; every other program and every
        other field keeps inheriting. Workspace-admin only — the matrix is a
        workspace-settings surface. Each row is written via ``save()`` so ``server_version``
        bumps for offline sync and ``HistoricalProgram`` audits the diff. All-or-nothing.
        """
        envelope = BulkFieldsRequestSerializer(data=request.data)
        envelope.is_valid(raise_exception=True)
        with transaction.atomic():
            rows = apply_bulk_fields(
                field_serializer_cls=ProgramBulkFieldsSerializer,
                queryset=Program.objects.filter(is_deleted=False, is_closed=False),
                ids=envelope.validated_data["ids"],
                fields=envelope.validated_data["fields"],
            )
        return Response(build_bulk_response(rows, envelope.validated_data["fields"]))

    @extend_schema(
        summary="Bulk-set inherited settings across this program's projects",
        request=BulkFieldsRequestSerializer,
        responses={
            200: OpenApiResponse(
                description="Per-project id + new server_version, and the fields applied."
            )
        },
    )
    @action(detail=True, methods=["post"], url_path="bulk-project-fields")
    def bulk_project_fields(self, request: Request, pk: str | None = None) -> Response:
        """Set inherited settings on a selection of this program's projects (ADR-0161, #1233).

        URL: ``POST /api/v1/programs/{pk}/bulk-project-fields/`` — the Program → Projects
        matrix scope.

        Program-admin only. Targets are constrained to this program's own non-archived
        projects, so the program PK in the URL is the IDOR boundary — a project id from
        another program is rejected as out-of-scope (400), never silently skipped. Only the
        two benign, non-schedule inherited fields (methodology, iteration_label) ship in
        this slice; ``calendar`` is deferred (schedule-affecting, no bulk recalc path yet).
        """
        program = self.get_object()
        envelope = BulkFieldsRequestSerializer(data=request.data)
        envelope.is_valid(raise_exception=True)
        with transaction.atomic():
            rows = apply_bulk_fields(
                field_serializer_cls=ProjectBulkFieldsSerializer,
                queryset=Project.objects.filter(
                    program_id=program.pk, is_deleted=False, is_archived=False
                ),
                ids=envelope.validated_data["ids"],
                fields=envelope.validated_data["fields"],
            )
        return Response(build_bulk_response(rows, envelope.validated_data["fields"]))
