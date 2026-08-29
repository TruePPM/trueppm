"""``migrate`` serialized behind a PostgreSQL advisory lock (#3188).

The chart runs ``migrate`` as a **per-pod init container**, not as a
``pre-upgrade`` hook Job. At ``replicaCount: 1`` that is harmless; at 2 or more
every pod runs it concurrently against one database, and Django has no
concurrency control of its own — each process reads ``django_migrations``,
decides the same migration is unapplied, and both run it. The outcomes are a
duplicate-key error on the ``django_migrations`` insert, a lock timeout between
two concurrent ``ALTER TABLE``s, or a partially-applied DDL sequence, depending
on timing. All three surface as a crash-looping init container during a rollout,
which is the worst moment to be debugging schema state.

A session-level advisory lock is the cheap fix and needs no new infrastructure:
PostgreSQL already arbitrates it, the losers block rather than fail, and by the
time they acquire the lock the winner has finished so their own ``migrate`` is a
no-op. Advisory locks are also released automatically if the holder's connection
dies, so a killed init container cannot wedge the next rollout.

Deliberately a separate command rather than an override of ``migrate``: an
operator running ``manage.py migrate`` by hand should get Django's command with
Django's semantics, and a wrapper that silently changed it would be a surprise
in exactly the situation where surprises are expensive.
"""

from __future__ import annotations

import time
from typing import Any

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection

#: Arbitrary but FIXED 64-bit key. Every TruePPM process must use the same one or
#: the lock arbitrates nothing; it is namespaced by the database, so two
#: TruePPM installs on separate databases never contend. Derived by hand rather
#: than hashed from a string so it is stable across Python versions —
#: ``hash()`` is salted per process and would silently give each pod its own lock.
MIGRATION_ADVISORY_LOCK_KEY = 4_113_188_001


class Command(BaseCommand):
    help = "Run `migrate` while holding a PostgreSQL advisory lock (#3188)."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--lock-timeout",
            type=int,
            default=600,
            help=(
                "Seconds to wait for the lock before giving up. Must exceed the "
                "longest migration run, since every other pod waits out the "
                "winner. 0 waits forever."
            ),
        )

    def handle(self, *args: Any, **options: Any) -> None:
        if connection.vendor != "postgresql":
            # SQLite has no advisory locks, and a non-PostgreSQL backend is
            # necessarily a single-process dev setup where the race cannot occur.
            self.stdout.write("Not PostgreSQL — running migrate without a lock.")
            call_command("migrate", "--noinput")
            return

        timeout = int(options["lock_timeout"])
        deadline = time.monotonic() + timeout if timeout else None

        with connection.cursor() as cursor:
            acquired = False
            while not acquired:
                # try_advisory_lock, not advisory_lock: blocking inside the
                # database would hold the connection with no way to report
                # progress or honor --lock-timeout. Polling costs one cheap
                # round trip a second and keeps the timeout ours to enforce.
                cursor.execute("SELECT pg_try_advisory_lock(%s)", [MIGRATION_ADVISORY_LOCK_KEY])
                row = cursor.fetchone()
                acquired = bool(row and row[0])
                if acquired:
                    break
                if deadline is not None and time.monotonic() >= deadline:
                    raise CommandError(
                        f"Timed out after {timeout}s waiting for the migration "
                        "advisory lock. Another pod is still migrating, or a "
                        "previous run's connection is still open."
                    )
                self.stdout.write("Waiting for the migration advisory lock…")
                time.sleep(1)

            self.stdout.write(self.style.SUCCESS("Acquired the migration advisory lock."))
            try:
                call_command("migrate", "--noinput")
            finally:
                # Explicit unlock so a long-lived connection (the init container
                # exits right after, but tests and manual runs do not) does not
                # hold it until disconnect.
                cursor.execute("SELECT pg_advisory_unlock(%s)", [MIGRATION_ADVISORY_LOCK_KEY])
