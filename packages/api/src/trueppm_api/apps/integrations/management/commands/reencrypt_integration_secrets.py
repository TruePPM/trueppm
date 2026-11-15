"""Re-encrypt every stored third-party secret under the primary Fernet key (#3406).

Run after promoting a new ``INTEGRATION_ENCRYPTION_KEY`` and moving the old one
into ``INTEGRATION_ENCRYPTION_KEY_FALLBACKS``. When the command reports zero
rows left to rewrite, the fallback can be dropped. Idempotent: a row that already
decrypts under the primary alone is left untouched.
"""

from __future__ import annotations

from typing import Any

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError, CommandParser
from django.db import models, transaction

from trueppm_api.apps.integrations.encryption import (
    CredentialEncryptionError,
    reencrypt_ciphertext,
)

# Every ciphertext column written by ``encryption.encrypt_secret``. A test
# (test_reencrypt_integration_secrets) fails if a new ``*_ciphertext`` BinaryField
# appears on any model without being listed here, so a future field cannot be
# silently stranded on a dropped key.
ENCRYPTED_FIELDS: tuple[tuple[str, str, str], ...] = (
    ("integrations", "IntegrationCredential", "secret_ciphertext"),
    ("integrations", "BoardAutomation", "secret_ciphertext"),
    ("sso", "SsoProviderPolicy", "secret_ciphertext"),
    ("webhooks", "Webhook", "secret_ciphertext"),
    ("notifications", "WorkspaceEmailSettings", "password_ciphertext"),
)


class Command(BaseCommand):
    help = (
        "Re-encrypt all stored integration/SSO/webhook/SMTP secrets under the primary "
        "INTEGRATION_ENCRYPTION_KEY so an old key in INTEGRATION_ENCRYPTION_KEY_FALLBACKS "
        "can be dropped. Idempotent; use --dry-run to count without writing."
    )

    def add_arguments(self, parser: CommandParser) -> None:
        parser.add_argument("--dry-run", action="store_true", help="Count; write nothing.")
        parser.add_argument("--batch-size", type=int, default=500, help="Rows per transaction.")

    def handle(self, *args: Any, **options: Any) -> None:
        dry_run: bool = options["dry_run"]
        batch_size: int = options["batch_size"]
        if batch_size < 1:
            raise CommandError("--batch-size must be >= 1")

        failed_total = 0
        for app_label, model_name, field in ENCRYPTED_FIELDS:
            model: type[models.Model] = apps.get_model(app_label, model_name)
            rewritten = current = skipped_empty = failed = 0
            pks = list(model._default_manager.order_by("pk").values_list("pk", flat=True))
            for start in range(0, len(pks), batch_size):
                chunk = pks[start : start + batch_size]
                with transaction.atomic():
                    rows = (
                        model._default_manager.select_for_update()
                        .filter(pk__in=chunk)
                        .order_by("pk")
                    )
                    for pk, blob in rows.values_list("pk", field):
                        if not blob:
                            skipped_empty += 1
                            continue
                        try:
                            new = reencrypt_ciphertext(blob)
                        except CredentialEncryptionError:
                            failed += 1
                            continue
                        if new is None:
                            current += 1
                            continue
                        if not dry_run:
                            model._default_manager.filter(pk=pk).update(**{field: new})
                        rewritten += 1
            failed_total += failed
            verb = "would rewrite" if dry_run else "rewrote"
            self.stdout.write(
                f"{model_name}.{field}: {verb} {rewritten}, already on primary {current}, "
                f"empty {skipped_empty}, undecryptable {failed}"
            )
        if failed_total:
            raise CommandError(
                f"{failed_total} value(s) could not be decrypted by the primary key or any "
                "fallback. Add the key they were written under to "
                "INTEGRATION_ENCRYPTION_KEY_FALLBACKS and re-run; do not drop any key yet."
            )
