"""Inbound Git-webhook authentication + envelope parsing (#329, ADR-0158).

This module is the security boundary of the OSS Git-event board-card automation.
It has two jobs and nothing else:

1. **Verify the per-provider signature** against the project's plaintext secret —
   constant-time, before the payload is ever interpreted as a command. GitHub
   recomputes ``HMAC-SHA256`` over the *raw* request body; GitLab compares the
   ``X-Gitlab-Token`` header directly. A bad or missing signature is rejected with
   the receiver's uniform 404 (see :class:`WebhookSignatureError`).

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

from trueppm_api.core.constant_time import constant_time_equal

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

# ``GitWebhookEnvelope.ignored_reason`` value for a suppressed draft/WIP open.
_IGNORED_DRAFT = "draft"


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
    # Why an otherwise-actionable event resolved to ``event=None``. Empty for an
    # event we never act on (a push, a comment); ``"draft"`` when the payload was a
    # PR/MR *open* on a draft/WIP request, which deliberately does not promote the
    # card (#2882). Surfaced in the receiver's 200 body and the delivery record so
    # "why didn't my card move?" has an answer that is not "read the source".
    ignored_reason: str = ""


class WebhookSignatureError(Exception):
    """Raised when a webhook signature is missing or does not verify.

    Carries no provider/secret detail — the receiver maps it to the same bare 404 it
    returns for "no automation configured", so a caller genuinely cannot distinguish
    the two. It used to map to a 401, which *named* the distinction the 404 was
    written to hide: 401 meant enabled-with-a-secret, 404 meant not configured, and
    any project Viewer could read off admin-only state from a project UUID (#2881).
    The reason a delivery was rejected is not lost — it lands in the structured
    receiver log and on ``BoardAutomation.last_delivery_outcome``, both of which
    require the caller to already be an admin of that project.
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
        if not constant_time_equal(provided, expected):
            raise WebhookSignatureError("github signature mismatch")
        return

    if provider == PROVIDER_GITLAB:
        provided = headers.get("X-Gitlab-Token") or ""
        if not constant_time_equal(provided, secret_plaintext):
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


def _github_event(action: str, pr: Any, is_draft: bool) -> tuple[str | None, str]:
    """Resolve a GitHub ``pull_request`` action to ``(event, ignored_reason)``.

    Both halves are returned together because they are one decision: an action we
    act on yields an event and no reason, and a suppressed draft open yields no
    event *plus* the reason it was suppressed. Anything else is normal traffic we
    never act on — ``(None, "")``, with no reason to report.
    """
    if action in _GITHUB_OPEN_ACTIONS:
        if is_draft:
            return None, _IGNORED_DRAFT
        return GIT_EVENT_PR_OPENED, ""
    if action == "closed" and isinstance(pr, dict) and pr.get("merged") is True:
        # A merged PR is never a draft; merge always completes the card.
        return GIT_EVENT_PR_MERGED, ""
    return None, ""


def _parse_github(headers: Any, payload: dict[str, Any]) -> GitWebhookEnvelope:
    event_name = headers.get("X-GitHub-Event") or ""
    # X-GitHub-Delivery is a per-delivery UUID — the natural idempotency key.
    delivery_key = headers.get("X-GitHub-Delivery") or ""
    pr = payload.get("pull_request") if isinstance(payload, dict) else None
    pr_url = pr.get("html_url") if isinstance(pr, dict) else None
    action = payload.get("action") if isinstance(payload, dict) else None
    # GitHub marks a draft PR with ``pull_request.draft``. A draft opened to run CI
    # is not a request for review, and the forward-only rule means a card promoted
    # by mistake can never come back — so a draft open is deliberately inert and
    # the promotion happens on the ``ready_for_review`` action instead (#2882).
    is_draft = bool(pr.get("draft")) if isinstance(pr, dict) else False

    event: str | None = None
    ignored_reason = ""
    if event_name == "pull_request" and isinstance(action, str):
        event, ignored_reason = _github_event(action, pr, is_draft)

    return GitWebhookEnvelope(
        provider=PROVIDER_GITHUB,
        event=event,
        # Narrowed for the same reason the GitLab arm below narrows: a signed but
        # hostile/garbled payload can put any JSON type in ``html_url``, and every
        # consumer downstream (``_pr_key`` → ``urlparse``) assumes ``str`` —
        # ``html_url: 1`` raised AttributeError deep in the service (#2881 §3, the
        # #2795 container-vs-value class).
        pr_url=pr_url if isinstance(pr_url, str) else None,
        delivery_key=delivery_key,
        raw_event_name=event_name,
        ignored_reason=ignored_reason,
    )


def _parse_gitlab(payload: dict[str, Any]) -> GitWebhookEnvelope:
    object_kind = payload.get("object_kind") if isinstance(payload, dict) else None
    attrs = payload.get("object_attributes") if isinstance(payload, dict) else None
    attrs = attrs if isinstance(attrs, dict) else {}
    action = attrs.get("action")
    pr_url = attrs.get("url")
    # GitLab's draft flag is ``work_in_progress``; newer versions also send
    # ``draft``. Read both, exactly as the link-status parser at
    # ``providers.GitLabProvider`` already does (#2882).
    is_draft = bool(attrs.get("work_in_progress") or attrs.get("draft"))

    event: str | None = None
    ignored_reason = ""
    if object_kind == "merge_request" and isinstance(action, str):
        if action in _GITLAB_OPEN_ACTIONS:
            if is_draft:
                ignored_reason = _IGNORED_DRAFT
            else:
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
        ignored_reason=ignored_reason,
    )
