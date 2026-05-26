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

from typing import Any, ClassVar

from . import http
from .registry import TaskLinkProvider, VerifyResult


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
        # URL-shape detection lands with #637 — the registry stub is enough
        # for #587's credentials viewset to validate the provider key.
        raise NotImplementedError("GitLab matches() lands with #637")

    def fetch_metadata(self, url: str, credential: Any) -> Any:
        raise NotImplementedError("GitLab fetch_metadata() lands with #637")

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
        raise NotImplementedError("GitHub matches() lands with #637")

    def fetch_metadata(self, url: str, credential: Any) -> Any:
        raise NotImplementedError("GitHub fetch_metadata() lands with #637")

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
        raise NotImplementedError("Generic matches() lands with #637")

    def fetch_metadata(self, url: str, credential: Any) -> Any:
        raise NotImplementedError("Generic fetch_metadata() lands with #637")


# Ordered list — apps.py iterates these in declaration order so the OSS
# registration order is deterministic for tests + the credentials list.
OSS_TASK_LINK_PROVIDERS: tuple[type[TaskLinkProvider], ...] = (
    GitLabTaskLinkProvider,
    GitHubTaskLinkProvider,
    GenericTaskLinkProvider,
)
