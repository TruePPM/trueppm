"""Signal receivers for the notifications app (ADR-0075).

Mention → Notification fan-out is wired through explicit service functions called
from the comment viewset (the call site is reviewable and the transaction boundary
is obvious). This module is the documented home for *cross-app* receivers that
consume another app's supply-only signal — the seam ADR-0104 §3 / Amendment A.6
describe as "Enterprise connects a receiver in AppConfig.ready()". It is imported
once from ``NotificationsConfig.ready()``.
"""

from __future__ import annotations

from typing import Any

from django.dispatch import receiver

from trueppm_api.apps.projects.signals import team_signal_ceiling_proposal_changed


@receiver(
    team_signal_ceiling_proposal_changed,
    dispatch_uid="notifications.on_ceiling_proposal_changed",
)
def on_ceiling_proposal_changed(
    sender: Any,
    *,
    project_id: Any,
    signal_key: str,
    proposal_id: Any,
    status: str,
    **kwargs: Any,
) -> None:
    """Notify eligible voters when a signal ceiling-raise proposal opens / resolves.

    #1275 / ADR-0104 Amendment B — closes the discovery gap that left proposals
    expiring unratified because the team never saw them. The signal is supply-only
    and already ``transaction.on_commit``-deferred by ``_emit_proposal_changed``, so
    this runs post-commit and reads committed state; it fans out through the existing
    #639 rail (in-app row always, email only if the recipient opted in).

    Audience (the no-management-bypass boundary, ADR-0104 §A.2/§A.5): recipients are
    the **team voter roster only** (``team_member_user_ids`` = default-team
    membership), never a non-team project Admin/PM — the same roster that may read
    and vote on the signal, so the rail can't become the management back-door.

    - ``open``     → eligible voters **minus the proposer** (who already holds the
                     ``202 + proposal`` confirmation; self-notify is noise).
    - ``ratified`` / ``rejected`` / ``expired`` → eligible voters **plus the
                     proposer** (the most interested party in the outcome).
    - ``superseded`` → no notification: it is the §A.4 lower-then-raise internal
                     replacement, and the replacement proposal emits its own
                     ``open`` notice to the team.
    """
    from trueppm_api.apps.projects.models import (
        CeilingRaiseStatus,
        SignalCeilingRaiseProposal,
    )
    from trueppm_api.apps.teams.services import team_member_user_ids

    from .models import NotificationEventType
    from .services import create_event_notifications

    if status == CeilingRaiseStatus.OPEN:
        event_type = NotificationEventType.SIGNAL_CEILING_PROPOSAL_OPENED
    elif status in (
        CeilingRaiseStatus.RATIFIED,
        CeilingRaiseStatus.REJECTED,
        CeilingRaiseStatus.EXPIRED,
    ):
        event_type = NotificationEventType.SIGNAL_CEILING_PROPOSAL_RESOLVED
    else:
        # SUPERSEDED — see docstring. Nothing to deliver.
        return

    proposal = (
        SignalCeilingRaiseProposal.objects.filter(pk=proposal_id)
        .select_related("proposed_by")
        .first()
    )
    if proposal is None:
        # Deleted between emit and receive — best-effort delivery, nothing to send.
        return

    voter_ids = team_member_user_ids(project_id)
    proposer_id = proposal.proposed_by_id

    if status == CeilingRaiseStatus.OPEN:
        recipients = set(voter_ids)
        recipients.discard(proposer_id)
    else:
        recipients = set(voter_ids)
        if proposer_id is not None:
            recipients.add(proposer_id)

    if not recipients:
        return

    subject, body = _proposal_copy(proposal, status, signal_key)
    create_event_notifications(
        event_type=event_type,
        recipient_ids=list(recipients),
        subject=subject,
        body=body,
        project_id=str(project_id),
        # No task anchor — the web row routes these event types to the
        # signal-privacy settings section (web-rule 195) rather than a task.
        task_id=None,
    )


def _proposal_copy(proposal: Any, status: str, signal_key: str) -> tuple[str, str]:
    """Render the frozen subject/body for a ceiling-raise proposal notification.

    Copy carries only governance metadata every recipient can already see (which
    signal, the target visibility, the deadline / outcome) — never the gated signal
    value itself.
    """
    from trueppm_api.apps.projects.models import CeilingRaiseStatus, SignalAudience

    signal_label = signal_key.replace("_", " ")
    to_label = SignalAudience(proposal.to_ceiling).label

    if status == CeilingRaiseStatus.OPEN:
        deadline = proposal.expires_at.strftime("%b %d")
        subject = f"Vote: raise {signal_label} visibility to “{to_label}”"
        body = (
            f"Your team has an open proposal to widen the {signal_label} signal to "
            f"“{to_label}”. It needs a team majority to pass — vote by {deadline} or it "
            f"expires unratified. Review it in Settings → Signal privacy."
        )
        return subject, body

    outcome = {
        CeilingRaiseStatus.RATIFIED.value: "ratified — the new visibility is now in effect",
        CeilingRaiseStatus.REJECTED.value: "rejected — the visibility is unchanged",
        CeilingRaiseStatus.EXPIRED.value: "expired unratified — the visibility is unchanged",
    }[status]
    word = {
        CeilingRaiseStatus.RATIFIED.value: "ratified",
        CeilingRaiseStatus.REJECTED.value: "rejected",
        CeilingRaiseStatus.EXPIRED.value: "expired",
    }[status]
    subject = f"Proposal {word}: {signal_label} visibility"
    body = f"The proposal to widen the {signal_label} signal to “{to_label}” was {outcome}."
    return subject, body
