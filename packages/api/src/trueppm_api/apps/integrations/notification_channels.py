"""OSS ``NOTIFICATION_CHANNELS`` registrations (ADR-0049 §1, ADR-0085 §2).

Two channels ship in OSS: ``in_app`` (the durable inbox row) and ``email``
(SMTP, opt-in). The registry's job is to (a) validate the ``channel`` field on
``NotificationPreference`` rows against a known key set, and (b) be the seam
Enterprise registers ``slack_dm`` / ``teams_dm`` / ``sms`` against without an
OSS migration.

OSS delivery does NOT go through ``handler.send()`` — fan-out is the bulk
``notifications/services.py::create_event_notifications`` path (in-app row +
``email_pending`` flag) drained by ``drain_notification_emails``. The ``send``
stubs therefore raise ``NotImplementedError``; they exist so the registry has a
concrete handler per key (mirrors the #637 ``TaskLinkProvider`` stubs). Enterprise
channels implement a real ``send``.
"""

from __future__ import annotations

from typing import Any, ClassVar

from .registry import NotificationChannel


class InAppNotificationChannel(NotificationChannel):
    """The in-app inbox channel — the durable Notification row."""

    key: ClassVar[str] = "in_app"
    label: ClassVar[str] = "In-app"

    def send(self, user: Any, event: Any) -> Any:
        raise NotImplementedError(
            "OSS in-app delivery is the Notification row created by "
            "create_event_notifications; the registry entry is for channel "
            "validation, not a per-event send."
        )


class EmailNotificationChannel(NotificationChannel):
    """The email channel — SMTP via the existing notification email drain."""

    key: ClassVar[str] = "email"
    label: ClassVar[str] = "Email"

    def send(self, user: Any, event: Any) -> Any:
        raise NotImplementedError(
            "OSS email delivery is the email_pending row drained by "
            "drain_notification_emails; the registry entry is for channel "
            "validation, not a per-event send."
        )


# Ordered tuple — apps.py iterates these in declaration order so OSS
# registration order is deterministic for tests + the preferences UI.
OSS_NOTIFICATION_CHANNELS: tuple[type[NotificationChannel], ...] = (
    InAppNotificationChannel,
    EmailNotificationChannel,
)
