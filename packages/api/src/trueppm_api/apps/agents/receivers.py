"""OSS receivers on the agents app's own signals (#4814)."""

from __future__ import annotations

from typing import Any

from django.dispatch import receiver

from trueppm_api.apps.agents.signals import agent_action_recorded


@receiver(agent_action_recorded, dispatch_uid="agents.notify_refusal")
def notify_principal_of_refusal(sender: Any, action_id: str | None = None, **kwargs: Any) -> None:
    """Refusal Inbox item for the agent's principal.

    ``agent_action_recorded`` is dispatched in ``on_commit`` through
    ``dispatch_extension_signal``, so this runs only once the refusal row is durable
    and a failure here is logged rather than raised into the request. Binds
    ``action_id`` and re-reads the row, per the signal's contract: the ``action``
    instance kwarg is deprecated (#3807).
    """
    if not action_id:
        return
    from trueppm_api.apps.agents.control import notify_refusal
    from trueppm_api.apps.agents.models import AgentAction

    action = (
        AgentAction.objects.select_related("actor_token__owner", "refusal_detail")
        .filter(pk=action_id)
        .first()
    )
    if action is None:
        return
    notify_refusal(action)
