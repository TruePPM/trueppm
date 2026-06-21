"""Inbound Git-webhook authentication + envelope parsing (#329, ADR-0158).

This module is the security boundary of the OSS Git-event board-card automation.
It has two jobs and nothing else:

1. **Verify the per-provider signature** against the project's plaintext secret —
   constant-time, before the payload is ever interpreted as a command. GitHub
   recomputes ``HMAC-SHA256`` over the *raw* request body; GitLab compares the
   ``X-Gitlab-Token`` header directly. A bad or missing signature is a hard 401.

2. **Normalize the payload** into a small :class:`GitWebhookEnvelope` — provider,
   forward-only event (``pr.opened`` / ``pr.merged`` / ``None`` = ignore), the
   PR/MR URL to match against a ``TaskLink``, and an idempotency ``delivery_key``.

It deliberately does **not** touch the database, mutate any task, or call out to
a provider — the receiver (``views.GitWebhookIngestView``) and the service
(``git_automation_services``) own that. Keeping verification pure and side-effect
free is what makes it cheap to test exhaustively (the bug class that matters here
is "signature accepted when it should not have been").
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Any

# Forward-only event vocabulary. Only these two map to a card move; every other
# Git event resolves to ``None`` and the receiver returns a 200 "ignored".
GIT_EVENT_PR_OPENED = "pr.opened"
GIT_EVENT_PR_MERGED = "pr.merged"

PROVIDER_GITHUB = "github"
PROVIDER_GITLAB = "gitlab"

# GitHub ``pull_request`` actions that mean "a review is now wanted". ``reopened``
# and ``ready_for_review`` are included so a draft promoted to ready, or a closed
# PR reopened, re-asserts the REVIEW intent (the forward-only guard still prevents
# moving a card backward).
_GITHUB_OPEN_ACTIONS = frozenset({"opened", "reopened", "ready_for_review"})
# GitLab ``merge_request`` actions with the same meaning.
_GITLAB_OPEN_ACTIONS = frozenset({"open", "reopen"})


@dataclass(frozen=True)
class GitWebhookEnvelope:
    """Provider-neutral view of a verified webhook, ready for matching."""

    provider: str
    # GIT_EVENT_PR_OPENED | GIT_EVENT_PR_MERGED | None (irrelevant event → ignore).
    event: str | None
    # The PR/MR URL to match against an existing TaskLink. None when the payload
    # carries no usable URL (then there is nothing to match and we 200-ignore).
    pr_url: str | None
    # Stable per-delivery key for Redis dedup. Always non-empty.
    delivery_key: str
    # The provider's own event name (for the "ignored" response and logging).
    raw_event_name: str


class WebhookSignatureError(Exception):
    """Raised when a webhook signature is missing or does not verify.

    Carries no provider/secret detail — the receiver maps it to a bare 401 so a
    caller cannot distinguish "wrong signature" from "no automation configured".
    """


def detect_provider(headers: Any) -> str | None:
    """Return ``"github"`` / ``"gitlab"`` from the request headers, or ``None``.

    Detection is by the provider's own event header, not a query param, so a
    caller cannot spoof the provider to pick a weaker verification path —
    each provider's branch only accepts its own signature header.
    """
    if headers.get("X-GitHub-Event"):
        return PROVIDER_GITHUB
    if headers.get("X-Gitlab-Event"):
        return PROVIDER_GITLAB
    return None


def verify_signature(
    provider: str,
    secret_plaintext: str,
    raw_body: bytes,
    headers: Any,
) -> None:
    """Verify the provider signature in constant time, or raise.

    GitHub: ``X-Hub-Signature-256`` must equal ``"sha256=" + HMAC_SHA256(secret,
    raw_body)``. The raw body (not the parsed dict) is hashed because re-encoding
    a parsed payload would not byte-match what the provider signed.

    GitLab: ``X-Gitlab-Token`` must equal the shared secret. GitLab sends the
    secret verbatim rather than an HMAC, so this is a direct constant-time compare.

    Raises:
        WebhookSignatureError: signature header absent, malformed, or mismatched.
            No secret bytes leak in the message.
    """
    if not secret_plaintext:
        # No secret configured → nothing can verify → treat as unauthenticated.
        raise WebhookSignatureError("no secret configured")

    if provider == PROVIDER_GITHUB:
        provided = headers.get("X-Hub-Signature-256") or ""
        digest = hmac.new(secret_plaintext.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        expected = f"sha256={digest}"
        if not hmac.compare_digest(provided, expected):
            raise WebhookSignatureError("github signature mismatch")
        return

    if provider == PROVIDER_GITLAB:
        provided = headers.get("X-Gitlab-Token") or ""
        if not hmac.compare_digest(provided, secret_plaintext):
            raise WebhookSignatureError("gitlab token mismatch")
        return

    raise WebhookSignatureError(f"unsupported provider {provider!r}")


def parse_envelope(provider: str, headers: Any, payload: Any) -> GitWebhookEnvelope:
    """Normalize a verified webhook into a :class:`GitWebhookEnvelope`.

    Never raises on an unrecognized event — an event we do not act on is normal
    traffic (the provider sends every configured event), so it resolves to
    ``event=None`` and the receiver returns 200. A malformed *body* (not a dict)
    is the caller's concern; this function assumes ``payload`` is a parsed object.
    """
    if provider == PROVIDER_GITHUB:
        return _parse_github(headers, payload)
    if provider == PROVIDER_GITLAB:
        return _parse_gitlab(payload)
    return GitWebhookEnvelope(
        provider=provider, event=None, pr_url=None, delivery_key="", raw_event_name=""
    )


def _parse_github(headers: Any, payload: dict[str, Any]) -> GitWebhookEnvelope:
    event_name = headers.get("X-GitHub-Event") or ""
    # X-GitHub-Delivery is a per-delivery UUID — the natural idempotency key.
    delivery_key = headers.get("X-GitHub-Delivery") or ""
    pr = payload.get("pull_request") if isinstance(payload, dict) else None
    pr_url = pr.get("html_url") if isinstance(pr, dict) else None
    action = payload.get("action") if isinstance(payload, dict) else None

    event: str | None = None
    if event_name == "pull_request" and isinstance(action, str):
        if action in _GITHUB_OPEN_ACTIONS:
            event = GIT_EVENT_PR_OPENED
        elif action == "closed" and isinstance(pr, dict) and pr.get("merged") is True:
            event = GIT_EVENT_PR_MERGED

    return GitWebhookEnvelope(
        provider=PROVIDER_GITHUB,
        event=event,
        pr_url=pr_url,
        delivery_key=delivery_key,
        raw_event_name=event_name,
    )


def _parse_gitlab(payload: dict[str, Any]) -> GitWebhookEnvelope:
    object_kind = payload.get("object_kind") if isinstance(payload, dict) else None
    attrs = payload.get("object_attributes") if isinstance(payload, dict) else None
    attrs = attrs if isinstance(attrs, dict) else {}
    action = attrs.get("action")
    pr_url = attrs.get("url")

    event: str | None = None
    if object_kind == "merge_request" and isinstance(action, str):
        if action in _GITLAB_OPEN_ACTIONS:
            event = GIT_EVENT_PR_OPENED
        elif action == "merge":
            event = GIT_EVENT_PR_MERGED

    # GitLab has no delivery header — derive a stable key from the MR identity and
    # action so a redelivery of the same state change dedups.
    delivery_key = f"{object_kind}:{attrs.get('id')}:{action}"

    return GitWebhookEnvelope(
        provider=PROVIDER_GITLAB,
        event=event,
        pr_url=pr_url if isinstance(pr_url, str) else None,
        delivery_key=delivery_key,
        raw_event_name=str(object_kind or ""),
    )
