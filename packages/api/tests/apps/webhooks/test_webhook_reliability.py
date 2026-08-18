"""Delivery reliability, secret-at-rest, and signature tests (#2884, #2885).

Three defects converge on ``deliver_webhook``, so their tests live together:

- Every terminal failure branch returned without raising, and dead-letter
  recording keys on Celery permanent failure — so a permanently broken receiver
  produced no metric, no alert line, and no counter anywhere (#2884).
- A permanent 4xx took the identical retry path as a 5xx, and nothing ever
  deactivated a subscription, so a revoked receiver was retried forever (#2884).
- ``Webhook.secret`` was the only plaintext secret in the product, and the HMAC
  signed the body only, so a captured delivery verified forever (#2885).
"""

from __future__ import annotations

import hashlib
import hmac
import urllib.error
import urllib.request
from datetime import UTC, date
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.integrations.encryption import decrypt_secret
from trueppm_api.apps.projects.models import Calendar, Project
from trueppm_api.apps.scheduling.models import FailedTask, FailedTaskStatus
from trueppm_api.apps.webhooks import tasks as wh_tasks
from trueppm_api.apps.webhooks.backfill import (
    encrypt_webhook_secrets,
    reverse_encrypt_webhook_secrets,
)
from trueppm_api.apps.webhooks.models import (
    AUTO_DISABLE_CONSECUTIVE_FAILURES,
    DeliveryStatus,
    Webhook,
    WebhookDelivery,
)
from trueppm_api.apps.webhooks.tasks import deliver_webhook

User = get_user_model()

# A ≥32-char secret, matching the serializer floor (MIN_WEBHOOK_SECRET_LENGTH).
VALID_SECRET = "s" * 40

# The task's REGISTERED Celery name, read off the task rather than written out.
# FailedTask.task_name is a replay record — the dead-letter requeue action feeds it
# to current_app.send_task — so a hardcoded literal here would let a wrong
# production value pass its own test.
DELIVER_TASK_NAME = deliver_webhook.name


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="rel_user", password="pw")


@pytest.fixture
def calendar(db: object) -> Calendar:
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar: Calendar) -> Project:
    return Project.objects.create(name="RelProject", start_date=date(2026, 3, 1), calendar=calendar)


@pytest.fixture
def admin_client(user: Any, project: Project) -> APIClient:
    ProjectMembership.objects.create(project=project, user=user, role=Role.ADMIN)
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def webhook(project: Project, user: Any) -> Webhook:
    return Webhook.objects.create(
        project=project,
        url="https://example.com/hook",
        secret=VALID_SECRET,
        events=["task.created"],
        created_by=user,
    )


def _delivery(webhook: Webhook, event_type: str = "task.created") -> WebhookDelivery:
    return WebhookDelivery.objects.create(
        webhook=webhook,
        event_type=event_type,
        payload={"id": "t1", "name": "Pour"},
    )


def _respond(status_code: int) -> Any:
    """Return a ``_no_redirect_opener.open`` side effect answering ``status_code``."""

    def _open(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        if status_code >= 400:
            raise urllib.error.HTTPError(req.full_url, status_code, "err", {}, None)  # type: ignore[arg-type]
        resp = MagicMock()
        resp.status = status_code
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    return _open


def _deliver(delivery: WebhookDelivery, status_code: int) -> None:
    """Run one delivery attempt against a receiver answering ``status_code``."""
    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=_respond(status_code)),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))


# ---------------------------------------------------------------------------
# #2885 §1 — secret encrypted at rest
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_secret_is_not_stored_in_plaintext(webhook: Webhook) -> None:
    """The stored column is Fernet ciphertext; the plaintext round-trips via the property."""
    stored = bytes(
        Webhook.objects.filter(pk=webhook.pk).values_list("secret_ciphertext", flat=True)[0]
    )
    assert stored != b""
    assert VALID_SECRET.encode() not in stored
    assert decrypt_secret(stored) == VALID_SECRET
    # The property is the only read path, and it works on a fresh instance.
    assert Webhook.objects.get(pk=webhook.pk).secret == VALID_SECRET


@pytest.mark.django_db
def test_secret_column_is_gone_from_the_model() -> None:
    """There is no plaintext ``secret`` field left to dump (#2885)."""
    field_names = {f.name for f in Webhook._meta.get_fields()}
    assert "secret" not in field_names
    assert "secret_ciphertext" in field_names


