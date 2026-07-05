"""User-scoped external task sources (ADR-0097 §1).

A second ``ProviderRegistry``, ``EXTERNAL_TASK_SOURCES``, distinct from
``TASK_LINK_PROVIDERS`` (ADR-0049). The two solve different problems and must
not collide:

- ``TASK_LINK_PROVIDERS`` — "paste a URL on a task, fetch its status" (git-aware
  tasks). ``jira`` stays reserved for Enterprise *there*.
- ``EXTERNAL_TASK_SOURCES`` (this module) — "pull the issues assigned to *me*
  from my personal account into My Work." OSS owns ``jira`` **here**, narrowly,
  for read-only personal pull.

The ABC below is the entire stable cross-repo surface: OSS registers ``jira``
in ``IntegrationsConfig.ready()``; Enterprise registers richer sources
(``servicenow``, ``azure_devops``) against the same registry from its own
``AppConfig.ready()`` with **no** ``trueppm_enterprise`` import in OSS. Adding a
source key is additive; renaming/removing a key or changing the ABC signature
is a major-version bump.

Security posture (ADR-0097 §Threat Model → Resolution):
- The source never sees ciphertext or the DB row — the caller decrypts the PAT
  once at the boundary and passes the plaintext ``secret`` in. This keeps the
  encryption surface inside ``apps/integrations`` and out of every source impl.
- ``base_url`` is Jira-Cloud-allow-listed by the connection endpoint
  (``providers.assert_base_url_allowed``) *before* the token is ever put on the
  wire; every fetch additionally routes through the SSRF-guarded ``http`` helper.
- DTOs returned by a source are **untrusted**: field lengths are capped and
  ``external_url`` is forced to an ``https?://`` scheme at the registry boundary
  (:meth:`ExternalWorkItemDTO.sanitized`), so a hostile provider response cannot
  smuggle an over-long title or a ``javascript:`` link into the cache.
"""

from __future__ import annotations

import abc
import base64
import urllib.parse
from dataclasses import dataclass
from datetime import date
from typing import Any, ClassVar

from . import http
from .registry import ProviderRegistry, VerifyResult

# Display buckets a source maps its native status onto, for grouping in My Work.
# Deliberately coarse (three states) — a lossy projection of the provider's
# workflow, consistent across sources so the My Work section renders uniformly.
BUCKET_TODO = "todo"
BUCKET_IN_PROGRESS = "in_progress"
BUCKET_DONE = "done"
DISPLAY_BUCKETS: tuple[str, ...] = (BUCKET_TODO, BUCKET_IN_PROGRESS, BUCKET_DONE)

# Field-length caps enforced at the registry boundary on untrusted provider data
# (ADR-0097 §Resolution #4). Match the ``ExternalWorkItem`` column widths so a
# sanitized DTO always fits the model without a DB-level truncation error.
_MAX_EXTERNAL_ID = 255
_MAX_TITLE = 512
_MAX_STATUS = 64
_MAX_URL = 2000

# Per-(user, source) fetch caps (ADR-0097 §Decision #4 "Bounded growth"). The
# single-page fetch here is bounded to one page; the multi-page walk + 500-row
# cache cap live in the #1419 sync worker that persists these DTOs.
_FETCH_PAGE_SIZE = 100


