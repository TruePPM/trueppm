"""A dead SMTP relay must not report healthy (#2886).

These tests drive the **real drain** against a failing transport rather than
hand-writing the row state the card is supposed to detect. That distinction is the
point: the previous detector was mutually unsatisfiable *because* of what the drain
writes on a terminal failure, and a test that sets ``email_pending=True,
email_attempts=1, email_failed_at=<2h ago>`` by hand would have passed against it
forever. Only a test that lets the drain produce the state can tell whether the
predicate is reachable.
"""

from __future__ import annotations

from datetime import timedelta
from unittest import mock

import pytest
from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from trueppm_api.apps.notifications.models import (
    EmailTransportMode,
    Notification,
    WorkspaceEmailSettings,
)
from trueppm_api.apps.notifications.tasks import EMAIL_MAX_RETRIES, _do_drain_emails
from trueppm_api.apps.observability.selectors import (
    STATUS_CRIT,
    STATUS_OK,
    STATUS_WARN,
    notification_email_signals,
)

User = get_user_model()

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _recipient(username: str = "notif_user") -> object:
    return User.objects.create_user(
        username=username, email=f"{username}@example.com", password="pw"
    )


def _queued(recipient: object, count: int = 1, *, age_minutes: int = 30) -> list[Notification]:
    """Create ``count`` drainable notifications, aged past the orphan window."""
    created = timezone.now() - timedelta(minutes=age_minutes)
    rows = []
    for i in range(count):
        row = Notification.objects.create(
            recipient=recipient,
            event_type="task.assigned",
            subject=f"subject {i}",
            body="body",
            email_pending=True,
        )
        Notification.objects.filter(pk=row.pk).update(created_at=created)
        rows.append(row)
    return rows


def _dead_relay() -> object:
    """Patch the send path so every message fails, as a refusing relay would."""
    return mock.patch("django.core.mail.EmailMessage.send", side_effect=OSError("relay dead"))


def _card() -> dict[str, str]:
    from trueppm_api.apps.observability.selectors import _notification_card

    return _notification_card()


# ---------------------------------------------------------------------------
# The regression this issue is about
# ---------------------------------------------------------------------------


def test_a_dead_relay_is_detected_within_its_retry_budget() -> None:
    """The reproduction from #2886, inverted into an assertion.

    Recorded behavior before the fix: four drain ticks against a relay raising
    ``OSError`` left ``attempts=3, pending=False`` and the card reporting
    ``('Draining', 'ok')`` on every one of the four. The old predicate wanted
    ``email_pending=True`` *and* ``email_failed_at`` older than an hour, but the
    drain clears ``email_pending`` at attempt three (~90 s on a 30 s beat) and
    rewrote ``email_failed_at`` to ``now`` on every attempt — so it could only be
    satisfied if Beat itself had stopped, which ``TruePPMBeatStale`` already covers.
    """
    user = _recipient()
    _queued(user, count=3)

    with _dead_relay():
        for _ in range(EMAIL_MAX_RETRIES + 1):
            _do_drain_emails()

    # The row state the old detector could never see.
    assert (
        Notification.objects.filter(
            email_pending=False, email_sent_at__isnull=True, email_attempts=EMAIL_MAX_RETRIES
        ).count()
        == 3
    )

    signals = notification_email_signals()
    assert signals["failed_recent"] == 3
    assert signals["sent_recent"] == 0

    card = _card()
    assert card["status"] == STATUS_CRIT
    assert card["state_label"] == "Delivery failing"


def test_the_card_is_ok_when_mail_is_flowing() -> None:
    user = _recipient()
    _queued(user, count=2)
    _do_drain_emails()

    assert Notification.objects.filter(email_sent_at__isnull=False).count() == 2
    signals = notification_email_signals()
    assert signals == {
        "queued_aging": 0,
        "failed_recent": 0,
        "sent_recent": 2,
        "transport": "global",
    }
    assert _card()["status"] == STATUS_OK


def test_failures_alongside_deliveries_warn_rather_than_crit() -> None:
    """Some mail bouncing is a narrower problem than no mail getting out.

    ``crit`` is reserved for the dead-relay fingerprint — failures with zero
    deliveries in the same window — so a single undeliverable recipient does not page
    anyone at 3am.
    """
    user = _recipient()
    _queued(user, count=1)
    _do_drain_emails()  # one delivered

    _queued(_recipient("second_user"), count=1)
    with _dead_relay():
        for _ in range(EMAIL_MAX_RETRIES):
            _do_drain_emails()

    signals = notification_email_signals()
    assert signals["failed_recent"] == 1
    assert signals["sent_recent"] == 1
    card = _card()
    assert card["status"] == STATUS_WARN
    assert card["state_label"] == "1 failed"


