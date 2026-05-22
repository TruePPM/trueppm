"""OSS ``TASK_LINK_PROVIDERS`` registrations (ADR-0049 §3).

Three providers are registered in 0.2 so the credentials viewset has a
known set of provider keys to validate against:

- ``gitlab`` — GitLab.com plus self-hosted via ``base_url``
- ``github`` — GitHub.com plus GitHub Enterprise Server via ``base_url``
- ``generic`` — fallback for any HTTP URL the user wants on a task

The ``matches()`` / ``fetch_metadata()`` implementations (URL host detection,
status fetch with 5-second SSRF-protected timeout) land with #637 — registry
membership is the only behavior 0.2 needs.
"""

from __future__ import annotations

from typing import Any, ClassVar

from .registry import TaskLinkProvider


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