@dataclass(frozen=True)
class ExternalWorkItemDTO:
    """One remote work item pulled from an external source (read-only).

    A transport object between a source's :meth:`ExternalTaskSource.fetch_assigned_items`
    and the #1419 sync worker that upserts it into ``ExternalWorkItem``. It is
    **not** a ``Task`` and never becomes one — the read-only invariant (ADR-0097
    §2) is what keeps this feature OSS.

    Attributes:
        external_id: Provider-side identifier — the human key for Jira (``"RIV-482"``).
        external_url: Deep link to the item in the provider (``https?://`` only).
        title: Item summary.
        external_status: Raw status name from the provider (``"In Review"``).
        display_bucket: One of :data:`DISPLAY_BUCKETS`, mapped by the source.
        due_date: Optional due date, or ``None``.
    """

    external_id: str
    external_url: str
    title: str
    external_status: str
    display_bucket: str
    due_date: date | None = None

    def sanitized(self) -> ExternalWorkItemDTO:
        """Return a copy with untrusted fields length-capped and URL scheme-checked.

        Called at the registry boundary on every DTO a source returns, so a
        hostile or buggy provider cannot overflow a column or land a
        ``javascript:``/``data:`` URL in the cache (ADR-0097 §Resolution #4). An
        ``external_url`` that is not ``http(s)`` is dropped to an empty string
        rather than raising — one bad link should not fail the whole pull.
        """
        url = self.external_url.strip()
        scheme = urllib.parse.urlparse(url).scheme.lower()
        if scheme not in ("http", "https"):
            url = ""
        bucket = self.display_bucket if self.display_bucket in DISPLAY_BUCKETS else BUCKET_TODO
        return ExternalWorkItemDTO(
            external_id=self.external_id[:_MAX_EXTERNAL_ID],
            external_url=url[:_MAX_URL],
            title=self.title[:_MAX_TITLE],
            external_status=self.external_status[:_MAX_STATUS],
            display_bucket=bucket,
            due_date=self.due_date,
        )


class ExternalTaskSource(abc.ABC):
    """Contract for a user-scoped, read-only external work-item source (ADR-0097 §1).

    The whole stable cross-repo surface. A source is stateless — it is
    instantiated per call and holds no credential. The caller decrypts the PAT
    and passes ``secret`` (plaintext) + ``base_url`` + ``config`` so the source
    never touches the credential store or ciphertext.
    """

    key: ClassVar[str]
    label: ClassVar[str]
    requires_credential: ClassVar[bool] = True

    @abc.abstractmethod
    def fetch_assigned_items(
        self, *, base_url: str, secret: str, config: dict[str, Any]
    ) -> list[ExternalWorkItemDTO]:
        """Return the items currently assigned to the credential's owner (read-only).

        A single SSRF-guarded page of results. The multi-page walk, the 500-row
        cap, ``Retry-After`` backoff, and persistence to ``ExternalWorkItem`` are
        the #1419 sync worker's job — a source is a pure read.
        """

    def verify_credential(
        self, *, base_url: str, secret: str, config: dict[str, Any]
    ) -> VerifyResult:
        """Check the credential authenticates against the source.

        Deliberately **not** abstract: the default accepts the credential
        without a live check (``reason="unverified"``), so an Enterprise source
        registered before this method existed keeps working. Sources that can
        cheaply verify (a ``/myself`` ping) override it.
        """
        return VerifyResult(ok=True, reason="unverified")


# ---------------------------------------------------------------------------
# OSS Jira Cloud source (ADR-0097 §Decision #1)
# ---------------------------------------------------------------------------

# Jira Cloud REST v3 ``statusCategory.key`` → display bucket. Jira has exactly
# three status categories; this projection is total and lossless at the category
# level (the finer per-workflow status is preserved raw in ``external_status``).
_JIRA_CATEGORY_TO_BUCKET: dict[str, str] = {
    "new": BUCKET_TODO,
    "indeterminate": BUCKET_IN_PROGRESS,
    "done": BUCKET_DONE,
}

# Default JQL: my open work. Overridable per connection via ``config["jql"]``.
_DEFAULT_JIRA_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"


def _jira_origin(base_url: str) -> str:
    """Return the ``https://host`` origin for a Jira Cloud ``base_url``.

    Defense in depth: the connection endpoint already allow-listed the host to
    ``*.atlassian.net`` before storing it, but this reconstructs the origin from
    the parsed host and forces ``https`` so a stored value can never downgrade
    the scheme or carry a path/query into the request URL.

    Raises:
        ValueError: ``base_url`` has no hostname.
    """
    parsed = urllib.parse.urlparse(base_url if "//" in base_url else f"https://{base_url}")
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("Jira base_url must include a hostname")
    return f"https://{host}"


