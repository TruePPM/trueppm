"""OSS receivers on the agents app's own signals (#4814)."""

from __future__ import annotations

from typing import Any

from django.dispatch import receiver

from trueppm_api.apps.agents.signals import agent_action_recorded


@receiver(agent_action_recorded, dispatch_uid="agents.notify_refusal")
def notify_principal_of_refusal(sender: Any, action: Any = None, **kwargs: Any) -> None:
    """Refusal Inbox item for the agent's principal.

    ``agent_action_recorded`` is dispatched in ``on_commit`` through
    ``dispatch_extension_signal``, so this runs only once the refusal row is durable
    and a failure here is logged rather than raised into the request.
    """
    if action is None:
        return
    from trueppm_api.apps.agents.control import notify_refusal

    notify_refusal(action)
