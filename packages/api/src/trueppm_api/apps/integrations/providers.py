"""OSS ``TASK_LINK_PROVIDERS`` registrations (ADR-0049 §3).

Three providers are registered in 0.2 so the credentials viewset has a
known set of provider keys to validate against:

- ``gitlab`` — GitLab.com plus self-hosted via ``base_url``
- ``github`` — GitHub.com plus GitHub Enterprise Server via ``base_url``
- ``generic`` — fallback for any HTTP URL the user wants on a task

The ``matches()`` / ``fetch_metadata()`` implementations (URL host detection,
status fetch with 5-second SSRF-protected timeout) land with #637 — registry
membership is the only behavior 0.2 needs.

``verify_token()`` lands here with #677: GitLab and GitHub ping their ``/user``
endpoint through the SSRF-guarded :mod:`~trueppm_api.apps.integrations.http`
helper so a wrong / expired / wrong-host PAT is rejected at connect time rather
than silently accepted and discovered later by #637's status fetch. The generic
provider inherits the base class's no-op verifier (accepted, unverified).
"""

from __future__ import annotations

import re
from typing import Any, ClassVar, cast
from urllib.parse import quote, urlparse

from django.conf import settings

from . import http
from .encryption import decrypt_secret
from .registry import (
    LINK_STATUS_CLOSED,
    LINK_STATUS_DRAFT,
    LINK_STATUS_MERGED,
    LINK_STATUS_OPEN,
    LINK_STATUS_UNKNOWN,
    TASK_LINK_PROVIDERS,
    LinkMetadata,
    TaskLinkProvider,
    VerifyResult,
)


class BaseUrlNotAllowed(ValueError):
    """Raised when a credential's ``base_url`` host is not permitted for its
    provider (#902). The message is user-facing."""


# Per-provider SaaS hosts a ``base_url`` may target without operator opt-in.
# An empty base_url uses the provider's built-in SaaS default and is always
# allowed; any other host must be one of these, match the provider's self-hosted
# shape (Jira Cloud ``*.atlassian.net``), or be listed in the operator-set
# ``TRUEPPM_INTEGRATION_ALLOWED_HOSTS``.
_PROVIDER_DEFAULT_HOSTS: dict[str, frozenset[str]] = {
    "github": frozenset({"api.github.com", "github.com", "www.github.com"}),
    "gitlab": frozenset({"gitlab.com", "www.gitlab.com"}),
}


def assert_base_url_allowed(provider_key: str, base_url: str) -> None:
    """Reject a ``base_url`` host the provider must never ship its PAT to (#902).

    Without this, a user could register e.g. ``provider="github",
    base_url="https://attacker.example.com"`` — the github.com PAT is then sent
    in an ``Authorization`` header to the attacker host on the very first verify.
    The SSRF guard only blocks private/internal hosts; a public attacker host
    passes it. So restrict ``base_url`` to known SaaS hosts plus an
    operator-controlled allowlist for self-hosted GitHub Enterprise / GitLab CE.

    Raises:
        BaseUrlNotAllowed: the host is not permitted for ``provider_key``.
    """
    if not base_url:
        return
    # ``generic`` is a link-only provider — it stores no secret and sends no PAT,
    # so an arbitrary base_url carries no exfiltration risk.
    if provider_key == "generic":
        return
    host = (urlparse(base_url).hostname or "").lower()
    if not host:
        raise BaseUrlNotAllowed("Host URL must include a hostname.")
    operator_allow = {
        h.lower() for h in (getattr(settings, "TRUEPPM_INTEGRATION_ALLOWED_HOSTS", None) or [])
    }
    if host in operator_allow:
        return
    if provider_key == "jira":
        # Jira Cloud (ADR-0097): only the tenant's atlassian.net host.
        if host == "atlassian.net" or host.endswith(".atlassian.net"):
            return
    elif host in _PROVIDER_DEFAULT_HOSTS.get(provider_key, frozenset()):
        return
    raise BaseUrlNotAllowed(
        f"Host URL {host!r} is not an allowed host for the {provider_key!r} provider. "
        "A self-hosted instance must be added to TRUEPPM_INTEGRATION_ALLOWED_HOSTS by an operator."
    )


