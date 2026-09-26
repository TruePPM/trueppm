"""Project and program keys (ADR-1237, #4148).

Covers the four layers of the feature: the upgrade repair (tested through the
function the migration calls, never the migration module — migration rule 3),
the key service and the constraints behind it, the ``/resolve/`` endpoint and its
indistinguishable 404, and the ``/keys/`` suggestion endpoint.
"""

from __future__ import annotations

import copy
import uuid
from datetime import date
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.projects.authentication import TOKEN_PREFIX, sha256_hex
from trueppm_api.apps.projects.backfill import repair_object_keys
from trueppm_api.apps.projects.key_views import KeySuggestionView, ResolveView
from trueppm_api.apps.projects.keys import MAX_RETIRED_KEYS, MAX_SUFFIX_ATTEMPTS, base_key_for
from trueppm_api.apps.projects.keys import next_free_key as _next_free_key
from trueppm_api.apps.projects.models import (
    ApiToken,
    HistoricalProject,
    ObjectKey,
    ObjectKeySource,
    Program,
    Project,
    Risk,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.services import (
    KeyAssignmentError,
    assign_key,
    derive_key,
    release_keys_for_replace,
)

from .seed.test_importer import _seed

pytestmark = pytest.mark.django_db

User = get_user_model()

PROJECTS_URL = "/api/v1/projects/"
PROGRAMS_URL = "/api/v1/programs/"
RESOLVE_URL = "/api/v1/resolve/"
KEYS_URL = "/api/v1/keys/"


def _client(user: Any, token: Any = None) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user, token=token)
    return c


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="key-owner", email="key-owner@example.com")


@pytest.fixture
def outsider() -> Any:
    return User.objects.create_user(username="key-outsider", email="key-outsider@example.com")


def _project(owner: Any, name: str = "Platform", code: str = "", **extra: Any) -> Project:
    """A project created through the API, so it takes the real key path."""
    body: dict[str, Any] = {"name": name, "start_date": "2026-01-05", **extra}
    if code:
        body["code"] = code
    resp = _client(owner).post(PROJECTS_URL, body, format="json")
    assert resp.status_code == 201, resp.content
    return Project.objects.get(pk=resp.data["id"])


def _mint_project_token(project: Project, creator: Any) -> tuple[ApiToken, str]:
    """A real project-scoped ``ApiToken`` with a known raw value, for a genuine Bearer header.

    Mirrors ``test_inbound_task_sync.py``'s ``_mint_token`` — a token minted this
    way exercises the real ``ProjectApiTokenAuthentication`` path (unlike
    ``force_authenticate(token=...)``, which sets ``request.auth`` directly and
    never touches the authenticator that gates whether the token reaches the
    view at all).
    """
    import secrets

    raw = f"{TOKEN_PREFIX}{secrets.token_hex(32)}"
    token = ApiToken.objects.create(
        project=project,
        name="t",
        token_prefix=raw[len(TOKEN_PREFIX) : len(TOKEN_PREFIX) + 8],
        token_hash=sha256_hex(raw),
        created_by=creator,
    )
    return token, raw


def _bearer_client(raw_token: str) -> APIClient:
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {raw_token}")
    return client


def _raw_project(name: str, code: str = "", member: Any = None) -> Project:
    """A project written straight to the table, bypassing the key service."""
    project = Project.objects.create(name=name, start_date=date(2026, 1, 5), code=code)
    if member is not None:
        ProjectMembership.objects.create(project=project, user=member, role=Role.OWNER)
    return project


# ---------------------------------------------------------------------------
# Upgrade repair (the function the RunPython calls)
# ---------------------------------------------------------------------------


def _drop_code_constraint(model: Any) -> None:
    """Remove the unique ``code`` index for this test only, to stage pre-0.4 data.

    Duplicate codes are exactly what the repair exists to fix, and the constraint
    it precedes makes them impossible to insert. PostgreSQL DDL is transactional,
    so the test's own rollback restores the index.
    """
    from django.db import connection

    constraint = next(c for c in model._meta.constraints if c.name.endswith("_code_upper_uniq"))
    with connection.schema_editor() as editor:
        editor.remove_constraint(model, constraint)