@pytest.mark.django_db
def test_rotating_the_secret_overwrites_the_ciphertext(webhook: Webhook) -> None:
    webhook.secret = "r" * 40
    webhook.save(update_fields=["secret_ciphertext"])
    assert Webhook.objects.get(pk=webhook.pk).secret == "r" * 40


@pytest.mark.django_db
def test_secret_set_is_true_when_a_secret_is_stored(webhook: Webhook) -> None:
    assert webhook.secret_set is True
    bare = Webhook(project=webhook.project, url="https://x.example/h", events=["task.created"])
    assert bare.secret_set is False
    assert bare.secret == ""


class _FakeRow:
    """Stand-in for a historical ``Webhook`` row — the only state the backfill touches."""

    def __init__(self, pk: int, secret: str, secret_ciphertext: bytes = b"") -> None:
        self.pk = pk
        self.secret = secret
        self.secret_ciphertext = secret_ciphertext


class _FakeManager:
    def __init__(self, rows: dict[int, _FakeRow]) -> None:
        self.rows = rows

    def all(self) -> _FakeManager:
        return self

    def iterator(self, chunk_size: int = 500) -> Any:
        return iter(list(self.rows.values()))

    def filter(self, **kwargs: Any) -> Any:
        row = self.rows[kwargs["pk"]]

        class _Filtered:
            def update(self, **fields: Any) -> int:
                for key, value in fields.items():
                    setattr(row, key, value)
                return 1

        return _Filtered()


class _FakeApps:
    """Minimal ``apps`` double for a data-migration helper.

    The helper is exercised against this rather than the live registry because the
    historical model it runs on has **both** ``secret`` and ``secret_ciphertext``,
    a shape that by definition no longer exists once the migration has run. Testing
    the helper directly is the CLAUDE.md rule-3 alternative to importing the
    migration module, whose file name a squash deletes.
    """

    def __init__(self, rows: dict[int, _FakeRow]) -> None:
        self._manager = _FakeManager(rows)

    def get_model(self, app_label: str, model_name: str) -> Any:
        manager = self._manager
        return type("_FakeModel", (), {"objects": manager})


def test_migration_backfill_encrypts_every_plaintext_secret() -> None:
    """Every non-empty plaintext secret becomes decryptable ciphertext."""
    rows = {1: _FakeRow(1, VALID_SECRET), 2: _FakeRow(2, "another-secret-value-here-32char")}
    encrypt_webhook_secrets(_FakeApps(rows), None)

    assert decrypt_secret(rows[1].secret_ciphertext) == VALID_SECRET
    assert decrypt_secret(rows[2].secret_ciphertext) == "another-secret-value-here-32char"


def test_migration_backfill_leaves_an_empty_secret_empty() -> None:
    """An empty historical secret must not crash the migration or encrypt ``""``.

    ``encrypt_secret`` refuses empty input by design, so a row the historical
    (unconstrained) column left blank would have aborted the whole migration.
    """
    rows = {1: _FakeRow(1, "")}
    encrypt_webhook_secrets(_FakeApps(rows), None)
    assert rows[1].secret_ciphertext == b""


def test_migration_backfill_reverse_restores_the_plaintext() -> None:
    """The reverse operation decrypts back, so the migration stays reversible."""
    rows = {1: _FakeRow(1, VALID_SECRET)}
    encrypt_webhook_secrets(_FakeApps(rows), None)
    rows[1].secret = ""

    reverse_encrypt_webhook_secrets(_FakeApps(rows), None)
    assert rows[1].secret == VALID_SECRET


def test_migration_backfill_reverse_skips_an_undecryptable_row() -> None:
    """A ciphertext written under a rotated key must not abort the whole reverse."""
    rows = {1: _FakeRow(1, "", secret_ciphertext=b"not-a-fernet-token")}
    reverse_encrypt_webhook_secrets(_FakeApps(rows), None)
    assert rows[1].secret == ""