def _jira_auth_header(email: str, api_token: str) -> str:
    """Build the Basic-auth header value for a Jira Cloud API token.

    Jira Cloud authenticates API tokens with HTTP Basic ``email:token`` (Bearer
    is OAuth-3LO only, which is the Enterprise governance path). Kept as a helper
    so the PAT never appears in a log-adjacent f-string at the call site.
    """
    raw = f"{email}:{api_token}".encode()
    return "Basic " + base64.b64encode(raw).decode("ascii")


class JiraCloudSource(ExternalTaskSource):
    """Read-only personal pull of a user's assigned Jira Cloud issues (ADR-0097).

    Authenticates with the user's own Jira Cloud API token (Basic auth,
    ``account_email:token``). ``config`` carries ``{"account_email", "jql",
    "project_keys"}``; ``base_url`` is the tenant's ``*.atlassian.net`` host,
    allow-listed by the connection endpoint before any request is made.
    """

    key: ClassVar[str] = "jira"
    label: ClassVar[str] = "Jira"
    requires_credential: ClassVar[bool] = True

    def _headers(self, email: str, secret: str) -> dict[str, str]:
        return {
            "Authorization": _jira_auth_header(email, secret),
            "Accept": "application/json",
        }

    def verify_credential(
        self, *, base_url: str, secret: str, config: dict[str, Any]
    ) -> VerifyResult:
        """Ping ``/rest/api/3/myself`` to confirm the token + email authenticate.

        A 200 means the credential is usable; 401/403 means a wrong/expired
        token or wrong email; 5xx and transport failures degrade to
        "unreachable" so the user can retry rather than assume a dead token.
        A missing ``account_email`` fails fast — Basic auth needs it.
        """
        email = (config or {}).get("account_email", "").strip()
        if not email:
            return VerifyResult(ok=False, reason="missing_email")
        try:
            origin = _jira_origin(base_url)
        except ValueError:
            return VerifyResult(ok=False, reason="blocked_host")
        try:
            response = http.get(f"{origin}/rest/api/3/myself", headers=self._headers(email, secret))
        except http.EgressTimeout:
            return VerifyResult(ok=False, reason="provider_timeout")
        except http.EgressBlocked:
            return VerifyResult(ok=False, reason="blocked_host")
        except http.EgressError:
            return VerifyResult(ok=False, reason="provider_unreachable")

        if response.status == 200:
            payload = response.json()
            username = payload.get("displayName") if isinstance(payload, dict) else None
            return VerifyResult(ok=True, username=username)
        if response.status >= 500:
            return VerifyResult(ok=False, reason="provider_unreachable")
        return VerifyResult(ok=False, reason="invalid_token")

    def fetch_assigned_items(
        self, *, base_url: str, secret: str, config: dict[str, Any]
    ) -> list[ExternalWorkItemDTO]:
        """Fetch one page of the user's assigned Jira issues as sanitized DTOs.

        Read-only ``GET /rest/api/3/search``. Transport/parse failures raise
        (the caller — the #1419 worker — maps them to the connection's staleness
        / auth-failed state); an auth failure raises so the worker can flip the
        connection to ``auth_failed`` rather than silently returning an empty
        list that would soft-remove every cached item.

        Raises:
            ExternalSourceAuthError: 401/403 — token expired or revoked.
            ExternalSourceError: any other non-200 or a transport failure.
        """
        cfg = config or {}
        email = cfg.get("account_email", "").strip()
        jql = (cfg.get("jql") or "").strip() or _DEFAULT_JIRA_JQL
        origin = _jira_origin(base_url)
        query = urllib.parse.urlencode(
            {
                "jql": jql,
                "fields": "summary,status,duedate",
                "maxResults": str(_FETCH_PAGE_SIZE),
            }
        )
        try:
            response = http.get(
                f"{origin}/rest/api/3/search?{query}", headers=self._headers(email, secret)
            )
        except http.EgressBlocked as exc:
            raise ExternalSourceError(f"Jira host blocked by egress guard: {exc}") from exc
        except (http.EgressTimeout, http.EgressError) as exc:
            raise ExternalSourceError(f"Jira unreachable: {exc}") from exc

        if response.status in (401, 403):
            raise ExternalSourceAuthError("Jira rejected the credential (expired or revoked)")
        if response.status != 200:
            raise ExternalSourceError(f"Jira search returned HTTP {response.status}")

        payload = response.json()
        if not isinstance(payload, dict):
            raise ExternalSourceError("Jira search returned a non-JSON body")
        issues = payload.get("issues")
        if not isinstance(issues, list):
            return []
        return [self._issue_to_dto(origin, issue) for issue in issues if isinstance(issue, dict)]

    def _issue_to_dto(self, origin: str, issue: dict[str, Any]) -> ExternalWorkItemDTO:
        """Map one Jira issue JSON object to a sanitized DTO."""
        fields = _as_dict(issue.get("fields"))
        status = _as_dict(fields.get("status"))
        category = _as_dict(status.get("statusCategory"))
        bucket = _JIRA_CATEGORY_TO_BUCKET.get(str(category.get("key", "")).lower(), BUCKET_TODO)
        key = str(issue.get("key", ""))
        return ExternalWorkItemDTO(
            external_id=key,
            external_url=f"{origin}/browse/{urllib.parse.quote(key)}" if key else "",
            title=str(fields.get("summary", "")),
            external_status=str(status.get("name", "")),
            display_bucket=bucket,
            due_date=_parse_iso_date(fields.get("duedate")),
        ).sanitized()


