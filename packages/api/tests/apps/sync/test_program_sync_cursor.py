"""The program delta cursor orders across independent programs (ADR-0747, #2498).

``UserProgramSyncView`` used to key on ``server_version`` — a per-row save counter —
while its watermark took the MAXIMUM of that counter across every program the caller
could see. A frequently-edited program therefore raised the checkpoint above every
other program's row counter, and those rows stopped being delivered. Permanently:
the cursor only moves forward.

That is data loss in a documented offline protocol, and it is the same shape #2491
fixed for projects — one level up, where ADR-0686's per-project sequence could not
reach because programs have no single owning row.

These tests are written against the *observable protocol*, not the allocator: each
one drives real pulls and asserts a row arrives. They would all pass against a
per-program cursor vector too, which is deliberate — they pin the guarantee, not
ADR-0747's particular way of getting it.
"""

from __future__ import annotations

import random
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Program

User = get_user_model()

URL = "/api/v1/sync/user/programs/"


@pytest.fixture
def user(db: object) -> Any:
    return User.objects.create_user(username="cursor_user", password="pw")


@pytest.fixture
def client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


def _program(user: Any, name: str) -> Program:
    """A program the user can see, with the membership that grants access."""
    program = Program.objects.create(name=name, description=f"Program {name}")
    ProgramMembership.objects.create(program=program, user=user, role=Role.ADMIN)
    return program


def _drain(client: APIClient, since: int = 0) -> tuple[dict[str, Any], int]:
    """Drain every page of one pull session; return (merged changes, next since).

    The watermark is pinned for a paging session (#2568), so the caller adopts the
    session's ``timestamp`` — not the last page's — as its next ``since``.
    """
    merged: dict[str, Any] = {}
    cursor: str | None = None
    timestamp = since
    while True:
        params = {"since": since}
        if cursor:
            params["cursor"] = cursor
        resp = client.get(URL, params)
        assert resp.status_code == 200, resp.data
        timestamp = resp.data["timestamp"]
        for collection, buckets in resp.data["changes"].items():
            dest = merged.setdefault(collection, {"created": [], "updated": [], "deleted": []})
            for bucket, rows in buckets.items():
                dest[bucket].extend(rows)
        cursor = resp.data.get("next_cursor")
        if not cursor:
            return merged, timestamp


def _ids(changes: dict[str, Any], collection: str) -> set[str]:
    bucket = changes.get(collection, {})
    return {str(row["id"]) for key in ("created", "updated") for row in bucket.get(key, [])} | {
        str(row) for row in bucket.get("deleted", [])
    }


@pytest.mark.django_db
def test_a_cold_program_survives_a_hot_program(client: APIClient, user: Any) -> None:
    """The core #2498 defect: a hot program's edits used to bury a cold one's.

    Acceptance criterion 1 — "a program edited once, after another accessible
    program is edited 100 times, is still delivered".
    """
    hot = _program(user, "Hot")
    cold = _program(user, "Cold")

    # Drain the initial state so both rows are behind the client's cursor.
    _, since = _drain(client)

    # The hot program races far ahead on its own save counter.
    for i in range(100):
        hot.description = f"edit {i}"
        hot.save()

    # DRAIN AGAIN — this is the step that arms the defect, and the reason this
    # test is not a one-liner. The old watermark was MAX(server_version) across the
    # caller's programs, so this pull pushed `since` up to the hot program's ~101.
    # Without this intermediate drain the cursor stays low, the cold edit clears it
    # on any implementation, and the test proves nothing.
    _, since = _drain(client, since)

    # One edit on the cold program, whose server_version is still ~2. Under the old
    # scheme `2 > 101` is false and this row was dropped for good.
    cold.description = "the edit that used to vanish"
    cold.save()

    changes, _ = _drain(client, since)

    assert str(cold.id) in _ids(changes, "programs"), (
        "the cold program's edit was dropped — a per-row counter was compared "
        "against a maximum taken across rows"
    )