# ---------------------------------------------------------------------------
# #2885 §2 — timestamped signature
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_delivery_sends_a_timestamped_signature(webhook: Webhook) -> None:
    """X-TruePPM-Signature-V2 is ``t=<unix>,v1=<hmac over "t.body">`` (ADR-0837)."""
    delivery = _delivery(webhook)
    captured: list[urllib.request.Request] = []

    def capture(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    req = captured[0]
    body = req.data
    header = req.get_header("X-trueppm-signature-v2")
    assert header is not None
    timestamp_part, signature_part = header.split(",")
    assert timestamp_part.startswith("t=")
    assert signature_part.startswith("v1=")
    timestamp = timestamp_part.removeprefix("t=")

    expected = hmac.new(
        VALID_SECRET.encode(),
        timestamp.encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    assert signature_part.removeprefix("v1=") == expected


@pytest.mark.django_db
def test_legacy_signature_is_still_emitted(webhook: Webhook) -> None:
    """The 0.1–0.3 body-only recipe keeps verifying through the deprecation window.

    This is the compatibility half of ADR-0837: a receiver that only implements
    ``sha256=HMAC(secret, body)`` must not break when 0.4 lands.
    """
    delivery = _delivery(webhook)
    captured: list[urllib.request.Request] = []

    def capture(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    req = captured[0]
    legacy = hmac.new(VALID_SECRET.encode(), req.data, hashlib.sha256).hexdigest()
    assert req.get_header("X-trueppm-signature") == f"sha256={legacy}"


@pytest.mark.django_db
def test_signature_differs_between_attempts(webhook: Webhook) -> None:
    """The timestamp is per attempt, so a retry is never rejected as stale."""
    delivery = _delivery(webhook)
    captured: list[str] = []

    def capture(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        # `t` is read out of the signed header — it is the only place it is published.
        header = req.get_header("X-trueppm-signature-v2")
        assert header is not None
        captured.append(header.split(",")[0].removeprefix("t="))
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture),
        patch.object(wh_tasks.timezone, "now") as mock_now,
    ):
        from datetime import datetime

        mock_now.return_value = datetime(2026, 8, 17, 12, 0, 0, tzinfo=UTC)
        wh_tasks.deliver_webhook.run(str(delivery.pk))
        delivery.status = DeliveryStatus.PENDING
        delivery.save(update_fields=["status"])
        mock_now.return_value = datetime(2026, 8, 17, 12, 5, 0, tzinfo=UTC)
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    assert captured[0] != captured[1]
    assert int(captured[1]) - int(captured[0]) == 300


@pytest.mark.django_db
def test_no_standalone_timestamp_header_is_sent(webhook: Webhook) -> None:
    """The timestamp is published ONLY inside the signed header (ADR-0837).

    A convenience `X-TruePPM-Timestamp` copy would be unauthenticated, and a consumer
    bounding its replay window on it would gain nothing: an attacker replaying a
    capture edits that one header to "now", freshness passes, and the HMAC still
    verifies over the original `t` inside the signature. Shipping it would void the
    entire protection this change adds, so it must not exist.
    """
    delivery = _delivery(webhook)
    captured: list[urllib.request.Request] = []

    def capture(req: urllib.request.Request, **kwargs: object) -> MagicMock:
        captured.append(req)
        resp = MagicMock()
        resp.status = 200
        resp.__enter__ = lambda s: s
        resp.__exit__ = MagicMock(return_value=False)
        return resp

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open", side_effect=capture),
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    assert captured[0].get_header("X-trueppm-timestamp") is None


@pytest.mark.parametrize(
    ("ciphertext", "viewer_reason", "operator_reason"),
    [
        (b"", "No signing secret", "No signing secret"),
        (
            b"not-a-valid-fernet-token",
            "unusable — contact an administrator",
            "INTEGRATION_ENCRYPTION_KEY has changed",
        ),
    ],
    ids=["empty", "undecryptable"],
)
@pytest.mark.django_db
def test_unusable_secret_is_terminal_rather_than_an_unsigned_post(
    webhook: Webhook, ciphertext: bytes, viewer_reason: str, operator_reason: str
) -> None:
    """Both shapes of "the secret is unusable" fail terminally, and neither loops.

    The undecryptable case is the dangerous one: it is what a database restored
    without its INTEGRATION_ENCRYPTION_KEY produces, and letting the decryption error
    propagate would escape before ``attempt_count`` is incremented — leaving the row
    at (PENDING, attempt_count=0), which is precisely the selector the 30-second
    drain re-dispatches on. The purge only reclaims terminal rows, so it would loop
    forever while the API kept reporting the subscription healthy.
    """
    Webhook.objects.filter(pk=webhook.pk).update(secret_ciphertext=ciphertext)
    delivery = _delivery(webhook)

    with (
        patch.object(wh_tasks, "assert_url_allowed"),
        patch.object(wh_tasks._no_redirect_opener, "open") as mock_open,
    ):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    mock_open.assert_not_called()
    delivery.refresh_from_db()
    # Terminal, and out of the drain's (PENDING, attempt_count=0) selector.
    assert delivery.status == DeliveryStatus.FAILED
    assert delivery.attempt_count == 1
    # The dead-letter record (operator surface) carries the deployment detail...
    parked = FailedTask.objects.get(task_name=DELIVER_TASK_NAME)
    assert operator_reason in parked.exception_message
    # ...while last_failure_reason, which is readable at VIEWER level, does not.
    webhook.refresh_from_db()
    assert viewer_reason in webhook.last_failure_reason
    assert "INTEGRATION_ENCRYPTION_KEY" not in webhook.last_failure_reason


@pytest.mark.django_db
def test_dead_letter_row_can_actually_be_requeued(webhook: Webhook) -> None:
    """``FailedTask.task_name``/``args``/``kwargs`` are a REPLAY record, not labels.

    The dead-letter admin's requeue action feeds all three straight to
    ``current_app.send_task(...)``. A name that is not registered makes the requeue a
    silent no-op (``NotRegistered``, message dropped) and an arg set that does not
    bind raises ``TypeError`` in the worker — in both cases the endpoint answers 200
    and stamps the row ``RETRIED``, so the operator's remediation tool reports success
    on a guaranteed no-op. Asserting the literal string instead of this contract is
    what let a wrong name ship green.
    """
    import inspect

    from celery import current_app

    _deliver(_delivery(webhook), 404)
    parked = FailedTask.objects.get(task_name=DELIVER_TASK_NAME)

    assert parked.task_name in current_app.tasks, (
        f"{parked.task_name!r} is not a registered Celery task — a requeue would be dropped"
    )
    # Binds cleanly, so the replayed call reaches the task body.
    inspect.signature(deliver_webhook.run).bind(*parked.args, **parked.kwargs)


# ---------------------------------------------------------------------------
# #2884 §2 — permanent 4xx is not retried
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("status_code", [400, 401, 403, 404, 410, 422])
@pytest.mark.django_db
def test_permanent_4xx_is_terminal_after_one_attempt(webhook: Webhook, status_code: int) -> None:
    """A permanent client error fails immediately — no retry, no five-attempt burn."""
    delivery = _delivery(webhook)

    with patch.object(wh_tasks.deliver_webhook, "retry") as mock_retry:
        _deliver(delivery, status_code)

    mock_retry.assert_not_called()
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert delivery.attempt_count == 1
    assert delivery.response_status == status_code


@pytest.mark.parametrize("status_code", [408, 425, 429, 500, 502, 503])
@pytest.mark.django_db
def test_retryable_status_still_retries(webhook: Webhook, status_code: int) -> None:
    """5xx and the retryable 4xx set keep the existing backoff behavior."""
    delivery = _delivery(webhook)

    class _Retry(Exception):
        pass

    with (
        patch.object(wh_tasks.deliver_webhook, "retry", side_effect=_Retry()) as mock_retry,
        pytest.raises(_Retry),
    ):
        _deliver(delivery, status_code)

    mock_retry.assert_called_once()
    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.PENDING
    assert delivery.attempt_count == 1


# ---------------------------------------------------------------------------
# #2884 §1 — dead-letter recording
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_terminal_failure_is_dead_lettered(webhook: Webhook) -> None:
    """A permanently failed delivery lands in the dead-letter queue (#2884).

    This is the finding: every terminal branch marked the row FAILED and returned,
    so ``trueppm_task_dead_letter_parked`` stayed at zero regardless of how many
    deliveries died.
    """
    delivery = _delivery(webhook)
    _deliver(delivery, 404)

    parked = FailedTask.objects.get(task_name=DELIVER_TASK_NAME)
    assert parked.status == FailedTaskStatus.DEAD
    assert parked.exception_type == "WebhookDeliveryFailed"
    assert "404" in parked.exception_message
    assert parked.args == [str(delivery.pk)]
    assert parked.kwargs == {}
    assert str(webhook.pk) in parked.exception_message
    assert parked.project_id == webhook.project_id


@pytest.mark.django_db
def test_dead_letter_fires_the_permanent_failure_signal(webhook: Webhook) -> None:
    """The extension signal fires, which is what OSS alerting and Enterprise hang off."""
    from trueppm_api.apps.scheduling.signals import celery_task_permanently_failed

    seen: list[dict[str, Any]] = []

    def _receiver(sender: Any, **kwargs: Any) -> None:
        seen.append(kwargs)

    celery_task_permanently_failed.connect(_receiver)
    try:
        _deliver(_delivery(webhook), 410)
    finally:
        celery_task_permanently_failed.disconnect(_receiver)

    assert len(seen) == 1
    assert seen[0]["task_name"] == DELIVER_TASK_NAME


@pytest.mark.django_db
def test_ssrf_block_is_dead_lettered(webhook: Webhook) -> None:
    """The SSRF-blocked branch is terminal too, so it must park as well."""
    from trueppm_api.apps.integrations.http import EgressBlocked

    delivery = _delivery(webhook)
    with patch.object(wh_tasks, "assert_url_allowed", side_effect=EgressBlocked("private")):
        wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    parked = FailedTask.objects.get(task_name=DELIVER_TASK_NAME)
    assert "SSRF" in parked.exception_message


@pytest.mark.django_db
def test_ssrf_block_does_not_count_toward_auto_disable(webhook: Webhook) -> None:
    """An SSRF block is parked but must not be able to deactivate a subscription.

    ``assert_url_allowed`` re-resolves DNS on every delivery, so counting this branch
    would let anyone with influence over how the receiver's hostname resolves — a
    dynamic-DNS receiver, a poisoned resolver, a momentary RFC1918 answer — kill an
    admin's integration in five resolution windows.
    """
    from trueppm_api.apps.integrations.http import EgressBlocked

    with patch.object(wh_tasks, "assert_url_allowed", side_effect=EgressBlocked("private")):
        for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES + 2):
            wh_tasks.deliver_webhook.run(str(_delivery(webhook).pk))

    webhook.refresh_from_db()
    assert webhook.consecutive_failures == 0
    assert webhook.is_active is True
    # Still parked, so an operator can see it.
    assert FailedTask.objects.filter(task_name=DELIVER_TASK_NAME).exists()


@pytest.mark.django_db
def test_a_failing_test_ping_does_not_count_toward_auto_disable(webhook: Webhook) -> None:
    """The admin's own diagnostic tool must not be the trip wire.

    A test ping is a human probe, not production traffic. Counting it meant five
    clicks on "Test" against a broken receiver deactivated the subscription — the
    opposite of what a debugging affordance should do.
    """
    from trueppm_api.apps.webhooks.models import PING_EVENT_TYPE

    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES + 2):
        _deliver(_delivery(webhook, event_type=PING_EVENT_TYPE), 400)

    webhook.refresh_from_db()
    assert webhook.consecutive_failures == 0
    assert webhook.is_active is True
    # The failing ping is still recorded — the admin needs to see that it failed.
    assert FailedTask.objects.filter(task_name=DELIVER_TASK_NAME).exists()