# GitLab resource segments that carry a fetchable open/closed/merged state.
# commit / tree (branch) URLs are valid links but have no such lifecycle, so
# they resolve to "unknown" without a fetch.
_GITLAB_KINDS = {"merge_requests", "issues"}


def _credential_secret(credential: Any) -> str | None:
    """Decrypt a credential's PAT, or return ``None`` if there is no credential."""
    if credential is None:
        return None
    return decrypt_secret(credential.secret_ciphertext)


def _verify_via_user_endpoint(
    plaintext: str,
    *,
    url: str,
    headers: dict[str, str],
    username_key: str,
) -> VerifyResult:
    """Ping a provider ``/user``-style endpoint and map the result to ``VerifyResult``.

    Shared by GitLab and GitHub — only the URL, auth header, and the JSON key
    that carries the account name differ. A 200 means the token authenticates;
    401/403 (or any other 4xx) means the token is wrong, expired, or scoped for
    a different host (a github.com PAT pasted into the gitlab slot fails its
    ``/user`` auth). 5xx and transport failures are reported as unreachable so
    the user can retry rather than assuming a dead token.
    """
    try:
        response = http.get(url, headers=headers)
    except http.EgressTimeout:
        return VerifyResult(ok=False, reason="provider_timeout")
    except http.EgressBlocked:
        return VerifyResult(ok=False, reason="blocked_host")
    except http.EgressError:
        return VerifyResult(ok=False, reason="provider_unreachable")

    if response.status == 200:
        payload = response.json()
        username = payload.get(username_key) if isinstance(payload, dict) else None
        # GitHub exposes granted scopes in a response header; GitLab does not on
        # /user, so scopes stays None there.
        raw_scopes = response.headers.get("x-oauth-scopes")
        scopes = (
            [s.strip() for s in raw_scopes.split(",") if s.strip()]
            if raw_scopes is not None
            else None
        )
        return VerifyResult(ok=True, username=username, scopes=scopes)
    if response.status >= 500:
        return VerifyResult(ok=False, reason="provider_unreachable")
    # 401 / 403 / 404 / other 4xx — the token did not authenticate.
    return VerifyResult(ok=False, reason="invalid_token")


class GitLabTaskLinkProvider(TaskLinkProvider):
    """GitLab task-link provider (gitlab.com + self-hosted)."""

    key: ClassVar[str] = "gitlab"
    label: ClassVar[str] = "GitLab"
    requires_credential: ClassVar[bool] = True

    @classmethod
    def matches(cls, url: str) -> bool:
        """Auto-detect gitlab.com links. Self-hosted hosts are matched by the
        viewset against the user's stored ``base_url`` (see ``resolve_provider_key``)."""
        host = (urlparse(url).hostname or "").lower()
        return host in ("gitlab.com", "www.gitlab.com")

    def fetch_metadata(self, url: str, credential: Any) -> LinkMetadata:
        secret = _credential_secret(credential)
        if secret is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        parsed = _parse_gitlab_url(url)
        if parsed is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        project_path, kind, ref = parsed
        base_url = getattr(credential, "base_url", "") or ""
        api_root = base_url.rstrip("/") if base_url else "https://gitlab.com"
        enc_path = quote(project_path, safe="")
        api_url = f"{api_root}/api/v4/projects/{enc_path}/{kind}/{ref}"
        payload = _fetch_json(api_url, {"PRIVATE-TOKEN": secret, "Accept": "application/json"})
        if payload is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        title = payload.get("title")
        if kind == "issues":
            status = LINK_STATUS_OPEN if payload.get("state") == "opened" else LINK_STATUS_CLOSED
            return LinkMetadata(status=status, title=title)
        # merge request
        state = payload.get("state")
        if state == "merged":
            status = LINK_STATUS_MERGED
        elif state in ("closed", "locked"):
            status = LINK_STATUS_CLOSED
        elif payload.get("draft") or payload.get("work_in_progress"):
            status = LINK_STATUS_DRAFT
        else:
            status = LINK_STATUS_OPEN
        return LinkMetadata(status=status, title=title)

    @classmethod
    def verify_token(cls, plaintext: str, *, base_url: str | None = None) -> VerifyResult:
        """Verify a GitLab PAT by calling ``GET /api/v4/user`` with it.

        GitLab authenticates PATs via the ``PRIVATE-TOKEN`` header. ``base_url``
        targets a self-hosted CE/EE instance; empty means gitlab.com.
        """
        api_root = base_url.rstrip("/") if base_url else "https://gitlab.com"
        return _verify_via_user_endpoint(
            plaintext,
            url=f"{api_root}/api/v4/user",
            headers={"PRIVATE-TOKEN": plaintext, "Accept": "application/json"},
            username_key="username",
        )