def _as_dict(value: Any) -> dict[str, Any]:
    """Narrow an untrusted JSON value to a dict (empty if it is not one).

    Jira nests ``fields.status.statusCategory``; any level can be absent or a
    non-object in a malformed response. Coercing to ``{}`` keeps the mapping
    total without a cascade of ``isinstance`` guards at each ``.get`` site.
    """
    return value if isinstance(value, dict) else {}


def _parse_iso_date(value: Any) -> date | None:
    """Parse a Jira ``YYYY-MM-DD`` due date, tolerating null / bad shapes."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


class ExternalSourceError(Exception):
    """A source could not complete a read (transport, non-200, or bad body).

    The caller keeps the last-good cache and surfaces a staleness note
    (ADR-0097 §5) rather than wiping items on a transient failure.
    """


class ExternalSourceAuthError(ExternalSourceError):
    """The source rejected the credential (401/403).

    Distinct from :class:`ExternalSourceError` so the caller can short-circuit
    retries and flip the connection to ``auth_failed`` (ADR-0097 §5) instead of
    backing off and retrying a dead token.
    """


# ---------------------------------------------------------------------------
# Registry instance + OSS registration list
# ---------------------------------------------------------------------------

# Distinct from TASK_LINK_PROVIDERS (ADR-0097 §1) — do not merge the two.
EXTERNAL_TASK_SOURCES = ProviderRegistry("EXTERNAL_TASK_SOURCES", ExternalTaskSource)

# Registered against EXTERNAL_TASK_SOURCES in IntegrationsConfig.ready(). OSS
# owns ``jira`` here (read-only personal pull); Enterprise appends its own.
OSS_EXTERNAL_TASK_SOURCES: tuple[type[ExternalTaskSource], ...] = (JiraCloudSource,)


# Fields the field-length caps above were sized against, re-exported so the model
# module and tests assert against one source of truth rather than magic numbers.
EXTERNAL_WORK_ITEM_FIELD_CAPS: dict[str, int] = {
    "external_id": _MAX_EXTERNAL_ID,
    "title": _MAX_TITLE,
    "external_status": _MAX_STATUS,
    "external_url": _MAX_URL,
}
