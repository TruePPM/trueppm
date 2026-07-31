"""Confirmed, recoverable replacement + the async rebuild (ADR-0726, #2581, #2574).

Two defects, one path. #2581: re-import hard-deleted a live program subtree with
no confirmation, no Trash, no tombstone, and no broadcast. #2574: the rebuild ran
inline on the request thread, so a large document 504'd mid-transaction.

The regression guards matter as much as the new behavior here — the ownership
scope (#994) and the sample-path refusal (#2476) were both already correct, and
this change reaches straight through them.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from jsonschema import Draft202012Validator
from rest_framework.test import APIClient

from tests.test_openapi_response_conformance import (
    as_json_schema,
    assert_response_matches_schema,
    load_committed_schema,
)
from trueppm_api.apps.access.models import ProgramMembership, Role
from trueppm_api.apps.projects.models import (
    Dependency,
    ImportJobStatus,
    Program,
    ProgramImportJob,
    Project,
    Sprint,
    Task,
)
from trueppm_api.apps.projects.seed import import_seed
from trueppm_api.apps.projects.seed.importer import SeedReplaceMismatch, SeedReplaceRequired

from .test_importer import _seed

pytestmark = pytest.mark.django_db

User = get_user_model()

IMPORT_URL = "/api/v1/programs/import/"
VALIDATE_URL = "/api/v1/programs/import/validate/"


def _client(user: Any) -> APIClient:
    c = APIClient()
    c.force_authenticate(user=user)
    return c


@pytest.fixture
def seed_owner() -> Any:
    return User.objects.create_user(username="replace-owner", email="o@example.com")


@pytest.fixture
def stranger() -> Any:
    return User.objects.create_user(username="replace-stranger", email="x@example.com")


def _run_job(job_id: Any) -> None:
    """Execute the queued rebuild inline, as the worker would."""
    from trueppm_api.apps.projects.tasks import run_program_import

    run_program_import.apply(args=[str(job_id)])


def _import_via_api(client: APIClient, seed: dict[str, Any], **extra: Any) -> Any:
    """POST the seed and run the resulting job, returning the 202 response."""
    resp = client.post(IMPORT_URL, data={**seed, **extra}, format="json")
    if resp.status_code == 202:
        _run_job(resp.data["import_request_id"])
    return resp


# --- #2581: replacement requires consent ------------------------------------


def test_colliding_import_without_replace_is_refused_and_changes_nothing(seed_owner: Any) -> None:
    """The headline fix: a re-import onto a live slug no longer destroys it."""
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    task_ids = set(Task.objects.filter(project__program=existing).values_list("pk", flat=True))
    assert task_ids

    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")

    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "seed_replace_required"
    conflict = resp.data["conflict"]
    assert conflict["program_id"] == str(existing.pk)
    assert conflict["code"] == "atlas"
    assert conflict["project_count"] == 2
    assert conflict["task_count"] == len(task_ids)

    # Nothing moved: the program, its projects, and every task are untouched.
    existing.refresh_from_db()
    assert existing.is_deleted is False
    assert Project.objects.filter(program=existing, is_deleted=False).count() == 2
    assert (
        set(
            Task.objects.filter(project__program=existing, is_deleted=False).values_list(
                "pk", flat=True
            )
        )
        == task_ids
    )
    # And no half-built successor was left behind.
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 1


def test_confirmed_replace_soft_deletes_the_old_subtree_into_trash(seed_owner: Any) -> None:
    """`replace=true` tombstones rather than hard-deletes — the #2581 fix."""
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    old_project_ids = list(Project.objects.filter(program=existing).values_list("pk", flat=True))
    old_task_ids = list(
        Task.objects.filter(project_id__in=old_project_ids).values_list("pk", flat=True)
    )

    resp = _import_via_api(_client(seed_owner), _seed(), replace=True)
    assert resp.status_code == 202, resp.content

    # The rows still EXIST — that is what makes them recoverable and what lets
    # the sync delta hand offline clients a tombstone instead of silence.
    assert Program.objects.filter(pk=existing.pk).exists()
    assert Project.objects.filter(pk__in=old_project_ids).count() == len(old_project_ids)

    for project in Project.objects.filter(pk__in=old_project_ids):
        assert project.is_deleted is True
        assert project.deleted_at is not None
        assert project.deleted_by_id == seed_owner.pk
        # Detached, so restoring one brings it back standalone rather than under
        # a tombstoned parent.
        assert project.program_id is None
    existing.refresh_from_db()
    assert existing.is_deleted is True

    # server_version bumped => the row is a real tombstone for the sync delta.
    for task in Task.objects.filter(pk__in=old_task_ids):
        assert task.pk in set(old_task_ids)