class TestRepair:
    def _repair(self) -> list[Any]:
        return repair_object_keys(
            Project, Program, ObjectKey, historical_project_model=HistoricalProject
        )

    def test_blank_codes_are_derived(self) -> None:
        p = _raw_project("Platform Migration")
        rewritten = self._repair()
        p.refresh_from_db()
        assert p.code == "PM"
        row = ObjectKey.objects.get(project=p)
        assert row.is_current and row.source == ObjectKeySource.BACKFILL
        assert [(r.old_code, r.new_code) for r in rewritten] == [("", "PM")]

    def test_the_oldest_duplicate_keeps_its_code_and_the_rest_are_suffixed(self) -> None:
        # Program has created_at; the oldest row keeps the code.
        _drop_code_constraint(Program)
        oldest = Program.objects.create(name="A", code="plat")
        middle = Program.objects.create(name="B", code="PLAT")
        newest = Program.objects.create(name="C", code="Plat")
        self._repair()
        for p in (oldest, middle, newest):
            p.refresh_from_db()
        assert oldest.code == "plat"
        assert {middle.code, newest.code} == {"plat-2", "plat-3"}
        assert ObjectKey.objects.get(program=oldest).source == ObjectKeySource.USER
        assert ObjectKey.objects.get(program=middle).source == ObjectKeySource.BACKFILL

    def test_project_duplicates_are_suffixed_by_history_age(self) -> None:
        _drop_code_constraint(Project)
        first = _raw_project("One", code="PLAT")
        second = _raw_project("Two", code="plat")
        self._repair()
        first.refresh_from_db()
        second.refresh_from_db()
        assert (first.code, second.code) == ("PLAT", "PLAT2")

    def test_a_grandfathered_hyphenated_code_is_kept(self) -> None:
        p = _raw_project("Security", code="GA-SEC")
        assert self._repair() == []
        p.refresh_from_db()
        assert p.code == "GA-SEC"
        assert ObjectKey.objects.get(project=p).key == "GA-SEC"

    def test_a_derived_key_never_takes_a_kept_code(self) -> None:
        # "Platform Migration" derives PM, which a later row already holds.
        blank = _raw_project("Platform Migration")
        kept = _raw_project("Other", code="PM")
        self._repair()
        blank.refresh_from_db()
        kept.refresh_from_db()
        assert kept.code == "PM"
        assert blank.code == "PM2"

    def test_the_repair_is_idempotent(self) -> None:
        _raw_project("Platform")
        self._repair()
        count = ObjectKey.objects.count()
        assert self._repair() == []
        assert ObjectKey.objects.count() == count

    def test_after_the_repair_the_constraint_holds(self) -> None:
        _raw_project("One", code="DUP")
        with pytest.raises(IntegrityError), transaction.atomic():
            _raw_project("Two", code="dup")


class TestCreationOrder:
    """``_creation_order`` (perf-check Low): prefer the indexed ``history_type="+"``
    row, falling back to ``Min(history_date)`` only for a project that has none.
    """

    def test_prefers_the_creation_row(self) -> None:
        from trueppm_api.apps.projects.backfill import _creation_order

        p = _raw_project("Alpha")
        plus_row = HistoricalProject.objects.get(id=p.pk, history_type="+")
        order = _creation_order(Project, HistoricalProject)
        assert order[p.pk] == plus_row.history_date

    def test_falls_back_to_min_history_date_with_no_creation_row(self) -> None:
        """A project whose ``+`` row is gone (older-than-history-tracking data, or
        a squashed/rebuilt history table) still gets an order, from whatever
        history it does have.
        """
        from trueppm_api.apps.projects.backfill import _creation_order

        p = _raw_project("Alpha")
        p.name = "Alpha Renamed"
        p.save(update_fields=["name"])  # a "~" row, so one remains after the delete below
        HistoricalProject.objects.filter(id=p.pk, history_type="+").delete()
        remaining = HistoricalProject.objects.get(id=p.pk)
        order = _creation_order(Project, HistoricalProject)
        assert order[p.pk] == remaining.history_date

    def test_mixed_batch_uses_each_projects_best_available_order(self) -> None:
        """A project with a ``+`` row and one without are ordered correctly
        against each other in the same call — the fallback query must not
        clobber or ignore the indexed-path results.
        """
        from trueppm_api.apps.projects.backfill import _creation_order

        with_plus = _raw_project("HasPlus")
        without_plus = _raw_project("NoPlus")
        without_plus.name = "NoPlus Renamed"
        without_plus.save(update_fields=["name"])
        HistoricalProject.objects.filter(id=without_plus.pk, history_type="+").delete()

        order = _creation_order(Project, HistoricalProject)
        assert (
            order[with_plus.pk]
            == HistoricalProject.objects.get(id=with_plus.pk, history_type="+").history_date
        )
        no_plus_row = HistoricalProject.objects.get(id=without_plus.pk)
        assert order[without_plus.pk] == no_plus_row.history_date