@pytest.mark.django_db
def test_a_low_version_membership_role_change_is_delivered(client: APIClient, user: Any) -> None:
    """Acceptance criterion 2 — offline RBAC depends on this row arriving.

    A membership is written once at creation, so its ``server_version`` stays at
    the floor while programs churn above it. A client enforcing offline RBAC from
    a stale role is the concrete harm.
    """
    hot = _program(user, "Hot")
    quiet = _program(user, "Quiet")
    co_member = User.objects.create_user(username="co_member", password="pw")
    membership = ProgramMembership.objects.create(program=quiet, user=co_member, role=Role.VIEWER)

    _, since = _drain(client)

    for i in range(50):
        hot.description = f"edit {i}"
        hot.save()

    # Arm the defect: this pull raises the old MAX(server_version) watermark above
    # the membership's counter (see the cold-program test for why it is required).
    _, since = _drain(client, since)

    membership.role = Role.ADMIN
    membership.save()

    changes, _ = _drain(client, since)

    assert str(membership.id) in _ids(changes, "program_memberships"), (
        "a role change on a low-version membership never reached the client"
    )


@pytest.mark.django_db
def test_every_edit_across_interleaved_programs_lands_in_exactly_one_pull(
    client: APIClient, user: Any
) -> None:
    """Acceptance criterion 3 — the property test, over a seeded interleaving.

    N independent programs edited in arbitrary order, drained at arbitrary points.
    Every edit must appear in exactly one delta pull: never dropped (the #2498
    defect) and never redelivered forever (a checkpoint that fails to advance).

    The seed is fixed so a failure is reproducible — `Random(20260731)` rather than
    an unseeded source, which would make a red build unrepeatable.
    """
    rng = random.Random(20260731)
    programs = [_program(user, f"P{i}") for i in range(8)]

    _, since = _drain(client)

    expected_seen: set[str] = set()
    delivered: list[str] = []

    for step in range(60):
        target = rng.choice(programs)
        target.description = f"step {step}"
        target.save()
        expected_seen.add(str(target.id))

        # Drain at irregular intervals so pulls land mid-interleaving.
        if rng.random() < 0.3:
            changes, since = _drain(client, since)
            got = _ids(changes, "programs")
            delivered.extend(got)
            # Everything edited since the last drain must be here.
            assert expected_seen <= got, (
                f"step {step}: dropped {expected_seen - got} — "
                "edits fell below a checkpoint that outran them"
            )
            expected_seen.clear()

    # Final drain picks up whatever is outstanding.
    changes, since = _drain(client, since)
    got = _ids(changes, "programs")
    delivered.extend(got)
    assert expected_seen <= got, f"final drain dropped {expected_seen - got}"

    # The cursor must now be quiet: a checkpoint that never advances would
    # redeliver forever, which is the opposite failure and equally wrong.
    quiet_changes, _ = _drain(client, since)
    assert _ids(quiet_changes, "programs") == set(), (
        "rows redelivered after a full drain — the checkpoint is not advancing"
    )


@pytest.mark.django_db
def test_watermark_is_not_scoped_to_the_callers_programs(client: APIClient, user: Any) -> None:
    """The checkpoint is a property of the write log, not of the accessible set.

    Scoping it per caller is precisely what made it a maximum-over-many-rows. A
    program the caller cannot see still advances the sequence — and must not cause
    the caller to skip anything, because their own rows sit at their own positions.
    """
    mine = _program(user, "Mine")
    _, since = _drain(client)

    # A program in someone else's world churns.
    stranger = User.objects.create_user(username="stranger", password="pw")
    theirs = _program(stranger, "Theirs")
    for i in range(20):
        theirs.description = f"edit {i}"
        theirs.save()

    mine.description = "my one edit"
    mine.save()

    changes, _ = _drain(client, since)

    assert str(mine.id) in _ids(changes, "programs")
    assert str(theirs.id) not in _ids(changes, "programs"), "leaked a foreign program"


@pytest.mark.django_db
def test_a_fresh_client_still_receives_everything(client: APIClient, user: Any) -> None:
    """A cold start (`since=0`) must deliver the whole accessible set.

    Guards the backfill: rows seeded with a sync_seq must still be > 0, or a fresh
    client would silently receive nothing.
    """
    a = _program(user, "A")
    b = _program(user, "B")

    changes, timestamp = _drain(client, 0)

    assert {str(a.id), str(b.id)} <= _ids(changes, "programs")
    assert timestamp > 0, "watermark collapsed to 0 — the allocator was never seeded"
