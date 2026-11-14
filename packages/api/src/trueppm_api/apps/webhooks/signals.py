"""Extension signals for the webhooks app.

``webhook_auto_deactivated`` is the OSS extension point an Enterprise alerting or
integration-health feature registers against (#4962). OSS only emits; it knows
nothing about who listens.

Usage (Enterprise side, never imported by OSS)::

    # trueppm_enterprise/.../apps.py
    def ready(self):
        from trueppm_api.apps.webhooks.signals import webhook_auto_deactivated
        webhook_auto_deactivated.connect(alert_on_webhook_deactivation)
"""

from __future__ import annotations

import django.dispatch

# Sent once, after commit, when the failure guard deactivates a webhook
# (``Webhook.record_delivery_failure`` crossed both the failure count and the
# wall-clock floor, #2934). It is not sent when an admin deactivates a webhook, or for
# a webhook already inactive.
#
# Keyword arguments (identifiers and plain scalars, never the model instance):
#   sender          - the Webhook class
#   webhook_id      - str(UUID) of the webhook
#   project_id      - str(UUID) of the owning project, or None for a program webhook
#   program_id      - str(UUID) of the owning program, or None for a project webhook
#   reason          - the short, curated failure reason (already readable by a project
#                     Viewer on the webhook row; carries no URL, secret or host detail)
#   failure_count   - consecutive terminal failures at the moment of deactivation
#   deactivated_at  - ISO 8601 timestamp of the deactivation
#
# Dispatched with ``dispatch_extension_signal`` from ``transaction.on_commit``, so a
# receiver reads committed state and its exception cannot fail the delivery task.
# Exactly one of project_id / program_id is non-null (the Webhook XOR constraint).
webhook_auto_deactivated = django.dispatch.Signal()