class GitHubTaskLinkProvider(TaskLinkProvider):
    """GitHub task-link provider (github.com + GitHub Enterprise Server)."""

    key: ClassVar[str] = "github"
    label: ClassVar[str] = "GitHub"
    requires_credential: ClassVar[bool] = True

    @classmethod
    def matches(cls, url: str) -> bool:
        """Auto-detect github.com links. GitHub Enterprise Server hosts are
        matched by the viewset against the user's stored ``base_url``."""
        host = (urlparse(url).hostname or "").lower()
        return host in ("github.com", "www.github.com")

    def fetch_metadata(self, url: str, credential: Any) -> LinkMetadata:
        secret = _credential_secret(credential)
        if secret is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        parsed = _parse_github_url(url)
        if parsed is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        owner, repo, kind, ref = parsed
        base_url = getattr(credential, "base_url", "") or ""
        api_root = f"{base_url.rstrip('/')}/api/v3" if base_url else "https://api.github.com"
        # GitHub's PR endpoint is /pulls/{n}; issues is /issues/{n}.
        api_kind = "pulls" if kind == "pull" else "issues"
        api_url = f"{api_root}/repos/{owner}/{repo}/{api_kind}/{ref}"
        payload = _fetch_json(
            api_url,
            {
                "Authorization": f"Bearer {secret}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        if payload is None:
            return LinkMetadata(status=LINK_STATUS_UNKNOWN)
        title = payload.get("title")
        if kind == "issues":
            status = LINK_STATUS_OPEN if payload.get("state") == "open" else LINK_STATUS_CLOSED
            return LinkMetadata(status=status, title=title)
        # pull request
        if payload.get("merged"):
            status = LINK_STATUS_MERGED
        elif payload.get("state") == "closed":
            status = LINK_STATUS_CLOSED
        elif payload.get("draft"):
            status = LINK_STATUS_DRAFT
        else:
            status = LINK_STATUS_OPEN
        return LinkMetadata(status=status, title=title)

    @classmethod
    def verify_token(cls, plaintext: str, *, base_url: str | None = None) -> VerifyResult:
        """Verify a GitHub PAT by calling ``GET /user`` with it.

        GitHub authenticates PATs via ``Authorization: Bearer``. github.com's
        API lives at ``api.github.com``; a GitHub Enterprise Server ``base_url``
        (``https://ghe.example.com``) serves its API under ``/api/v3``.
        """
        api_root = f"{base_url.rstrip('/')}/api/v3" if base_url else "https://api.github.com"
        return _verify_via_user_endpoint(
            plaintext,
            url=f"{api_root}/user",
            headers={
                "Authorization": f"Bearer {plaintext}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            username_key="login",
        )


class GenericTaskLinkProvider(TaskLinkProvider):
    """Fallback provider for any non-GitLab/GitHub URL pasted on a task.

    Credentials are still accepted for the generic provider so a user with
    a self-hosted Gitea or Forgejo instance can stash a PAT they will refer
    to when configuring the matching custom workflow.
    """

    key: ClassVar[str] = "generic"
    label: ClassVar[str] = "Generic"
    requires_credential: ClassVar[bool] = False

    @classmethod
    def matches(cls, url: str) -> bool:
        # Generic is the explicit fallback chosen by ``resolve_provider_key``
        # when nothing else matches — it never auto-matches a URL itself.
        return False

    def fetch_metadata(self, url: str, credential: Any) -> LinkMetadata:
        # No known API shape for an arbitrary host — the link is still useful
        # to humans, it just has no fetchable lifecycle status.
        return LinkMetadata(status=LINK_STATUS_UNKNOWN)


# Ordered list — apps.py iterates these in declaration order so the OSS
# registration order is deterministic for tests + the credentials list.
OSS_TASK_LINK_PROVIDERS: tuple[type[TaskLinkProvider], ...] = (
    GitLabTaskLinkProvider,
    GitHubTaskLinkProvider,
    GenericTaskLinkProvider,
)


# ---------------------------------------------------------------------------
# URL parsing + provider resolution
# ---------------------------------------------------------------------------

# GitHub: https://host/{owner}/{repo}/(pull|issues)/{number}
_GITHUB_RE = re.compile(r"^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?P<kind>pull|issues)/(?P<ref>\d+)")


def _parse_github_url(url: str) -> tuple[str, str, str, str] | None:
    """Parse a GitHub PR/issue URL into ``(owner, repo, kind, ref)``.

    ``kind`` is ``"pull"`` or ``"issues"``; commit/tree/other shapes return
    ``None`` (no fetchable status).
    """
    match = _GITHUB_RE.match(urlparse(url).path)
    if match is None:
        return None
    return (match["owner"], match["repo"], match["kind"], match["ref"])


def _parse_gitlab_url(url: str) -> tuple[str, str, str] | None:
    """Parse a GitLab MR/issue URL into ``(project_path, kind, ref)``.

    GitLab paths put the (possibly nested) project before a ``/-/`` separator,
    then ``merge_requests``/``issues`` and the IID, e.g.
    ``/group/sub/proj/-/merge_requests/42``. commit/tree/other return ``None``.
    """
    path = urlparse(url).path
    if "/-/" not in path:
        return None
    project_part, _, rest = path.partition("/-/")
    project_path = project_part.strip("/")
    segments = rest.strip("/").split("/")
    if len(segments) < 2 or not project_path:
        return None
    kind, ref = segments[0], segments[1]
    if kind not in _GITLAB_KINDS or not ref:
        return None
    return (project_path, kind, ref)


def _fetch_json(url: str, headers: dict[str, str]) -> dict[str, Any] | None:
    """SSRF-guarded GET that returns a parsed JSON object, or ``None`` on any
    failure (blocked host, timeout, transport error, non-200, non-object body).

    fetch_metadata never raises for an unreachable provider — a failed fetch
    leaves the link's cached status as "unknown" so the UI can prompt a retry.
    """
    try:
        response = http.get(url, headers=headers)
    except (http.EgressBlocked, http.EgressTimeout, http.EgressError):
        return None
    if response.status != 200:
        return None
    payload = response.json()
    return payload if isinstance(payload, dict) else None


def resolve_provider_key(url: str, *, user: Any) -> str:
    """Pick the provider key for ``url`` for the given user.

    Order: a SaaS host match from ``matches()`` (gitlab.com / github.com), then
    the user's connected self-hosted credentials (a link whose host equals a
    stored ``base_url`` host routes to that provider), then ``"generic"``. The
    self-hosted step is what lets a CE/EE or GHES URL fetch real status.
    """
    for key in TASK_LINK_PROVIDERS:
        handler = TASK_LINK_PROVIDERS.get(key)
        if handler is not None and cast("type[TaskLinkProvider]", handler).matches(url):
            return key
    host = (urlparse(url).hostname or "").lower()
    if host:
        # Lazy import to avoid a models import at app-load / registry time.
        from .models import IntegrationCredential

        for cred in IntegrationCredential.objects.filter(user=user).exclude(base_url=""):
            if (urlparse(cred.base_url).hostname or "").lower() == host:
                return cred.provider
    return "generic"
