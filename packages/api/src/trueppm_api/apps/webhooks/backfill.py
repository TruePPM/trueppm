"""Data-backfill helpers for the webhooks app migrations.

These functions are extracted from migration files so tests can import them
without coupling to migration file names, which break on squash (CLAUDE.md rule 3).
"""

from __future__ import annotations

from typing import Any


def backfill_sequence_numbers(apps: Any, schema_editor: Any) -> None:
    """Assign monotonic per-subscription sequence numbers to existing deliveries (#664).

    Orders deliveries by created_at (then id as a stable tie-break) so the
    historical sequence reflects the order deliveries were actually created.
    Persists the counter on the Webhook so new deliveries continue the sequence
    rather than restarting from 1.
    """
    Webhook = apps.get_model("webhooks", "Webhook")
    WebhookDelivery = apps.get_model("webhooks", "WebhookDelivery")

    for webhook in Webhook.objects.all():
        seq = 0
        # Order by created_at (then id as a stable tie-break) so the historical
        # sequence reflects the order deliveries were actually created.
        deliveries = WebhookDelivery.objects.filter(webhook=webhook).order_by("created_at", "id")
        for delivery in deliveries:
            seq += 1
            WebhookDelivery.objects.filter(pk=delivery.pk).update(sequence_number=seq)
        # Persist the counter so deliveries created after the migration continue
        # the same sequence rather than restarting from 1.
        if seq > 0:
            Webhook.objects.filter(pk=webhook.pk).update(delivery_sequence=seq)


def encrypt_webhook_secrets(apps: Any, schema_editor: Any) -> None:
    """Fernet-encrypt every existing plaintext ``Webhook.secret`` (#2885).

    Runs between the ``secret_ciphertext`` AddField and the ``secret`` RemoveField,
    so it is the only window in which both columns exist. A row whose secret is
    empty (impossible through the API, but the historical column was not
    constrained) is left with an empty ciphertext rather than crashing the
    migration — the delivery task refuses to sign with an empty key and records the
    delivery as a permanent failure, which surfaces the bad row to an operator
    instead of silently signing with ``b""``.

    Reads ``.iterator()`` rather than materializing the table: this runs inside the
    migration's transaction on a table that is unbounded in principle.
    """
    from trueppm_api.apps.integrations.encryption import encrypt_secret

    Webhook = apps.get_model("webhooks", "Webhook")
    for webhook in Webhook.objects.all().iterator(chunk_size=500):
        plaintext = webhook.secret or ""
        Webhook.objects.filter(pk=webhook.pk).update(
            secret_ciphertext=encrypt_secret(plaintext) if plaintext else b""
        )


def reverse_encrypt_webhook_secrets(apps: Any, schema_editor: Any) -> None:
    """Decrypt ciphertexts back into the plaintext column (migration reverse).

    Reversing re-creates the vulnerability the forward migration closed, so it
    exists only to keep the migration reversible for local development. A
    ciphertext that cannot be decrypted (the key was rotated) leaves the plaintext
    column empty rather than aborting the whole reverse.
    """
    from trueppm_api.apps.integrations.encryption import (
        CredentialEncryptionError,
        decrypt_secret,
    )

    Webhook = apps.get_model("webhooks", "Webhook")
    for webhook in Webhook.objects.all().iterator(chunk_size=500):
        if not webhook.secret_ciphertext:
            continue
        try:
            plaintext = decrypt_secret(bytes(webhook.secret_ciphertext))
        except CredentialEncryptionError:
            continue
        Webhook.objects.filter(pk=webhook.pk).update(secret=plaintext)


def reverse_backfill(apps: Any, schema_editor: Any) -> None:
    """Reset all sequence counters back to zero (migration reverse operation)."""
    Webhook = apps.get_model("webhooks", "Webhook")
    WebhookDelivery = apps.get_model("webhooks", "WebhookDelivery")
    WebhookDelivery.objects.all().update(sequence_number=0)
    Webhook.objects.all().update(delivery_sequence=0)