# ---------------------------------------------------------------------------
# Pure derivation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "kind", "base"),
    [
        ("Platform", "project", "PLAT"),
        ("Platform Migration", "project", "PM"),
        ("2026 Launch", "project", "P2L"),
        ("Ünïcode Ops", "project", "UO"),
        ("!!!", "project", "PROJ"),
        ("Atlas Platform Launch", "program", "atlas-platform-launch"),
        ("   ", "program", "program"),
    ],
)
def test_base_key_for(name: str, kind: str, base: str) -> None:
    assert base_key_for(name, kind) == base


# ---------------------------------------------------------------------------
# Service + constraints through the API
# ---------------------------------------------------------------------------


class TestCreateAndRename:
    def test_omitted_code_is_derived_on_create(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        assert p.code == "PLAT"
        assert ObjectKey.objects.get(project=p).source == ObjectKeySource.DERIVED

    def test_blank_code_is_derived_and_a_collision_suffixed(self, owner: Any) -> None:
        _project(owner, "Platform")
        second = _project(owner, "Platform", code="")
        assert second.code == "PLAT2"

    def test_a_typed_code_is_recorded_as_user(self, owner: Any) -> None:
        p = _project(owner, "Anything", code="acme")
        assert p.code == "ACME"
        assert ObjectKey.objects.get(project=p).source == ObjectKeySource.USER

    def test_a_program_create_derives_a_slug(self, owner: Any) -> None:
        resp = _client(owner).post(
            PROGRAMS_URL, {"name": "Atlas Platform Launch", "methodology": "HYBRID"}, format="json"
        )
        assert resp.status_code == 201, resp.content
        assert resp.data["code"] == "atlas-platform-launch"

    def test_a_taken_key_is_a_400_that_never_names_the_holder(
        self, owner: Any, outsider: Any
    ) -> None:
        hidden = _project(outsider, "Secret Merger", code="ACME")
        resp = _client(owner).post(
            PROJECTS_URL,
            {"name": "Mine", "start_date": "2026-01-05", "code": "acme"},
            format="json",
        )
        assert resp.status_code == 400
        assert resp.data["code"] == ["This key is already in use."]
        assert hidden.name not in str(resp.data)
        assert str(hidden.pk) not in str(resp.data)

    def test_uniqueness_spans_retired_keys(self, owner: Any) -> None:
        a = _project(owner, "Alpha", code="ALPHA")
        r = _client(owner).patch(f"{PROJECTS_URL}{a.pk}/", {"code": "ALPHA2"}, format="json")
        assert r.status_code == 200, r.content
        # ALPHA is retired, still A's, and nobody else may take it.
        resp = _client(owner).post(
            PROJECTS_URL, {"name": "B", "start_date": "2026-01-05", "code": "alpha"}, format="json"
        )
        assert resp.status_code == 400
        assert ObjectKey.objects.get(key="ALPHA").is_current is False

    def test_renaming_back_reclaims_the_retired_key(self, owner: Any) -> None:
        a = _project(owner, "Alpha", code="ALPHA")
        client = _client(owner)
        assert (
            client.patch(f"{PROJECTS_URL}{a.pk}/", {"code": "BETA"}, format="json").status_code
            == 200
        )
        r = client.patch(f"{PROJECTS_URL}{a.pk}/", {"code": "ALPHA"}, format="json")
        assert r.status_code == 200, r.content
        assert ObjectKey.objects.filter(project=a).count() == 2
        assert ObjectKey.objects.get(project=a, is_current=True).key == "ALPHA"

    def test_a_rename_is_one_save(self, owner: Any) -> None:
        a = _project(owner, "Alpha", code="ALPHA")
        before = a.history.count()
        _client(owner).patch(f"{PROJECTS_URL}{a.pk}/", {"code": "GAMMA"}, format="json")
        assert a.history.count() == before + 1

    def test_the_retired_key_cap(self, owner: Any) -> None:
        a = _project(owner, "Alpha", code="K0")
        client = _client(owner)
        for i in range(1, MAX_RETIRED_KEYS + 1):
            r = client.patch(f"{PROJECTS_URL}{a.pk}/", {"code": f"K{i}"}, format="json")
            assert r.status_code == 200, (i, r.content)
        r = client.patch(f"{PROJECTS_URL}{a.pk}/", {"code": "KNEW"}, format="json")
        assert r.status_code == 400
        assert "changed 10 times" in r.data["code"][0]
        detail = client.get(f"{PROJECTS_URL}{a.pk}/")
        assert detail.data["retired_key_count"] == MAX_RETIRED_KEYS

    def test_a_purged_projects_key_is_never_reused(self, owner: Any) -> None:
        a = _project(owner, "Alpha", code="GONE")
        ProjectMembership.objects.filter(project=a).delete()
        Project.objects.filter(pk=a.pk).delete()
        tomb = ObjectKey.objects.get(key="GONE")
        assert tomb.project_id is None
        resp = _client(owner).post(
            PROJECTS_URL, {"name": "New", "start_date": "2026-01-05", "code": "GONE"}, format="json"
        )
        assert resp.status_code == 400
        assert derive_key("Gone", "project") != "GONE"

    def test_a_grandfathered_code_survives_an_unrelated_patch(self, owner: Any) -> None:
        p = _raw_project("Security", code="GA-SEC", member=owner)
        repair_object_keys(Project, Program, ObjectKey)
        r = _client(owner).patch(
            f"{PROJECTS_URL}{p.pk}/", {"code": "GA-SEC", "name": "Security 2"}, format="json"
        )
        assert r.status_code == 200, r.content
        p.refresh_from_db()
        assert p.code == "GA-SEC"
        assert ObjectKey.objects.filter(project=p).count() == 1

    def test_a_new_hyphenated_code_is_refused(self, owner: Any) -> None:
        p = _project(owner, "Alpha")
        r = _client(owner).patch(f"{PROJECTS_URL}{p.pk}/", {"code": "GA-NEW"}, format="json")
        assert r.status_code == 400

    @pytest.mark.parametrize("word", ["new", "NEW", "settings", "Trash"])
    def test_reserved_words_are_refused(self, owner: Any, word: str) -> None:
        resp = _client(owner).post(
            PROGRAMS_URL, {"name": "X", "methodology": "HYBRID", "code": word}, format="json"
        )
        assert resp.status_code == 400
        assert resp.data["code"] == ["That word is reserved."]

    def test_a_uuid_shaped_program_key_is_refused(self, owner: Any) -> None:
        resp = _client(owner).post(
            PROGRAMS_URL,
            {"name": "X", "methodology": "HYBRID", "code": str(uuid.uuid4())},
            format="json",
        )
        assert resp.status_code == 400

    def test_program_keys_are_case_insensitive(self, owner: Any) -> None:
        client = _client(owner)
        r1 = client.post(
            PROGRAMS_URL, {"name": "A", "methodology": "HYBRID", "code": "ops"}, format="json"
        )
        assert r1.status_code == 201
        r2 = client.post(
            PROGRAMS_URL, {"name": "B", "methodology": "HYBRID", "code": "OPS"}, format="json"
        )
        assert r2.status_code == 400

    def test_assign_key_is_a_no_op_when_current(self, owner: Any) -> None:
        p = _project(owner, "Alpha", code="ALPHA")
        row = ObjectKey.objects.get(project=p)
        assert assign_key(p, "alpha", source=ObjectKeySource.USER).pk == row.pk
        assert ObjectKey.objects.filter(project=p).count() == 1

    def test_assign_key_refuses_a_taken_key(self, owner: Any) -> None:
        _project(owner, "Alpha", code="ALPHA")
        other = _project(owner, "Beta", code="BETA")
        with pytest.raises(KeyAssignmentError):
            assign_key(other, "ALPHA", source=ObjectKeySource.USER)

    def test_scheduler_cannot_change_a_project_key(self, owner: Any) -> None:
        """``code`` inherits the PATCH endpoint's existing permission gate (ADR-1237
        §3) — it is not in ``_SCHEDULER_WRITABLE_FIELDS``, so a sub-Admin Scheduler
        is rejected exactly like any other Admin-only field (rbac-check Low).
        Mirrors ``test_project_lead.py::test_scheduler_cannot_set_lead``.
        """
        p = _project(owner, "Alpha", code="ALPHA")
        sched = User.objects.create_user(username="sched-alpha", email="sched-alpha@example.com")
        ProjectMembership.objects.create(project=p, user=sched, role=Role.SCHEDULER)
        resp = _client(sched).patch(f"{PROJECTS_URL}{p.pk}/", {"code": "NEWKEY"}, format="json")
        assert resp.status_code == 400
        assert "Project Manager role" in str(resp.data)
        p.refresh_from_db()
        assert p.code == "ALPHA"
        assert ObjectKey.objects.filter(project=p).count() == 1

    def test_assign_key_heals_a_keyless_project(self) -> None:
        # What a pre-0.4 pod writes during the rolling upgrade.
        p = _raw_project("Old Pod")
        _raw_project("Old Pod 2")  # a second blank is legal under the partial index
        assign_key(p, derive_key(p.name, "project", exclude=p), source=ObjectKeySource.DERIVED)
        p.refresh_from_db()
        assert p.code == "OP"


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


def _resolve(client: APIClient, ref: str, kind: str = "project") -> Any:
    return client.get(RESOLVE_URL, {"kind": kind, "ref": ref})


class TestResolve:
    def test_a_current_key_resolves(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        r = _resolve(_client(owner), "plat")
        assert r.status_code == 200
        assert r.data == {
            "type": "project",
            "id": str(p.pk),
            "project_id": str(p.pk),
            "program_id": None,
            "key": "PLAT",
            "canonical_ref": "PLAT",
        }

    def test_a_uuid_resolves(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        r = _resolve(_client(owner), str(p.pk))
        assert r.status_code == 200
        assert r.data["canonical_ref"] == "PLAT"

    def test_a_retired_key_returns_the_current_key(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        _client(owner).patch(f"{PROJECTS_URL}{p.pk}/", {"code": "CORE"}, format="json")
        r = _resolve(_client(owner), "PLAT")
        assert r.status_code == 200
        assert (r.data["id"], r.data["key"], r.data["canonical_ref"]) == (str(p.pk), "CORE", "CORE")

    def test_task_sprint_and_risk_refs(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        for _ in range(9):
            Task.objects.create(project=p, name="filler", duration=1)
        task = Task.objects.create(project=p, name="Tenth", duration=1)
        assert task.short_id == "0000000A"
        sprint = Sprint.objects.create(
            project=p, name="S", start_date=date(2026, 1, 5), finish_date=date(2026, 1, 16)
        )
        risk = Risk.objects.create(project=p, title="R", probability=3, impact=3)
        client = _client(owner)

        r = _resolve(client, "plat-t-10")
        assert (r.status_code, r.data["type"], r.data["id"]) == (200, "task", str(task.pk))
        assert r.data["canonical_ref"] == "PLAT-T-10"

        n = int(sprint.short_id, 16)
        r = _resolve(client, f"PLAT-SP-{n}")
        assert (r.data["type"], r.data["id"], r.data["canonical_ref"]) == (
            "sprint",
            str(sprint.pk),
            f"PLAT-SP-{n}",
        )

        r = _resolve(client, f"PLAT-R-{risk.short_id}")
        assert (r.data["type"], r.data["id"]) == ("risk", str(risk.pk))

        assert _resolve(client, "PLAT-T-999").status_code == 404

    def test_a_hyphenated_key_parses_on_the_rightmost_marker(self, owner: Any) -> None:
        p = _raw_project("Security", code="GA-SEC", member=owner)
        task = Task.objects.create(project=p, name="One", duration=1)
        r = _resolve(_client(owner), "GA-SEC-T-1")
        assert r.status_code == 200
        assert (r.data["type"], r.data["id"], r.data["canonical_ref"]) == (
            "task",
            str(task.pk),
            "GA-SEC-T-1",
        )

    def test_a_retired_key_ref_rewrites_to_the_current_key(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        Task.objects.create(project=p, name="One", duration=1)
        _client(owner).patch(f"{PROJECTS_URL}{p.pk}/", {"code": "CORE"}, format="json")
        r = _resolve(_client(owner), "PLAT-T-1")
        assert r.data["canonical_ref"] == "CORE-T-1"

    def test_a_program_key_resolves(self, owner: Any) -> None:
        resp = _client(owner).post(
            PROGRAMS_URL, {"name": "Atlas", "methodology": "HYBRID"}, format="json"
        )
        r = _resolve(_client(owner), "ATLAS", kind="program")
        assert r.status_code == 200
        assert r.data["type"] == "program"
        assert r.data["id"] == resp.data["id"]
        assert r.data["canonical_ref"] == "atlas"

    def test_the_namespaces_are_separate(self, owner: Any) -> None:
        _project(owner, "Atlas", code="ATLAS")
        assert _resolve(_client(owner), "ATLAS", kind="program").status_code == 404

    def test_resolve_404_is_indistinguishable(self, owner: Any, outsider: Any) -> None:
        """Missing, hidden, out-of-token-scope, and retired-hidden: same status, same bytes.

        The tripwire for the ADR-1237 top risk: a "fast path" that looks a key up
        before checking access reintroduces the hidden/missing distinction.

        The token case sends a REAL ``Authorization: Bearer`` header through a
        genuinely minted project-scoped token — not ``force_authenticate(token=...)``,
        which sets ``request.auth`` directly and bypasses the authenticator that,
        before ``_TokenReachableView``, 401'd every project/program token before the
        view's own scoping ever ran (rbac-check finding).
        """
        # Hidden: a project the caller is not a member of.
        _project(outsider, "Hidden", code="HIDDEN")
        # Retired key of a hidden project.
        renamed = _project(outsider, "Renamed", code="OLDKEY")
        _client(outsider).patch(f"{PROJECTS_URL}{renamed.pk}/", {"code": "NEWKEY"}, format="json")
        # Out of token scope: the caller IS a member, but the token is bound elsewhere.
        mine = _project(owner, "Mine", code="MINE")
        bound = _project(owner, "Bound", code="BOUND")
        _, raw = _mint_project_token(bound, owner)
        token_client = _bearer_client(raw)

        responses = [
            _resolve(_client(owner), "NOSUCH"),
            _resolve(_client(owner), "HIDDEN"),
            _resolve(token_client, "MINE"),
            _resolve(_client(owner), "OLDKEY"),
            _resolve(_client(owner), str(uuid.uuid4())),
        ]
        assert {r.status_code for r in responses} == {404}
        assert len({r.content for r in responses}) == 1
        assert responses[0].json() == {"detail": "Not found."}
        # Sanity: the real token authenticates and resolves its own bound project,
        # and the owner's own session sees MINE.
        in_scope = _resolve(token_client, "BOUND")
        assert in_scope.status_code == 200
        assert in_scope.data["id"] == str(bound.pk)
        assert _resolve(_client(owner), "MINE").data["id"] == str(mine.pk)

    def test_a_trashed_project_does_not_resolve(self, owner: Any) -> None:
        p = _project(owner, "Platform")
        p.soft_delete()
        assert _resolve(_client(owner), "PLAT").status_code == 404

    def test_bad_params_are_400(self, owner: Any) -> None:
        client = _client(owner)
        assert client.get(RESOLVE_URL, {"kind": "task", "ref": "X"}).status_code == 400
        assert client.get(RESOLVE_URL, {"kind": "project"}).status_code == 400

    def test_unauthenticated_is_refused(self) -> None:
        assert APIClient().get(RESOLVE_URL, {"kind": "project", "ref": "X"}).status_code == 401

    def test_throttle_scope_is_registered(self) -> None:
        from django.conf import settings

        assert ResolveView.throttle_scope == "resolve"
        assert KeySuggestionView.throttle_scope == "resolve"
        assert "resolve" in settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]


# ---------------------------------------------------------------------------
# /keys/
# ---------------------------------------------------------------------------


class TestKeys:
    def test_suggestion_from_a_name(self, owner: Any) -> None:
        client = _client(owner)
        assert client.get(KEYS_URL, {"kind": "project", "name": "Platform"}).data == {
            "suggestion": "PLAT"
        }
        _project(owner, "Platform")
        assert client.get(KEYS_URL, {"kind": "project", "name": "Platform"}).data == {
            "suggestion": "PLAT2"
        }
        assert client.get(KEYS_URL, {"kind": "program", "name": "Atlas Launch"}).data == {
            "suggestion": "atlas-launch"
        }

    def test_availability(self, owner: Any, outsider: Any) -> None:
        _project(outsider, "Hidden", code="ACME")
        client = _client(owner)
        assert client.get(KEYS_URL, {"kind": "project", "key": "free"}).data == {
            "available": True,
            "reason": None,
            "suggestion": "FREE",
        }
        taken = client.get(KEYS_URL, {"kind": "project", "key": "acme"})
        assert taken.data == {"available": False, "reason": "taken", "suggestion": "ACME2"}
        assert "Hidden" not in taken.content.decode()

    def test_own_retired_key_is_available_to_its_owner(self, owner: Any) -> None:
        p = _project(owner, "Alpha", code="ALPHA")
        _client(owner).patch(f"{PROJECTS_URL}{p.pk}/", {"code": "BETA"}, format="json")
        client = _client(owner)
        assert client.get(KEYS_URL, {"kind": "project", "key": "ALPHA"}).data["available"] is False
        mine = client.get(KEYS_URL, {"kind": "project", "key": "ALPHA", "object_id": str(p.pk)})
        assert mine.data["available"] is True

    def test_object_id_of_an_unreadable_project_has_no_effect(
        self, owner: Any, outsider: Any
    ) -> None:
        hidden = _project(outsider, "Hidden", code="ACME")
        r = _client(owner).get(
            KEYS_URL, {"kind": "project", "key": "ACME", "object_id": str(hidden.pk)}
        )
        assert r.data["available"] is False

    @pytest.mark.parametrize("word", ["new", "settings", "trash"])
    def test_reserved_words(self, owner: Any, word: str) -> None:
        r = _client(owner).get(KEYS_URL, {"kind": "program", "key": word})
        assert r.data["available"] is False
        assert r.data["reason"] == "reserved"
        assert r.data["suggestion"] == f"{word}-2"

    def test_uuid_shaped(self, owner: Any) -> None:
        r = _client(owner).get(KEYS_URL, {"kind": "program", "key": str(uuid.uuid4())})
        assert (r.data["available"], r.data["reason"]) == (False, "reserved")

    def test_invalid_format(self, owner: Any) -> None:
        r = _client(owner).get(KEYS_URL, {"kind": "project", "key": "GA-SEC"})
        assert (r.data["available"], r.data["reason"]) == (False, "invalid")
        assert r.data["suggestion"] == "GS"

    def test_bad_params_are_400(self, owner: Any) -> None:
        client = _client(owner)
        assert client.get(KEYS_URL, {"kind": "project"}).status_code == 400
        assert client.get(KEYS_URL, {"kind": "nope", "name": "x"}).status_code == 400

    def test_unauthenticated_is_refused(self) -> None:
        assert APIClient().get(KEYS_URL, {"kind": "project", "name": "x"}).status_code == 401

    def test_suffix_attempts_are_capped(self) -> None:
        """next_free_key gives up after MAX_SUFFIX_ATTEMPTS rather than looping
        forever (security-review Low, perf-check Low): a stubbed ``is_taken``
        that never returns False must not spin — namespace squatting (every
        suffix of a base pre-registered) must fail fast for the next caller.
        """
        calls: list[str] = []

        def _always_taken(candidate: str) -> bool:
            calls.append(candidate)
            return True

        with pytest.raises(KeyAssignmentError):
            _next_free_key("PLAT", "project", _always_taken)
        assert len(calls) == MAX_SUFFIX_ATTEMPTS

    def test_the_view_returns_400_when_the_suffix_cap_is_hit(self, owner: Any) -> None:
        """The stubbed-``is_taken`` cap (above) surfaces as a 400, not a 500,
        from a real request through the suggestion view.
        """
        with patch("trueppm_api.apps.projects.services.is_key_taken", return_value=True):
            r = _client(owner).get(KEYS_URL, {"kind": "project", "name": "Platform"})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Seed / sample paths
# ---------------------------------------------------------------------------


def _seed_with_codes() -> dict[str, Any]:
    """The importer fixture with explicit project codes, as #4149's samples carry."""
    seed = copy.deepcopy(_seed())
    for project, code in zip(seed["projects"], ["PLAT", "MIGR"], strict=False):
        project["code"] = code
    return seed


class TestSeedKeys:
    def test_a_second_non_replace_load_suffixes_instead_of_colliding(
        self, owner: Any, outsider: Any
    ) -> None:
        first = import_seed(_seed_with_codes(), owner=owner, create_users=True, is_sample=True)
        # A different user loads the same sample: no replace candidate for them.
        second = import_seed(_seed_with_codes(), owner=outsider, create_users=True, is_sample=True)
        assert first.code == "atlas"
        assert second.code == "atlas-2"
        codes = set(Project.objects.filter(program=second).values_list("code", flat=True))
        assert codes == {"PLAT2", "MIGR2"}
        for p in Project.objects.filter(program=second):
            assert ObjectKey.objects.get(project=p).source == ObjectKeySource.DERIVED

    def test_a_sample_reload_keeps_its_keys(self, owner: Any) -> None:
        import_seed(_seed_with_codes(), owner=owner, create_users=True, is_sample=True)
        again = import_seed(
            _seed_with_codes(), owner=owner, create_users=True, is_sample=True, replace=True
        )
        assert again.code == "atlas"
        codes = set(Project.objects.filter(program=again).values_list("code", flat=True))
        assert codes == {"PLAT", "MIGR"}

    def test_load_sample_twice_by_two_users_does_not_500(self, owner: Any, outsider: Any) -> None:
        r1 = _client(owner).post("/api/v1/programs/load-sample/", {}, format="json")
        assert r1.status_code == 201, r1.content
        r2 = _client(outsider).post("/api/v1/programs/load-sample/", {}, format="json")
        assert r2.status_code == 201, r2.content
        assert r1.data["program"]["code"] != r2.data["program"]["code"]

    def test_an_api_import_of_a_strangers_slug_is_a_409(self, owner: Any, outsider: Any) -> None:
        import_seed(_seed(), owner=outsider, create_users=False)
        r = _client(owner).post("/api/v1/programs/import/", _seed(), format="json")
        assert r.status_code == 409, r.content
        assert r.data["code"] == "seed_slug_taken"

    def test_an_api_import_of_a_trashed_programs_slug_is_a_409(self, owner: Any) -> None:
        program = import_seed(_seed(), owner=owner, create_users=False)
        ProgramMembership.objects.filter(program=program).update(is_deleted=True)
        program.soft_delete()
        r = _client(owner).post("/api/v1/programs/import/", _seed(), format="json")
        assert r.status_code == 409, r.content
        assert r.data["code"] == "seed_slug_taken"

    def test_restoring_a_project_whose_key_moved_derives_a_new_one(self, owner: Any) -> None:
        program = import_seed(_seed_with_codes(), owner=owner, create_users=False)
        original = Project.objects.get(program=program, code="PLAT")
        ProjectMembership.objects.get_or_create(
            project=original, user=owner, defaults={"role": Role.OWNER}
        )
        import_seed(_seed_with_codes(), owner=owner, create_users=False, replace=True)
        original.refresh_from_db()
        assert original.is_deleted and original.code == ""
        r = _client(owner).post(f"{PROJECTS_URL}{original.pk}/restore/")
        assert r.status_code == 200, r.content
        original.refresh_from_db()
        assert original.code not in ("", "PLAT")

    def test_release_detaches_every_row(self, owner: Any) -> None:
        p = _project(owner, "Alpha", code="ALPHA")
        ids = release_keys_for_replace(p)
        assert len(ids) == 1
        p.refresh_from_db()
        assert p.code == ""
        assert ObjectKey.objects.get(pk=ids[0]).project_id is None