@pytest.mark.django_db
def test_the_deactivating_failure_says_so_in_the_dead_letter_record(webhook: Webhook) -> None:
    """The last dead-letter record before the silence must explain the silence.

    Once a subscription is inactive, deliveries take the ``not is_active`` branch,
    which deliberately does not park anything — so the dead-letter stream, the only
    push signal an operator has, goes quiet at exactly the moment the integration
    dies. Without a marker on this record, "the alerts stopped" reads as "the
    receiver recovered".
    """
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES):
        _deliver(_delivery(webhook), 404)

    webhook.refresh_from_db()
    assert webhook.is_active is False
    messages = list(
        FailedTask.objects.filter(task_name=DELIVER_TASK_NAME).values_list(
            "exception_message", flat=True
        )
    )
    deactivation_notices = [m for m in messages if "SUBSCRIPTION DEACTIVATED" in m]
    # Exactly one — the failure that crossed the threshold, not every failure.
    assert len(deactivation_notices) == 1
    assert "re-enables it" in deactivation_notices[0]


@pytest.mark.django_db
def test_inactive_webhook_is_not_dead_lettered(webhook: Webhook) -> None:
    """A paused subscription is a deliberate state, not a failure worth alerting on."""
    webhook.is_active = False
    webhook.save(update_fields=["is_active"])
    delivery = _delivery(webhook)

    wh_tasks.deliver_webhook.run(str(delivery.pk))

    delivery.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert not FailedTask.objects.filter(task_name=DELIVER_TASK_NAME).exists()
    webhook.refresh_from_db()
    assert webhook.consecutive_failures == 0