def test_a_stale_failure_falls_out_of_the_window() -> None:
    """The window is rolling, so a resolved outage clears the card unattended."""
    user = _recipient()
    _queued(user, count=1)
    with _dead_relay():
        for _ in range(EMAIL_MAX_RETRIES):
            _do_drain_emails()
    assert notification_email_signals()["failed_recent"] == 1

    Notification.objects.update(email_failed_at=timezone.now() - timedelta(hours=3))
    assert notification_email_signals()["failed_recent"] == 0
    assert _card()["status"] == STATUS_OK


# ---------------------------------------------------------------------------
# The aging-backlog signal, and why its age field matters
# ---------------------------------------------------------------------------


def test_an_aging_queue_is_detected_even_with_zero_attempts() -> None:
    """Rows sitting pending with no attempt recorded is the drain-never-ran case.

    The old predicate required ``email_attempts > 0``, so a queue nothing had even
    tried to send was invisible to it.
    """
    user = _recipient()
    _queued(user, count=2, age_minutes=180)

    signals = notification_email_signals()
    assert signals["queued_aging"] == 2
    assert signals["failed_recent"] == 0
    card = _card()
    assert card["status"] == STATUS_WARN
    assert card["state_label"] == "2 queued"


def test_the_age_is_measured_on_a_field_no_code_path_rewrites() -> None:
    """``created_at`` cannot be reset out from under the comparison; the old
    ``email_failed_at`` was rewritten to ``now`` on every single failed attempt,
    which is precisely why an hour could never elapse on it while the relay was down.
    """
    user = _recipient()
    _queued(user, count=1, age_minutes=180)

    with _dead_relay():
        _do_drain_emails()  # one failed attempt: rewrites email_failed_at to now

    row = Notification.objects.get()
    assert row.email_attempts == 1
    assert row.email_pending is True
    # email_failed_at is now recent, but created_at is not — so the signal holds.
    assert row.email_failed_at > timezone.now() - timedelta(minutes=1)
    assert notification_email_signals()["queued_aging"] == 1


# ---------------------------------------------------------------------------
# Fail-closed transport: named directly, and no retries burned (#2886 item 2)
# ---------------------------------------------------------------------------


def _break_the_credential() -> WorkspaceEmailSettings:
    obj = WorkspaceEmailSettings.load()
    obj.transport_mode = EmailTransportMode.SMTP
    obj.host = "mail.corp.test"
    obj.username = "u"
    obj.password_ciphertext = b"not-a-valid-fernet-token"
    obj.save()
    return obj


def test_an_unusable_credential_is_reported_as_crit_immediately() -> None:
    """No row has to fail first — the signal is derived from committed state."""
    _break_the_credential()
    assert notification_email_signals()["transport"] == "undecryptable"
    card = _card()
    assert card["status"] == STATUS_CRIT
    assert card["state_label"] == "Credential unusable"


def test_an_unusable_credential_does_not_burn_the_rows_retries() -> None:
    """A configuration fault an operator fix clears must not discard notifications.

    Three drain ticks against an undecryptable credential leave the rows exactly as
    they were — pending, zero attempts — instead of exhausting their retry budget and
    permanently dropping the mail.
    """
    user = _recipient()
    _break_the_credential()
    _queued(user, count=2)

    for _ in range(3):
        _do_drain_emails()

    rows = list(Notification.objects.values("email_pending", "email_attempts"))
    assert rows == [{"email_pending": True, "email_attempts": 0}] * 2


# ---------------------------------------------------------------------------
# Prometheus exposition — the alerting coverage that did not exist at all
# ---------------------------------------------------------------------------


def test_email_metrics_endpoint_exposes_the_four_gauges() -> None:
    """Before #2886 no Prometheus rule in the chart mentioned email at all."""
    user = _recipient()
    _queued(user, count=1)
    with _dead_relay():
        for _ in range(EMAIL_MAX_RETRIES):
            _do_drain_emails()

    admin = User.objects.create_user(username="metrics_admin", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    resp = client.get(reverse("email-metrics"))

    assert resp.status_code == 200
    assert resp["Content-Type"].startswith("text/plain")
    body = resp.content.decode()
    assert "trueppm_email_sends_failed_recent 1" in body
    assert "trueppm_email_sends_delivered_recent 0" in body
    assert "trueppm_email_queue_aging 0" in body
    assert "trueppm_email_transport_unavailable 0" in body
    # Every gauge carries its HELP/TYPE preamble, or a scraper reports it untyped.
    assert body.count("# TYPE ") == 4


def test_email_metrics_flags_the_unusable_transport() -> None:
    _break_the_credential()
    admin = User.objects.create_user(username="metrics_admin2", password="pw", is_staff=True)
    client = APIClient()
    client.force_authenticate(user=admin)
    body = client.get(reverse("email-metrics")).content.decode()
    assert "trueppm_email_transport_unavailable 1" in body


def test_email_metrics_requires_staff() -> None:
    client = APIClient()
    assert client.get(reverse("email-metrics")).status_code in (401, 403)
    client.force_authenticate(user=_recipient("plain_user"))
    assert client.get(reverse("email-metrics")).status_code == 403