def test_replaced_projects_appear_in_trash_and_are_restorable(seed_owner: Any) -> None:
    """ "Moves to Trash" is asserted through the actual Trash surface, not inferred."""
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    old_project_ids = {
        str(pk) for pk in Project.objects.filter(program=existing).values_list("pk", flat=True)
    }

    client = _client(seed_owner)
    resp = _import_via_api(client, _seed(), replace=True)
    assert resp.status_code == 202, resp.content

    trash = client.get("/api/v1/projects/trash/")
    assert trash.status_code == 200, trash.content
    rows = trash.data["results"] if isinstance(trash.data, dict) else trash.data
    listed = {str(row["id"]) for row in rows}
    assert old_project_ids <= listed

    target = next(iter(old_project_ids))
    restored = client.post(f"/api/v1/projects/{target}/restore/")
    assert restored.status_code in (200, 204), restored.content
    project = Project.objects.get(pk=target)
    assert project.is_deleted is False


def test_replace_broadcasts_a_delete_per_removed_project_on_commit(
    seed_owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """Every other delete path broadcasts; this one did not (#2581)."""
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    old_project_ids = {
        str(pk) for pk in Project.objects.filter(program=existing).values_list("pk", flat=True)
    }

    # Patched at its definition site: ``soft_delete_project`` imports it inside
    # the function body, so the name is resolved (and the mock captured into the
    # deferred partial) at call time.
    with patch("trueppm_api.apps.sync.broadcast.broadcast_board_event") as broadcast:
        with django_capture_on_commit_callbacks(execute=False) as callbacks:
            resp = _client(seed_owner).post(
                IMPORT_URL, data={**_seed(), "replace": True}, format="json"
            )
            assert resp.status_code == 202, resp.content

        # Deferred, not fired: a replace that rolls back must never tell peers a
        # live project is gone.
        assert broadcast.call_count == 0

        for callback in callbacks:
            callback()

        deleted = {
            call.args[0] for call in broadcast.call_args_list if call.args[1] == "project_deleted"
        }
        assert old_project_ids <= deleted, "one delete broadcast per removed project"
        assert any(call.args[1] == "program_deleted" for call in broadcast.call_args_list)


def test_expected_program_id_must_match_the_program_that_would_go(seed_owner: Any) -> None:
    """The compare-and-swap: a stale dry-run id must not authorize a different kill."""
    import_seed(_seed(), owner=seed_owner, create_users=False)

    resp = _client(seed_owner).post(
        IMPORT_URL,
        data={
            **_seed(),
            "replace": True,
            "expected_program_id": "00000000-0000-4000-8000-000000000000",
        },
        format="json",
    )
    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "seed_replace_mismatch"
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 1


def test_expected_program_id_matching_proceeds(seed_owner: Any) -> None:
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    resp = _import_via_api(
        _client(seed_owner), _seed(), replace=True, expected_program_id=str(existing.pk)
    )
    assert resp.status_code == 202, resp.content
    assert resp.data["replaced_program_id"] == str(existing.pk)


def test_importer_refuses_without_replace_at_the_service_layer(seed_owner: Any) -> None:
    """The gate lives in the importer, not only in the view — so every caller gets it."""
    import_seed(_seed(), owner=seed_owner, create_users=False)
    with pytest.raises(SeedReplaceRequired):
        import_seed(_seed(), owner=seed_owner, create_users=False)

    with pytest.raises(SeedReplaceMismatch):
        import_seed(
            _seed(),
            owner=seed_owner,
            create_users=False,
            replace=True,
            expected_program_id="00000000-0000-4000-8000-000000000000",
        )


# --- #994 / #2476 regression guards -----------------------------------------


def test_a_non_owners_same_code_program_is_never_touched(seed_owner: Any, stranger: Any) -> None:
    """#994: Program.code is user-assigned and non-unique — collisions are real."""
    victim = import_seed(_seed(), owner=stranger, create_users=False)
    victim_projects = list(Project.objects.filter(program=victim).values_list("pk", flat=True))

    # `seed_owner` owns nothing with this code, so there is no collision for them at
    # all: the import proceeds and creates a second, independent program.
    resp = _import_via_api(_client(seed_owner), _seed(), replace=True)
    assert resp.status_code == 202, resp.content

    victim.refresh_from_db()
    assert victim.is_deleted is False
    assert Project.objects.filter(pk__in=victim_projects, is_deleted=False).count() == len(
        victim_projects
    )
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 2


def test_a_program_the_caller_only_admins_is_not_replaceable(
    seed_owner: Any, stranger: Any
) -> None:
    """The scope is OWNER, not "can see" — an ADMIN grant must not authorize a teardown."""
    victim = import_seed(_seed(), owner=stranger, create_users=False)
    ProgramMembership.objects.update_or_create(
        program=victim, user=seed_owner, defaults={"role": Role.ADMIN}
    )

    resp = _import_via_api(_client(seed_owner), _seed(), replace=True)
    assert resp.status_code == 202, resp.content

    victim.refresh_from_db()
    assert victim.is_deleted is False


def test_sample_reload_refuses_a_program_holding_a_real_project(seed_owner: Any) -> None:
    """#2476: a sample reload can never purge real work, even the caller's own."""
    program = import_seed(_seed(), owner=seed_owner, create_users=False)
    real = Project.objects.filter(program=program).first()
    assert real is not None and real.is_sample is False

    # is_sample + replace=True is the most permissive combination there is; the
    # mixed-program guard must still hold.
    import_seed(_seed(), owner=seed_owner, create_users=True, is_sample=True, replace=True)

    program.refresh_from_db()
    assert program.is_deleted is False
    real.refresh_from_db()
    assert real.is_deleted is False
    # A second, separate sample program was created alongside it.
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 2


def test_sample_replace_stays_a_hard_delete(seed_owner: Any) -> None:
    """Disposable demo data is purged outright — deliberately not tombstoned."""
    first = import_seed(_seed(), owner=seed_owner, create_users=True, is_sample=True)
    import_seed(_seed(), owner=seed_owner, create_users=True, is_sample=True, replace=True)

    assert not Program.objects.filter(pk=first.pk).exists()
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 1


# --- #2574: async rebuild ---------------------------------------------------


def test_import_returns_202_with_a_job_and_does_not_rebuild_inline(
    seed_owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """The #2574 fix: the request queues, it does not build."""
    with (
        patch("trueppm_api.apps.projects.tasks.run_program_import.delay") as delay,
        django_capture_on_commit_callbacks(execute=True),
    ):
        resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")

    assert resp.status_code == 202, resp.content
    assert resp.data["queued"] is True
    job = ProgramImportJob.objects.get(pk=resp.data["import_request_id"])
    assert job.status == ImportJobStatus.PENDING
    delay.assert_called_once_with(str(job.pk))

    # The program shell exists immediately — that is what the client lands on —
    # but nothing under it has been built yet.
    program = Program.objects.get(pk=resp.data["program_id"])
    assert program.code == "atlas"
    assert Project.objects.filter(program=program).count() == 0
    assert Task.objects.filter(project__program=program).count() == 0


def test_job_transitions_to_success_and_the_entities_land(seed_owner: Any) -> None:
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    assert resp.status_code == 202, resp.content
    job_id = resp.data["import_request_id"]
    program_id = resp.data["program_id"]

    _run_job(job_id)

    job = ProgramImportJob.objects.get(pk=job_id)
    assert job.status == ImportJobStatus.SUCCESS
    assert job.error_detail == ""
    assert job.completed_at is not None
    assert job.result_summary["projects"] == 2
    assert job.result_summary["tasks"] == 3

    program = Program.objects.get(pk=program_id)
    assert Project.objects.filter(program=program, is_deleted=False).count() == 2
    assert Task.objects.filter(project__program=program, is_deleted=False).count() == 3


def test_job_status_endpoint_reports_progress_and_is_program_scoped(
    seed_owner: Any, stranger: Any
) -> None:
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    job_id = resp.data["import_request_id"]
    program_id = resp.data["program_id"]
    _run_job(job_id)

    url = f"/api/v1/programs/{program_id}/import/jobs/{job_id}/"
    poll = _client(seed_owner).get(url)
    assert poll.status_code == 200, poll.content
    assert poll.data["status"] == ImportJobStatus.SUCCESS
    assert poll.data["result_summary"]["tasks"] == 3
    # The storage key for the uploaded payload is never exposed.
    assert "file_path" not in poll.data

    # A stranger cannot read it (program-scoped object lookup).
    assert _client(stranger).get(url).status_code in (403, 404)

    # Nor can a job id be read through a program it does not belong to.
    stranger_program = import_seed(_seed(), owner=stranger, create_users=False)
    crossed = _client(stranger).get(f"/api/v1/programs/{stranger_program.pk}/import/jobs/{job_id}/")
    assert crossed.status_code == 404


def test_a_failed_import_leaves_no_partial_subtree_and_says_why(seed_owner: Any) -> None:
    """A mid-import failure must be visible, not silent — and must not half-build."""
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    job_id = resp.data["import_request_id"]
    program_id = resp.data["program_id"]

    with patch(
        "trueppm_api.apps.projects.seed.importer._SeedImporter.run",
        side_effect=RuntimeError("disk on fire"),
    ):
        _run_job(job_id)

    job = ProgramImportJob.objects.get(pk=job_id)
    assert job.status == ImportJobStatus.FAILED
    assert "disk on fire" in job.error_detail

    # The failed build rolled back: the shell survives (so the Owner can see the
    # failure and delete or retry) but nothing was half-created under it.
    assert Program.objects.filter(pk=program_id).exists()
    assert Project.objects.filter(program_id=program_id).count() == 0
    assert Task.objects.filter(project__program_id=program_id).count() == 0


def test_a_duplicate_delivery_does_not_double_the_subtree(seed_owner: Any) -> None:
    """The worker is purely additive now, so the claim is load-bearing (ADR-0726 §11)."""
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    job_id = resp.data["import_request_id"]
    program_id = resp.data["program_id"]

    _run_job(job_id)
    _run_job(job_id)  # drain re-dispatch / acks_late redelivery

    assert Task.objects.filter(project__program_id=program_id, is_deleted=False).count() == 3
    assert Project.objects.filter(program_id=program_id, is_deleted=False).count() == 2


def test_a_second_import_for_the_same_program_reuses_the_in_flight_job(seed_owner: Any) -> None:
    """Per-program de-dupe: the async path must not become a queue amplifier."""
    from trueppm_api.apps.projects.services import enqueue_program_import, store_seed_payload

    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    program = Program.objects.get(pk=resp.data["program_id"])

    again = enqueue_program_import(
        program=program,
        requested_by=seed_owner,
        payload_path=store_seed_payload(json.dumps(_seed()).encode("utf-8")),
    )
    assert str(again.pk) == resp.data["import_request_id"]
    assert ProgramImportJob.objects.filter(program=program).count() == 1


# --- #2574: batched writes --------------------------------------------------


def test_batched_writes_are_o_batches_not_o_entities(seed_owner: Any) -> None:
    """Query count must not scale with task count — the point of the batching.

    Two seeds differing only in task count are imported; the query delta is the
    signal. Per-row saves would grow the count by ~4 per task (server_version
    bump, sync_seq allocation, short_id allocation, history INSERT).
    """
    from django.db import connection
    from django.test.utils import CaptureQueriesContext

    def _count_for(extra_tasks: int) -> int:
        seed = json.loads(json.dumps(_seed()))
        project = seed["projects"][0]
        base = project["tasks"][0]
        for i in range(extra_tasks):
            clone = json.loads(json.dumps(base))
            clone["wbs_path"] = f"9.{i + 1}"
            clone["name"] = f"Bulk task {i}"
            clone.pop("sprint", None)
            clone.pop("estimate", None)
            project["tasks"].append(clone)
        seed["program"]["slug"] = f"bulk{extra_tasks}"
        user = User.objects.create_user(username=f"bulk-{extra_tasks}")
        with CaptureQueriesContext(connection) as ctx:
            import_seed(seed, owner=user, create_users=False)
        return len(ctx)

    small = _count_for(5)
    large = _count_for(45)

    # 40 extra tasks. Per-row saving cost ~4 queries each (~160); batched, the
    # marginal cost is a handful of statements regardless of batch size.
    assert large - small < 40, f"query count scaled with tasks: {small} -> {large}"


def test_batched_rows_keep_their_sync_and_history_invariants(seed_owner: Any) -> None:
    """bulk_create skips three things save() does; all three are silent if lost."""
    program = import_seed(_seed(), owner=seed_owner, create_users=False)
    tasks = list(Task.objects.filter(project__program=program))
    assert tasks

    for task in tasks:
        # server_version is 1:1 with history rows (the ADR-0217 merge slices it).
        assert task.server_version == 1
        # sync_seq 0 would make the row invisible to the delta pull forever —
        # not even a cold start with since=0 would return it (ADR-0686).
        assert task.sync_seq > 0
        assert task.history.count() == 1
        # short_id is per-project unique; a blank one collides on the second row.
        assert task.short_id

    assert len({t.short_id for t in tasks}) == len(tasks)

    for sprint in Sprint.objects.filter(project__program=program):
        assert sprint.server_version == 1
        assert sprint.sync_seq > 0
        assert sprint.short_id

    for dep in Dependency.objects.filter(predecessor__project__program=program):
        assert dep.server_version == 1
        assert dep.sync_seq > 0


def test_seeded_signoff_states_are_coerced_to_full_progress(seed_owner: Any) -> None:
    """Task.save() forces percent_complete=100 in REVIEW/COMPLETE; the batch must too."""
    seed = json.loads(json.dumps(_seed()))
    task = seed["projects"][0]["tasks"][0]
    task["status"] = "COMPLETE"
    task["percent_complete"] = 42.0
    seed["program"]["slug"] = "signoff"

    program = import_seed(seed, owner=seed_owner, create_users=False)
    landed = Task.objects.get(project__program=program, name=task["name"])
    assert landed.percent_complete == 100.0
    assert landed.status_changed_at is not None


# --- dry run surfaces the pending replacement (#2418 + ADR-0726 §7) ---------


def test_dry_run_names_what_would_be_replaced(seed_owner: Any) -> None:
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)

    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["valid"] is True
    assert resp.data["replaces"]["program_id"] == str(existing.pk)
    assert resp.data["replaces"]["project_count"] == 2


def test_dry_run_reports_no_replacement_when_the_slug_is_free(seed_owner: Any) -> None:
    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["replaces"] is None


def test_dry_run_does_not_name_another_users_program(seed_owner: Any, stranger: Any) -> None:
    """The preview inherits the #994 ownership scope — it is not a lookup oracle."""
    import_seed(_seed(), owner=stranger, create_users=False)

    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")
    assert resp.status_code == 200, resp.content
    assert resp.data["replaces"] is None


def test_dry_run_still_persists_nothing_with_a_collision_present(seed_owner: Any) -> None:
    existing = import_seed(_seed(), owner=seed_owner, create_users=False)
    before = Program.objects.count()

    _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")

    assert Program.objects.count() == before
    existing.refresh_from_db()
    assert existing.is_deleted is False


# --- the dry run's declared 200 must accept the body it actually sends (#2649) ---
#
# ``api:schema-drift`` cannot catch this class: it only proves the committed
# document matches what the code declares, and both agreed on a ``replaces`` that
# was never nullable. ``api:fuzz`` found it, on ``main``, hours after merge —
# these three tests move the same check to MR time.


@pytest.fixture(scope="module")
def committed_schema() -> dict[str, Any]:
    return load_committed_schema()


def test_dry_run_null_replaces_matches_its_declared_schema(
    committed_schema: dict[str, Any], seed_owner: Any
) -> None:
    """The ordinary answer — free slug, nothing to tear down — must validate.

    This is the majority case, not an edge: every first import of a document
    reports ``replaces: null``. The pre-fix schema typed the key as a plain
    ``$ref``, so a generated SDK typed it non-null and every ordinary dry run
    violated the published contract.
    """
    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")

    assert resp.json()["replaces"] is None
    assert_response_matches_schema(
        committed_schema, resp, "/api/v1/programs/import/validate/", method="post"
    )


def test_dry_run_populated_replaces_matches_its_declared_schema(
    committed_schema: dict[str, Any], seed_owner: Any
) -> None:
    """Making the key nullable must not stop the object branch from being described."""
    import_seed(_seed(), owner=seed_owner, create_users=False)

    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")

    assert resp.json()["replaces"]["project_count"] == 2
    assert_response_matches_schema(
        committed_schema, resp, "/api/v1/programs/import/validate/", method="post"
    )


def test_dry_run_on_a_document_that_is_not_a_seed_matches_its_declared_schema(
    committed_schema: dict[str, Any], seed_owner: Any
) -> None:
    """The exact ``api:fuzz`` case: a program-create payload posted to the dry run.

    A document with no ``program`` key at all is answered ``200 {"valid": false}``
    — the request succeeded, the document is what failed — and ``replaces`` is
    ``null`` because there is no slug to collide with. Kept verbatim from the
    fuzzer's reproduction so the case that reached ``main`` is the case pinned.
    """
    resp = _client(seed_owner).post(
        VALIDATE_URL,
        data={"name": "0", "description": "", "code": "", "methodology": "WATERFALL"},
        format="json",
    )

    body = resp.json()
    assert body["valid"] is False
    assert body["replaces"] is None
    assert_response_matches_schema(
        committed_schema, resp, "/api/v1/programs/import/validate/", method="post"
    )


def test_the_pre_fix_declaration_rejects_a_null_replaces(
    committed_schema: dict[str, Any], seed_owner: Any
) -> None:
    """The guard must bite — validate the real body against the schema we replaced.

    Without this, the three tests above would still pass if ``replaces`` were
    quietly dropped from ``required`` or the validator stopped resolving the
    ``$ref``, and the regression they exist to catch would walk straight back in.
    """
    body = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json").json()

    pre_fix_declaration = as_json_schema(
        {
            "$ref": "#/components/schemas/SeedValidateResponse",
            "components": {
                **committed_schema["components"],
                "schemas": {
                    **committed_schema["components"]["schemas"],
                    "SeedValidateResponse": {
                        **committed_schema["components"]["schemas"]["SeedValidateResponse"],
                        "properties": {
                            **committed_schema["components"]["schemas"]["SeedValidateResponse"][
                                "properties"
                            ],
                            "replaces": {"$ref": "#/components/schemas/SeedReplaceConflict"},
                        },
                    },
                },
            },
        }
    )
    errors = list(Draft202012Validator(pre_fix_declaration).iter_errors(body))

    assert errors, "a null `replaces` must NOT validate against the old non-nullable $ref"
    assert "is not of type 'object'" in errors[0].message


# --- upload ceiling on BOTH branches ----------------------------------------


def test_json_body_branch_honors_the_upload_ceiling(seed_owner: Any, settings: Any) -> None:
    """The raw-body path was capped only by DATA_UPLOAD_MAX_MEMORY_SIZE (100 MB).

    Posting the same document as a body instead of a file bypassed
    SEED_MAX_UPLOAD_MB entirely, which is what made MAX_SEED_NODES reachable.
    """
    settings.SEED_MAX_UPLOAD_MB = 0
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    assert resp.status_code == 400, resp.content
    assert "too large" in resp.data["detail"]
    assert not Program.objects.filter(code="atlas").exists()


def test_dry_run_json_body_branch_honors_the_upload_ceiling(seed_owner: Any, settings: Any) -> None:
    settings.SEED_MAX_UPLOAD_MB = 0
    resp = _client(seed_owner).post(VALIDATE_URL, data=_seed(), format="json")
    assert resp.status_code == 400
    assert "too large" in resp.data["detail"]


# --- bundled samples stay small enough to import synchronously --------------


def test_every_bundled_sample_stays_under_the_synchronous_ceiling() -> None:
    """`load-sample` stays synchronous (ADR-0726 §10) — hold its premise to it.

    The four bundled fixtures are tens of nodes, so the synchronous path is a
    slow click rather than a 504 risk. That is an assumption about *fixtures*,
    which is exactly the kind that rots silently; this makes it an invariant a
    future sample cannot break without failing here first.
    """
    from trueppm_api.apps.projects.seed.samples import SAMPLES

    max_sample_nodes = 2_000
    assert SAMPLES, "no bundled samples registered"
    for key, sample in SAMPLES.items():
        if not sample.path.exists():
            continue
        payload = json.loads(sample.path.read_text(encoding="utf-8"))
        total = len(payload.get("risks", []))
        for project in payload.get("projects", []):
            total += (
                len(project.get("tasks", []))
                + len(project.get("dependencies", []))
                + len(project.get("sprints", []))
                + len(project.get("risks", []))
            )
        assert total <= max_sample_nodes, (
            f"sample {key!r} has {total} nodes — past {max_sample_nodes}, "
            "load-sample must move to the async import path"
        )


def test_multipart_import_carries_the_filename_onto_the_job(seed_owner: Any) -> None:
    upload = SimpleUploadedFile(
        "atlas.json", json.dumps(_seed()).encode("utf-8"), content_type="application/json"
    )
    resp = _client(seed_owner).post(IMPORT_URL, data={"file": upload}, format="multipart")
    assert resp.status_code == 202, resp.content
    job = ProgramImportJob.objects.get(pk=resp.data["import_request_id"])
    assert job.filename == "atlas.json"


# --- guarded set == destroyed set (multi-candidate) --------------------------


def test_two_owned_programs_sharing_a_code_are_never_replaced_blind(seed_owner: Any) -> None:
    """``Program.code`` is non-unique, so a caller can own two under one slug.

    A single ``conflict`` object can describe only one of them, so a bare
    ``replace=true`` must not tear down the other — the caller would never have
    been shown its counts, and no audit field would record it.
    """
    first = import_seed(_seed(), owner=seed_owner, create_users=False)
    second = import_seed(_seed(), owner=seed_owner, create_users=False, replace=True)
    # Resurrect the first so both are live under code "atlas".
    Program.objects.filter(pk=first.pk).update(is_deleted=False)
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 2

    resp = _client(seed_owner).post(IMPORT_URL, data={**_seed(), "replace": True}, format="json")

    assert resp.status_code == 409, resp.content
    assert resp.data["code"] == "seed_replace_ambiguous"
    named = {c["program_id"] for c in resp.data["conflicts"]}
    assert named == {str(first.pk), str(second.pk)}
    # Both survive untouched.
    assert Program.objects.filter(code="atlas", is_deleted=False).count() == 2


def test_expected_program_id_narrows_the_teardown_to_the_named_program(seed_owner: Any) -> None:
    """Naming one of two resolves the ambiguity — and spares the other."""
    first = import_seed(_seed(), owner=seed_owner, create_users=False)
    second = import_seed(_seed(), owner=seed_owner, create_users=False, replace=True)
    Program.objects.filter(pk=first.pk).update(is_deleted=False)

    resp = _import_via_api(
        _client(seed_owner), _seed(), replace=True, expected_program_id=str(first.pk)
    )
    assert resp.status_code == 202, resp.content
    assert resp.data["replaced_program_id"] == str(first.pk)

    first.refresh_from_db()
    second.refresh_from_db()
    assert first.is_deleted is True
    assert second.is_deleted is False, "the unnamed program must survive"


# --- the sample hard-delete path must still tell connected clients ----------


def test_sample_replace_broadcasts_the_hard_delete(
    seed_owner: Any, django_capture_on_commit_callbacks: Any
) -> None:
    """A hard delete leaves no tombstone, so the broadcast is the only signal."""
    first = import_seed(_seed(), owner=seed_owner, create_users=True, is_sample=True)
    doomed = {str(pk) for pk in Project.objects.filter(program=first).values_list("pk", flat=True)}

    # Patched where the importer *binds* it: ``seed/importer.py`` imports the
    # name at module load, so patching the source module would leave the bound
    # reference untouched and the callback would hit a real broker.
    with (
        patch("trueppm_api.apps.projects.seed.importer.broadcast_board_event") as broadcast,
        django_capture_on_commit_callbacks(execute=True),
    ):
        import_seed(_seed(), owner=seed_owner, create_users=True, is_sample=True, replace=True)

    hard = {
        call.args[0] for call in broadcast.call_args_list if call.args[1] == "project_hard_deleted"
    }
    assert doomed <= hard, "one hard-delete event per purged sample project"
    assert any(call.args[1] == "program_deleted" for call in broadcast.call_args_list)


# --- the job poll's role floor ----------------------------------------------


def test_job_poll_requires_admin_not_merely_membership(seed_owner: Any, stranger: Any) -> None:
    """Pins the ``IsProgramAdmin`` floor.

    Without this, a regression of that permission line to the ``IsAuthenticated``
    fallthrough would leave every other test in this file green while any Viewer
    on the program could read the job's cross-project entity counts.
    """
    resp = _client(seed_owner).post(IMPORT_URL, data=_seed(), format="json")
    program_id = resp.data["program_id"]
    job_id = resp.data["import_request_id"]
    _run_job(job_id)
    url = f"/api/v1/programs/{program_id}/import/jobs/{job_id}/"

    membership, _ = ProgramMembership.objects.update_or_create(
        program_id=program_id, user=stranger, defaults={"role": Role.MEMBER}
    )
    assert _client(stranger).get(url).status_code == 403

    membership.role = Role.ADMIN
    membership.save(update_fields=["role"])
    assert _client(stranger).get(url).status_code == 200


def test_batched_inserts_are_sliced_not_one_giant_statement(seed_owner: Any) -> None:
    """A single unbounded INSERT is a worker OOM, not a slow query (ADR-0726 §8)."""
    from trueppm_api.apps.projects.seed.importer import _BULK_BATCH_SIZE

    assert _BULK_BATCH_SIZE > 0
    seed = json.loads(json.dumps(_seed()))
    project = seed["projects"][0]
    base = project["tasks"][0]
    for i in range(_BULK_BATCH_SIZE + 5):
        clone = json.loads(json.dumps(base))
        clone["wbs_path"] = f"7.{i + 1}"
        clone["name"] = f"Sliced task {i}"
        clone.pop("sprint", None)
        clone.pop("estimate", None)
        project["tasks"].append(clone)
    seed["program"]["slug"] = "sliced"

    program = import_seed(seed, owner=seed_owner, create_users=False)

    landed = Task.objects.filter(project__program=program, name__startswith="Sliced task")
    assert landed.count() == _BULK_BATCH_SIZE + 5
    # Crossing a batch boundary must not break the invariants the slices carry.
    assert landed.filter(sync_seq=0).count() == 0
    assert landed.filter(short_id="").count() == 0
    assert len({t.short_id for t in landed}) == landed.count()