# ---------------------------------------------------------------------------
# #2884 §2 — auto-disable
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_consecutive_failures_accumulate_and_auto_disable(webhook: Webhook) -> None:
    """After the threshold the subscription deactivates itself, with a reason."""
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES - 1):
        _deliver(_delivery(webhook), 404)
        webhook.refresh_from_db()
        assert webhook.is_active is True

    _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    assert webhook.consecutive_failures == AUTO_DISABLE_CONSECUTIVE_FAILURES
    assert webhook.is_active is False
    assert webhook.disabled_at is not None
    assert "consecutive failed deliveries" in webhook.disabled_reason
    assert "404" in webhook.last_failure_reason
    assert webhook.last_failure_at is not None


@pytest.mark.django_db
def test_success_resets_the_failure_counter(webhook: Webhook) -> None:
    """A receiver that recovers inside the threshold is never deactivated."""
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES - 1):
        _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    assert webhook.consecutive_failures == AUTO_DISABLE_CONSECUTIVE_FAILURES - 1

    _deliver(_delivery(webhook), 200)
    webhook.refresh_from_db()
    assert webhook.consecutive_failures == 0
    assert webhook.last_failure_at is None
    assert webhook.is_active is True

    # ...and the counter genuinely restarted, rather than sitting one below.
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES - 1):
        _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    assert webhook.is_active is True


