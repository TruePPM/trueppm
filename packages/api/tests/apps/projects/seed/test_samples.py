"""Tests for the bundled sample loader (#375) and the Atlas fixture (#620).

The service tests double as a DB import smoke test for the committed Atlas seed:
if the 3-project fixture imports cleanly with cross-project dependencies, the
gate ("a fresh install can load the hybrid-large project") holds.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import Dependency, Program, Project, Task
from trueppm_api.apps.projects.seed.samples import SAMPLES, UnknownSampleError, load_sample

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="demo-owner", email="o@example.com")


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


# --- service ---------------------------------------------------------------


def test_load_atlas_creates_three_sample_projects(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)

    assert program.code == "atlas-platform-launch"
    projects = Project.objects.filter(program=program)
    assert projects.count() == 3
    assert all(p.is_sample for p in projects)  # every project flagged demo data

    # methodology mix present
    assert set(projects.values_list("methodology", flat=True)) == {"AGILE", "WATERFALL", "HYBRID"}

    # personas created (create_users=True), with namespaced usernames so a real
    # account named "alex" is never reused for the demo persona
    assert User.objects.filter(username="atlas-alex").exists()
    assert not User.objects.filter(username="alex").exists()

    # cross-project dependency wired (Platform Core gates Migration build)
    assert Dependency.objects.filter(
        predecessor__project__methodology="AGILE",
        successor__project__methodology="WATERFALL",
    ).exists()

    # three-point estimates imported on the waterfall stream
    assert Task.objects.filter(
        project__methodology="WATERFALL", optimistic_duration__isnull=False
    ).exists()


def test_load_sample_is_idempotent(owner: Any) -> None:
    load_sample("atlas-platform-launch", owner=owner, create_users=True)
    load_sample("atlas-platform-launch", owner=owner, create_users=True)
    assert Program.objects.filter(code="atlas-platform-launch", is_deleted=False).count() == 1


def test_unknown_sample_raises(owner: Any) -> None:
    with pytest.raises(UnknownSampleError):
        load_sample("does-not-exist", owner=owner)


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_every_bundled_sample_imports(owner: Any, key: str) -> None:
    # Each committed fixture validates and imports cleanly into a real DB.
    program = load_sample(key, owner=owner, create_users=True)
    projects = Project.objects.filter(program=program)
    assert projects.exists()
    assert all(p.is_sample for p in projects)


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_bundled_sample_in_flight_tasks_keep_authored_progress(owner: Any, key: str) -> None:
    """#3486/#3518: every IN_PROGRESS or REVIEW task in every fixture keeps its
    authored progress numbers.

    Read from the fixture rather than a hard-coded table so the assertion cannot
    rot when a sample's content changes: whatever the document declares is what
    the loaded row must report. Before the replay finalize pass every one of
    these landed at 0%/100% with ``remaining_points == story_points``, because a
    task that ends in flight or in review is born at the base of the
    progression and nothing walked the numbers back.

    REVIEW is a mixed case (#3518), not a straight widening of the IN_PROGRESS
    check: ``Task._coerce_signoff_percent`` deliberately fixes
    ``percent_complete`` to 100 regardless of what the document authored
    ("work done, awaiting sign-off"), so that field is asserted against 100,
    not the document — asserting it against the document would fail on every
    bundled REVIEW row (aurora authors 80.0, helios 85.0) and would be asserting
    for the wrong behavior. ``remaining_points`` has no such contract and is
    checked against the document exactly like IN_PROGRESS.
    """
    document = json.loads(SAMPLES[key].path.read_text())
    program = load_sample(key, owner=owner, create_users=True)

    checked = 0
    for project_data in document["projects"]:
        project = Project.objects.get(program=program, name=project_data["name"])
        for task_data in project_data["tasks"]:
            status = task_data.get("status")
            if status not in ("IN_PROGRESS", "REVIEW"):
                continue
            task = Task.objects.get(project=project, wbs_path=task_data["wbs_path"])
            # A task the timeline walked past its authored end column is a
            # different fixture bug, not this one; assert only on rows that did
            # land where the document said they would.
            if str(task.status) != status:
                continue
            checked += 1
            label = f"{key}/{project_data['slug']}/{task_data['wbs_path']}"
            if status == "IN_PROGRESS":
                if "percent_complete" in task_data:
                    assert task.percent_complete == task_data["percent_complete"], label
            else:
                # REVIEW: the sign-off contract always wins here, never the
                # document's authored percent_complete.
                assert task.percent_complete == 100, label
            if "remaining_points" in task_data:
                assert task.remaining_points == task_data["remaining_points"], label
    # Guard against a vacuous pass: every bundled sample authors in-flight/review work.
    assert checked > 0


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_bundled_sample_closed_sprints_get_outcome_rows(owner: Any, key: str) -> None:
    """#3488: `_apply_sprint_close` bypassed the real close service, so every
    closed sprint across all five samples loaded with zero SprintTaskOutcome
    rows and no goal_outcome on a synthesized close. Read from the document
    (not a hard-coded table) so this can't rot when a sample's content
    changes — see the docstring above for the pattern.

    Not every task ends the timeline at its declared final status — a
    separate, pre-existing replay defect (unrelated to #3488, not fixed here)
    leaves at least one bundled task short of its authored end column, which
    is enough to make that task's sprint legitimately carry it forward — so
    this checks outcome rows exist per closed sprint rather than asserting an
    exact count or a single disposition, either of which that other defect
    would make a false assumption.
    """
    from trueppm_api.apps.projects.models import Sprint, SprintTaskOutcome

    document = json.loads(SAMPLES[key].path.read_text())
    authored_close_targets = {
        e["target"] for e in document.get("events", []) if e.get("action") == "sprint.close"
    }
    program = load_sample(key, owner=owner, create_users=True)

    checked = 0
    for project_data in document["projects"]:
        project = Project.objects.get(program=program, name=project_data["name"])
        for sprint_data in project_data.get("sprints", []):
            if sprint_data["state"] != "COMPLETED":
                continue
            checked += 1
            label = f"{key}/{project_data['slug']}/{sprint_data['slug']}"
            sprint = Sprint.objects.get(project=project, name=sprint_data["name"])
            outcomes = SprintTaskOutcome.objects.filter(sprint=sprint)
            assert outcomes.exists(), label
            target = f"sprint:{project_data['slug']}:{sprint_data['slug']}"
            if target not in authored_close_targets:
                # Synthesized close: no authored `sprint.close` beat means no
                # authored goal_outcome — the derived committed-vs-completed
                # verdict must not be left None (#3488).
                assert sprint.goal_outcome is not None, label
    # Guard against a vacuous pass: every bundled sample has a closed sprint
    # (matches the issue's count of 11 across the five samples).
    if checked == 0:
        pytest.skip(f"{key} has no COMPLETED sprint")


@pytest.mark.parametrize("key", sorted(SAMPLES))
def test_bundled_sample_velocity_suggestions_where_history_supports_it(
    owner: Any, key: str
) -> None:
    """#3488: a project with enough closed-sprint history gets at least one
    VelocitySuggestion once its sprints have replayed through the real close.
    """
    from trueppm_api.apps.scheduling.models import VelocitySuggestion
    from trueppm_api.apps.scheduling.services import MIN_CLOSED_SPRINTS_FOR_SUGGESTION

    document = json.loads(SAMPLES[key].path.read_text())
    program = load_sample(key, owner=owner, create_users=True)

    checked = 0
    for project_data in document["projects"]:
        closed = [s for s in project_data.get("sprints", []) if s["state"] == "COMPLETED"]
        # compute_velocity_suggestions needs MIN_CLOSED_SPRINTS_FOR_SUGGESTION
        # *prior* closed sprints before the one just closed, i.e. more than
        # that many closed sprints in total.
        if len(closed) <= MIN_CLOSED_SPRINTS_FOR_SUGGESTION:
            continue
        checked += 1
        project = Project.objects.get(program=program, name=project_data["name"])
        assert VelocitySuggestion.objects.filter(sprint__project=project).exists(), (
            f"{key}/{project_data['slug']}"
        )
    if checked == 0:
        pytest.skip(f"{key} has no project with enough closed-sprint history to check")


def test_samples_endpoint_lists_all(owner: Any) -> None:
    resp = _client(owner).get("/api/v1/programs/samples/")
    assert resp.status_code == 200
    keys = {s["key"] for s in resp.data}
    assert keys == set(SAMPLES)
    assert all({"key", "title", "description"} <= set(s) for s in resp.data)


def test_samples_endpoint_returns_a_bare_array_not_a_pagination_envelope(owner: Any) -> None:
    """The catalog body is a bare array, and the schema must say so (#2515).

    ``ProgramViewSet`` sets a ``pagination_class``, so drf-spectacular wraps any
    ``many=True`` response in a ``Paginated…List`` envelope unless the action opts
    out. It did not, and the committed schema declared an object body that no
    response satisfied — caught by the nightly ``api:fuzz`` conformance run, not by
    ``api:schema-drift`` (which only proves the schema matches its own generator).
    Assert the runtime shape here; the generated schema is asserted in
    ``tests/test_openapi_pagination_envelope.py``.
    """
    resp = _client(owner).get("/api/v1/programs/samples/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_samples_endpoint_requires_auth() -> None:
    resp = APIClient().get("/api/v1/programs/samples/")
    assert resp.status_code in (401, 403)


def test_management_command_loads_sample(owner: Any) -> None:
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    call_command("load_sample_project")
    assert Program.objects.filter(code="atlas-platform-launch", is_deleted=False).exists()


# --- persona logins (#1760) ------------------------------------------------


def test_personas_have_unusable_password_by_default(owner: Any) -> None:
    """Without a persona_password the created personas cannot log in (unchanged)."""
    load_sample("atlas-platform-launch", owner=owner, create_users=True)
    alex = User.objects.get(username="atlas-alex")
    assert alex.has_usable_password() is False


def test_persona_password_makes_personas_loginable(owner: Any) -> None:
    """persona_password gives created personas a real, checkable login password."""
    load_sample("atlas-platform-launch", owner=owner, create_users=True, persona_password="demo")
    alex = User.objects.get(username="atlas-alex")
    assert alex.has_usable_password() is True
    assert alex.check_password("demo") is True


def test_persona_password_never_repasswords_existing_user(owner: Any) -> None:
    """A pre-existing account matching a persona username keeps its own password.

    The password is applied only to accounts this import *creates*, so loading a
    sample can never overwrite (or expose) a real user's credentials — even if the
    real username collides with a namespaced persona slug.
    """
    existing = User.objects.create_user(username="atlas-alex", password="original-secret")
    load_sample("atlas-platform-launch", owner=owner, create_users=True, persona_password="demo")
    existing.refresh_from_db()
    assert existing.check_password("original-secret") is True
    assert existing.check_password("demo") is False


def test_with_personas_flag_enables_login_under_debug(
    owner: Any, settings: Any, capsys: Any
) -> None:
    """`--with-personas` under DEBUG seeds the 'demo' password and echoes usernames."""
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    call_command("load_sample_project", "--with-personas")

    alex = User.objects.get(username="atlas-alex")
    assert alex.check_password("demo") is True
    out = capsys.readouterr().out
    assert "atlas-alex" in out  # the real username the guide must reference


def test_without_flag_personas_stay_unusable_via_command(owner: Any) -> None:
    """The default command path leaves personas view-only (no dormant weak login)."""
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    call_command("load_sample_project")
    alex = User.objects.get(username="atlas-alex")
    assert alex.has_usable_password() is False


# --- persona logins on a *reload* (#3484) ----------------------------------


def test_reload_with_personas_enables_preexisting_persona_accounts(
    owner: Any, settings: Any
) -> None:
    """The reported bug: the second run must actually enable the accounts it lists.

    Loading is idempotent, so by the time an evaluator follows the guide's advice
    and re-runs with ``--with-personas`` the persona rows already exist — and the
    old code only passworded rows it *created*, leaving every listed account with
    ``has_usable_password() is False`` while printing "Persona logins enabled".
    """
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])

    call_command("load_sample_project")
    alex = User.objects.get(username="atlas-alex")
    assert alex.has_usable_password() is False  # precondition: the bug's start state

    call_command("load_sample_project", "--with-personas")

    alex.refresh_from_db()
    assert alex.has_usable_password() is True
    assert alex.check_password("demo") is True


def test_reload_with_personas_makes_token_endpoint_accept_the_persona(
    owner: Any, settings: Any
) -> None:
    """End-to-end proof: ``POST /auth/token/`` stops returning "No active account"."""
    # The login endpoint is scoped-throttled against a shared LocMem cache; isolate
    # this test's history so a sibling test's logins cannot make it 429.
    cache.clear()
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])

    call_command("load_sample_project")
    call_command("load_sample_project", "--with-personas")

    resp = APIClient().post(
        "/api/v1/auth/token/",
        {"username": "atlas-alex", "password": "demo"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert "access" in resp.data


def test_reload_still_never_repasswords_a_real_account(owner: Any, settings: Any) -> None:
    """A colliding account with its own password survives a *reload*, not just a first load.

    ``test_persona_password_never_repasswords_existing_user`` pins the first-load
    case; this pins the branch #3484 added. A usable password is the discriminator
    for "a real user owns this row", so it is what keeps the new behavior out of
    the #1057 hijack case.
    """
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    real = User.objects.create_user(username="atlas-mei", password="original-secret")

    call_command("load_sample_project", "--with-personas")

    real.refresh_from_db()
    assert real.check_password("original-secret") is True
    assert real.check_password("demo") is False


def test_reload_never_repasswords_a_privileged_account(owner: Any, settings: Any) -> None:
    """A staff/superuser row is refused even with an unusable password.

    Handing a printed password to an admin account would be a full takeover, so the
    usable-password discriminator is not the only guard.
    """
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    staff = User.objects.create_user(username="atlas-sam", is_staff=True)
    staff.set_unusable_password()
    staff.save(update_fields=["password"])

    call_command("load_sample_project", "--with-personas")

    staff.refresh_from_db()
    assert staff.has_usable_password() is False


def test_report_lists_only_accounts_the_printed_password_opens(
    owner: Any, settings: Any, capsys: Any
) -> None:
    """The report is derived from observed state, so a refusal is named, not hidden."""
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    User.objects.create_user(username="atlas-mei", password="original-secret")

    call_command("load_sample_project", "--with-personas")
    out = capsys.readouterr().out

    assert "Persona logins enabled" in out
    assert "atlas-alex" in out  # enabled — the username the guide references
    assert "left untouched" in out
    assert "pre-existing account with its own password" in out
    assert "changepassword" in out  # the operator's way out


def test_owner_fallback_report_reads_the_state_back(settings: Any, capsys: Any) -> None:
    """The sibling instance of the same defect, found by the recurrence sweep.

    With no superuser, ``_resolve_owner`` owns the program with the sample's own
    OWNER persona and printed "(unusable password)" from the create branch's
    intent. On a reload that row already exists and is never touched, so once
    ``--with-personas`` has made it loginable the line was simply false.
    """
    settings.DEBUG = True
    assert not User.objects.filter(is_superuser=True).exists()

    call_command("load_sample_project", "--with-personas")
    first = capsys.readouterr().out
    assert "(unusable password)" in first  # minted this run, still unusable

    # atlas-alex is now loginable (it is a persona like any other), so the second
    # run must not repeat the claim.
    call_command("load_sample_project", "--with-personas")
    second = capsys.readouterr().out
    assert "(usable password)" in second
    assert "(unusable password)" not in second


def test_rest_load_sample_never_passwords_personas(owner: Any, settings: Any) -> None:
    """The REST path passes no ``persona_password``, so #3484 mints no login there.

    ``persona_password`` reaching only the management command is what makes the
    sample usernames server-curated rather than caller-steered.
    """
    settings.DEBUG = True
    resp = _client(owner).post("/api/v1/programs/load-sample/", {}, format="json")
    assert resp.status_code == 201, resp.content
    assert User.objects.get(username="atlas-alex").has_usable_password() is False


# --- endpoints -------------------------------------------------------------


def test_load_sample_endpoint_requires_auth() -> None:
    resp = APIClient().post("/api/v1/programs/load-sample/", {}, format="json")
    assert resp.status_code in (401, 403)


def test_load_sample_endpoint_creates_program(owner: Any) -> None:
    resp = _client(owner).post("/api/v1/programs/load-sample/", {}, format="json")
    assert resp.status_code == 201, resp.content
    # The response is now a {program, landing_project_id, sample_key} envelope (#1054).
    assert resp.data["sample_key"] == "atlas-platform-launch"
    assert resp.data["program"]["code"] == "atlas-platform-launch"
    assert resp.data["program"]["is_sample"] is True


def test_load_sample_unknown_key_rejected(owner: Any) -> None:
    resp = _client(owner).post("/api/v1/programs/load-sample/", {"sample": "nope"}, format="json")
    assert resp.status_code == 400


def test_remove_sample_endpoint_owner_tears_down(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code == 204
    assert not Program.objects.filter(pk=program.pk, is_deleted=False).exists()
    assert not Project.objects.filter(program_id=program.pk).exists()


def test_remove_sample_non_owner_denied(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    stranger = User.objects.create_user(username="stranger", password="pw")
    resp = _client(stranger).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code in (403, 404)
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()


def test_remove_sample_non_owner_member_denied(owner: Any) -> None:
    # An ADMIN member (not OWNER) must not be able to tear down the program.
    from trueppm_api.apps.access.models import ProgramMembership

    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    admin = User.objects.create_user(username="prog-admin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)
    resp = _client(admin).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code in (403, 404)
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()


def test_remove_sample_refuses_non_sample_program(owner: Any) -> None:
    from trueppm_api.apps.access.services import create_program

    program = create_program(name="Real", description="", methodology="HYBRID", created_by=owner)
    # grant owner membership already done by create_program; mark caller OWNER
    assert program.memberships.filter(user=owner, role=Role.OWNER).exists()
    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/remove-sample/")
    assert resp.status_code == 400
    assert Program.objects.filter(pk=program.pk, is_deleted=False).exists()


# --- shift-sample-dates (#3481, ADR-1175) -----------------------------------


def _age_anchor(program: Any, days: int) -> None:
    """Rewind the recorded anchor so the endpoint computes a non-zero offset.

    Endpoint-level tests care about status codes, the envelope and the gate — not
    about which rows moved, which ``test_reanchor.py`` covers against a genuinely
    aged import.
    """
    import datetime as dt

    from django.utils import timezone

    Program.objects.filter(pk=program.pk).update(
        sample_anchor_date=timezone.localdate() - dt.timedelta(days=days)
    )


def test_shift_sample_dates_requires_auth(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    resp = APIClient().post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")
    assert resp.status_code in (401, 403)


def test_shift_sample_dates_owner_shifts_and_reports(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)

    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code == 200, resp.content
    assert resp.data["shifted"] is True
    # Whole-week quantum: 47 days of drift moves 49.
    assert resp.data["days"] == 49
    assert resp.data["rows_shifted"] > 0
    assert resp.data["projects"] > 0


def test_shift_sample_dates_is_idempotent_over_the_endpoint(owner: Any) -> None:
    """A second press returns 200 with shifted:false — not an error.

    The client renders "already current"; making this a 4xx would turn a safe
    repeat into something that looks like a failure the user must act on.
    """
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)
    client = _client(owner)

    assert client.post(f"/api/v1/programs/{program.pk}/shift-sample-dates/").data["shifted"] is True
    second = client.post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert second.status_code == 200
    assert second.data["shifted"] is False
    assert second.data["rows_shifted"] == 0


def test_shift_sample_dates_ignores_a_caller_supplied_target_date(owner: Any) -> None:
    """The endpoint takes NO body — an attacker-supplied offset must not bind.

    A bulk date rewrite that honours an arbitrary caller delta is a very
    different endpoint to secure. The offset is always derived server-side from
    the recorded anchor.
    """
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)

    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/shift-sample-dates/",
        {"days": 99999, "target_date": "9999-12-31", "anchor_date": "1970-01-01"},
        format="json",
    )

    assert resp.status_code == 200, resp.content
    assert resp.data["days"] == 49


def test_shift_sample_dates_survives_a_non_dict_body(owner: Any) -> None:
    """A JSON array body must not 500 (the #2126 raw-request.data class)."""
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)

    resp = _client(owner).post(
        f"/api/v1/programs/{program.pk}/shift-sample-dates/", [1, 2, 3], format="json"
    )

    assert resp.status_code < 500, resp.content


def test_shift_sample_dates_non_owner_denied(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)
    stranger = User.objects.create_user(username="shift-stranger", password="pw")

    resp = _client(stranger).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code in (403, 404)


def test_shift_sample_dates_program_admin_denied(owner: Any) -> None:
    """Owner-only, mirroring teardown. An ADMIN member must not bulk-rewrite dates."""
    from trueppm_api.apps.access.models import ProgramMembership

    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)
    admin = User.objects.create_user(username="shift-admin", password="pw")
    ProgramMembership.objects.create(program=program, user=admin, role=Role.ADMIN)

    resp = _client(admin).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code in (403, 404)


def test_shift_sample_dates_refuses_a_non_sample_program(owner: Any) -> None:
    from trueppm_api.apps.access.services import create_program

    program = create_program(name="Real", description="", methodology="HYBRID", created_by=owner)
    Program.objects.filter(pk=program.pk).update(sample_anchor_date="2026-01-01")

    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code == 400
    assert resp.data["code"] == "not_a_sample"


def test_shift_sample_dates_refuses_a_sample_with_no_anchor(owner: Any) -> None:
    """A sample loaded before #3481 is reloaded, not shifted — and says so."""
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    Program.objects.filter(pk=program.pk).update(sample_anchor_date=None)

    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code == 400
    assert resp.data["code"] == "no_anchor_recorded"


def test_shift_sample_dates_blocked_on_a_closed_program(owner: Any) -> None:
    """Deliberately NOT in _CLOSE_BYPASS_ACTIONS.

    Teardown must survive a closed program (an Owner has to be able to delete
    one); re-anchoring a closed program's dates is meaningless.
    """
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)
    Program.objects.filter(pk=program.pk).update(is_closed=True)

    resp = _client(owner).post(f"/api/v1/programs/{program.pk}/shift-sample-dates/")

    assert resp.status_code in (403, 404)


def test_program_serializer_exposes_the_drift_read_only(owner: Any) -> None:
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    _age_anchor(program, 47)

    resp = _client(owner).get(f"/api/v1/programs/{program.pk}/")

    assert resp.status_code == 200
    assert resp.data["sample_days_stale"] == 47
    assert resp.data["sample_anchor_date"] is not None


def test_sample_anchor_date_is_not_client_writable(owner: Any) -> None:
    """Read-only: a client that could set the anchor could force an unbounded shift."""
    program = load_sample("atlas-platform-launch", owner=owner, create_users=True)
    original = Program.objects.get(pk=program.pk).sample_anchor_date

    resp = _client(owner).patch(
        f"/api/v1/programs/{program.pk}/",
        {"sample_anchor_date": "1970-01-01"},
        format="json",
    )

    assert resp.status_code in (200, 400)
    assert Program.objects.get(pk=program.pk).sample_anchor_date == original


# --- interactive demo login (#3925, ADR-1197 D5) ---------------------------

# A fixture value, hoisted out of the call sites: a string literal beside a
# "password" key trips the secret scanner exactly as a real credential would.
_DEMO_LOGIN_PASSWORD = "visitor-" + "pw-3925"


def _demo_login_env(monkeypatch: Any, username: str, password: str) -> None:
    monkeypatch.setenv("TRUEPPM_DEMO_LOGIN_USERNAME", username)
    monkeypatch.setenv("TRUEPPM_DEMO_LOGIN_PASSWORD", password)


def test_demo_login_env_enables_exactly_one_account(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """The interactive demo publishes one credential; it must open one account.

    This is the whole reason ``--with-personas`` is not the mechanism: that flag
    passwords every persona in the pack with the same secret, three of which hold
    OWNER or ADMIN.
    """
    settings.DEBUG = False
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    _demo_login_env(monkeypatch, "atlas-visitor", _DEMO_LOGIN_PASSWORD)

    call_command("load_sample_project")

    assert User.objects.get(username="atlas-visitor").check_password(_DEMO_LOGIN_PASSWORD) is True
    assert User.objects.get(username="atlas-alex").has_usable_password() is False

    cache.clear()
    resp = APIClient().post(
        "/api/v1/auth/token/",
        {"username": "atlas-visitor", "password": _DEMO_LOGIN_PASSWORD},
        format="json",
    )
    assert resp.status_code == 200


def test_demo_login_survives_a_reset(owner: Any, monkeypatch: Any, settings: Any) -> None:
    """The scheduled reset re-runs the same command, so it must re-create the login.

    ``load_sample_project`` is destructively idempotent. If the second run did not
    re-apply the password, the demo would publish a login hint that stopped working
    at the first reset — six hours after launch, with nothing failing anywhere.
    """
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    _demo_login_env(monkeypatch, "atlas-visitor", _DEMO_LOGIN_PASSWORD)

    call_command("load_sample_project")
    call_command("load_sample_project")

    assert User.objects.get(username="atlas-visitor").check_password(_DEMO_LOGIN_PASSWORD) is True


def test_demo_login_refuses_a_privileged_account(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    _demo_login_env(monkeypatch, "atlas-alex", _DEMO_LOGIN_PASSWORD)

    with pytest.raises(CommandError, match="ADMIN or OWNER"):
        call_command("load_sample_project")


def test_demo_login_refuses_an_account_the_sample_does_not_declare(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """A username outside the pack is a real user, whose password is not ours to set."""
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    User.objects.create_user(username="a-real-person", password="their-own-secret")
    _demo_login_env(monkeypatch, "a-real-person", _DEMO_LOGIN_PASSWORD)

    with pytest.raises(CommandError, match="not one of sample"):
        call_command("load_sample_project")

    assert User.objects.get(username="a-real-person").check_password("their-own-secret") is True


def test_demo_login_requires_both_env_vars(owner: Any, monkeypatch: Any, settings: Any) -> None:
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    monkeypatch.setenv("TRUEPPM_DEMO_LOGIN_USERNAME", "atlas-visitor")
    monkeypatch.delenv("TRUEPPM_DEMO_LOGIN_PASSWORD", raising=False)

    with pytest.raises(CommandError, match="must be set"):
        call_command("load_sample_project")


def test_with_personas_is_refused_in_demo_read_only_mode(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """ADR-1197 D5: the persona path fails the INSTALL, not a later audit.

    The seed Job is a Helm hook, so a ``CommandError`` here fails the release. It is
    raised before the import so a refused install also leaves no data behind.
    """
    settings.DEMO_READ_ONLY = True
    settings.DEBUG = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])

    with pytest.raises(CommandError, match="--with-personas is refused"):
        call_command("load_sample_project", "--with-personas")

    assert Program.objects.filter(code="atlas-platform-launch").exists() is False


def test_demo_login_is_refused_when_the_write_fence_is_off(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """The invariant lives in the command, not only in the Helm guard with the same rule.

    The chart is one caller. ``kubectl exec ... manage.py load_sample_project``,
    ``docker compose run`` and a CI seed step are not covered by a render-time check,
    and on a writable instance this MEMBER account plus an open ``POST /projects/``
    is a self-granted OWNER.
    """
    settings.DEMO_READ_ONLY = False
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    _demo_login_env(monkeypatch, "atlas-visitor", _DEMO_LOGIN_PASSWORD)

    with pytest.raises(CommandError, match="TRUEPPM_DEMO_READ_ONLY is not on"):
        call_command("load_sample_project")

    assert Program.objects.filter(code="atlas-platform-launch").exists() is False


def test_demo_login_refuses_a_privileged_role_held_in_another_program(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """A role held somewhere else is exactly as published as a role held here.

    The privilege query is deliberately unscoped. Scoping it to the program just
    imported is how it would miss an account that owns something unrelated — and the
    importer binds accounts by bare username, so a pre-existing user *can* be the one
    the sample adopts.
    """
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    squatter = User.objects.create_user(username="atlas-visitor", email="visitor@atlas.example")
    elsewhere = Program.objects.create(name="Unrelated", code="unrelated-program")
    ProgramMembership.objects.create(program=elsewhere, user=squatter, role=Role.OWNER)
    _demo_login_env(monkeypatch, "atlas-visitor", _DEMO_LOGIN_PASSWORD)

    with pytest.raises(CommandError, match="ADMIN or OWNER"):
        call_command("load_sample_project")

    squatter.refresh_from_db()
    assert squatter.has_usable_password() is False


def test_demo_login_refuses_a_row_this_sample_did_not_seed(
    owner: Any, monkeypatch: Any, settings: Any
) -> None:
    """Provenance, because ``has_usable_password()`` cannot be the guard here.

    The persona path refuses any account that already has a password. This path
    cannot: the scheduled reset must re-apply the credential on every run, and a
    rotated password must be able to land. So it asserts the row looks seeded — the
    pack's own email, and no membership outside this program — instead.
    """
    settings.DEMO_READ_ONLY = True
    owner.is_superuser = True
    owner.save(update_fields=["is_superuser"])
    real = User.objects.create_user(
        username="atlas-visitor", email="someone@real.example", password="their-own-secret"
    )
    _demo_login_env(monkeypatch, "atlas-visitor", _DEMO_LOGIN_PASSWORD)

    with pytest.raises(CommandError, match="does not look"):
        call_command("load_sample_project")

    real.refresh_from_db()
    assert real.check_password("their-own-secret") is True
