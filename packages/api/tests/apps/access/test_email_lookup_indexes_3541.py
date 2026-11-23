"""Two more case-insensitive email lookups are index-served (#3541, following #3504).

Same shape as ``tests/apps/profiles/test_auth_user_email_upper_index.py``: assert
the plan, not the presence of an index. An index on the wrong expression is
exactly the defect here, and "an index exists" passes for it.

* ``ExternalStakeholder`` was indexed (its partial unique constraint on
  ``(program, Lower("email"))``) while the duplicate check used ``email__iexact``,
  which compiles to ``UPPER(...)`` and could never use it. The query was realigned
  to the constraint rather than adding a second index, so this test EXPLAINs the
  SQL the serializer *actually emits* — capturing it — rather than a hand-built
  copy that could keep passing after the serializer drifted back.
* ``WorkspaceInvite.email`` had no index; ``ix_invite_email_upper`` is a
  functional ``Upper("email")`` index declared in ``Meta.indexes``.

``enable_seqscan`` is off for each EXPLAIN because the tables hold a handful of
rows, where a sequential scan is genuinely cheaper and the planner would rightly
ignore any index. The narrower question asked is whether the index *can* serve the
predicate; one on the wrong expression cannot, and the plan stays a seq scan even
with the setting off. ``SET LOCAL`` scopes it to the test transaction.

``Resource.email`` is deliberately not covered: it stays unindexed (see #3541).
"""

from __future__ import annotations

import contextlib
import datetime

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import serializers

from trueppm_api.apps.access.models import ExternalStakeholder
from trueppm_api.apps.access.serializers import ExternalStakeholderSerializer
from trueppm_api.apps.projects.models import Program
from trueppm_api.apps.workspace.models import InviteStatus, Workspace, WorkspaceInvite

pytestmark = pytest.mark.django_db

_STAKEHOLDER_INDEX = "uniq_external_stakeholder_program_email_ci"
_INVITE_INDEX = "ix_invite_email_upper"


def _explain(sql: str, params: object = None) -> str:
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL enable_seqscan = off")
        cursor.execute(f"EXPLAIN {sql}", params)
        return "\n".join(row[0] for row in cursor.fetchall())


def _stakeholder_check_sql(program: Program, email: str) -> str:
    """The one ``access_external_stakeholder`` read ``validate_email`` issues."""
    serializer = ExternalStakeholderSerializer(context={"program_id": program.pk})
    # A duplicate refusal still issued the read, which is all this needs.
    with (
        CaptureQueriesContext(connection) as ctx,
        contextlib.suppress(serializers.ValidationError),
    ):
        serializer.validate_email(email)
    reads = [q["sql"] for q in ctx.captured_queries if "access_external_stakeholder" in q["sql"]]
    assert len(reads) == 1, reads
    return reads[0]


def test_stakeholder_duplicate_check_uses_the_lower_constraint_index() -> None:
    program = Program.objects.create(name="Idx probe")
    ExternalStakeholder.objects.create(program=program, name="A", email="Ana@Example.COM")

    sql = _stakeholder_check_sql(program, "ana@example.com")
    assert "LOWER(" in sql.upper(), sql
    plan = _explain(sql)
    assert _STAKEHOLDER_INDEX in plan, f"planner did not use {_STAKEHOLDER_INDEX}:\n{plan}"


def test_stakeholder_duplicate_check_still_matches_case_insensitively() -> None:
    program = Program.objects.create(name="Case probe")
    ExternalStakeholder.objects.create(program=program, name="A", email="Mixed.Case@Example.COM")
    serializer = ExternalStakeholderSerializer(context={"program_id": program.pk})

    with pytest.raises(serializers.ValidationError):
        serializer.validate_email("MIXED.case@example.com")
    # A soft-deleted row frees its email, exactly as the partial constraint does.
    ExternalStakeholder.objects.filter(program=program).update(is_deleted=True)
    assert serializer.validate_email("mixed.case@example.com") == "mixed.case@example.com"


def test_invite_email_upper_index_exists() -> None:
    with connection.cursor() as cursor:
        cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = %s", [_INVITE_INDEX])
        row = cursor.fetchone()
    assert row is not None, f"{_INVITE_INDEX} missing after migrate"
    assert "upper" in row[0].lower()
    assert "email" in row[0]


def test_pending_invite_lookup_uses_the_upper_index() -> None:
    """Several pending invites, so ``status`` is not the selective predicate.

    With one row, the planner rightly serves ``status = 'pending'`` from
    ``ix_invite_status`` and filters email after it, whatever indexes exist. With
    every row pending, only an index on the email expression narrows the scan —
    the shape of a real install, where the pending set is the whole table's
    interesting part. ``ANALYZE`` gives the planner the statistics to see that.
    """
    workspace = Workspace.load()
    expires = timezone.now() + datetime.timedelta(days=7)
    WorkspaceInvite.objects.bulk_create(
        WorkspaceInvite(
            workspace=workspace,
            email=f"Invitee{i}@Example.COM",
            token_hash=f"{i:064d}",
            expires_at=expires,
        )
        for i in range(300)
    )
    with connection.cursor() as cursor:
        cursor.execute("ANALYZE workspace_invite")
    # The exact predicate the invite-create view runs before minting an invite.
    qs = WorkspaceInvite.objects.filter(
        email__iexact="invitee7@example.com", status=InviteStatus.PENDING
    )
    assert qs.exists()
    sql, params = qs.only("id").query.sql_with_params()
    plan = _explain(sql, params)
    assert _INVITE_INDEX in plan, f"planner did not use {_INVITE_INDEX}:\n{plan}"
