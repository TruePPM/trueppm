"""External integrations app (ADR-0049).

Owns ``IntegrationCredential`` (per-user PAT storage) and the three provider
registries — ``TASK_LINK_PROVIDERS``, ``OUTGOING_CHANNEL_PROVIDERS``,
``NOTIFICATION_CHANNELS`` — that Enterprise registers richer connectors
against at ``AppConfig.ready()``.

``TaskLink``, the outgoing webhook ``format`` field, and the email
notifications preference table all hang off this app's extension points and
ship in successor issues (#637 / #638 / #639).
"""

default_app_config = "trueppm_api.apps.integrations.apps.IntegrationsConfig"