@pytest.mark.django_db
def test_auto_disable_stamps_only_once(webhook: Webhook) -> None:
    """A webhook already given up on is not re-stamped by later failures."""
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES):
        _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    first_disabled_at = webhook.disabled_at

    _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    assert webhook.disabled_at == first_disabled_at


@pytest.mark.django_db
def test_exhausted_retries_count_as_one_failure(webhook: Webhook) -> None:
    """The guard counts terminal failures, not attempts.

    Five attempts of a *single* event must not trip a five-failure threshold on
    their own — otherwise one brief 5xx outage would deactivate the subscription.
    """
    delivery = _delivery(webhook)
    WebhookDelivery.objects.filter(pk=delivery.pk).update(attempt_count=4)
    delivery.refresh_from_db()

    _deliver(delivery, 503)

    delivery.refresh_from_db()
    webhook.refresh_from_db()
    assert delivery.status == DeliveryStatus.FAILED
    assert webhook.consecutive_failures == 1
    assert webhook.is_active is True


# ---------------------------------------------------------------------------
# #2884 — the API surfaces delivery health, and re-enabling clears it
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_list_surfaces_delivery_health(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    _deliver(_delivery(webhook), 404)
    resp = admin_client.get(f"/api/v1/projects/{project.pk}/webhooks/")
    assert resp.status_code == 200
    row = resp.data["results"][0]
    assert row["consecutive_failures"] == 1
    assert row["last_failure_at"] is not None
    assert "404" in row["last_failure_reason"]
    assert row["disabled_at"] is None
    # secret_set replaces any read path to the secret itself (#2885).
    assert row["secret_set"] is True
    assert "secret" not in row


@pytest.mark.django_db
def test_reactivating_clears_the_failure_record(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """An admin who fixes the receiver can actually get out of the disabled state."""
    for _ in range(AUTO_DISABLE_CONSECUTIVE_FAILURES):
        _deliver(_delivery(webhook), 404)
    webhook.refresh_from_db()
    assert webhook.is_active is False

    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"is_active": True},
        format="json",
    )
    assert resp.status_code == 200
    webhook.refresh_from_db()
    assert webhook.is_active is True
    assert webhook.consecutive_failures == 0
    assert webhook.disabled_at is None
    assert webhook.disabled_reason == ""
    assert webhook.last_failure_at is None


@pytest.mark.django_db
def test_health_fields_are_read_only(
    admin_client: APIClient, project: Project, webhook: Webhook
) -> None:
    """A client cannot fake a healthy webhook or erase the auto-disable record."""
    resp = admin_client.patch(
        f"/api/v1/projects/{project.pk}/webhooks/{webhook.pk}/",
        {"consecutive_failures": 99, "disabled_reason": "nope"},
        format="json",
    )
    assert resp.status_code == 200
    webhook.refresh_from_db()
    assert webhook.consecutive_failures == 0
    assert webhook.disabled_reason == ""
