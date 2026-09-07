"""DB tests for the seed exporter and the round-trip guarantee (issue #616)."""

from __future__ import annotations

from typing import Any

import pytest
from django.contrib.auth import get_user_model

from trueppm_api.apps.projects.seed import (
    export_program,
    export_project,
    import_seed,
    validate_seed,
)
from trueppm_api.apps.projects.seed.exporter import dump_seed

from .test_importer import _seed  # reuse the two-project fixture

pytestmark = pytest.mark.django_db

User = get_user_model()


@pytest.fixture
def owner() -> Any:
    return User.objects.create_user(username="exporter-owner", email="o@example.com")


def test_export_validates_against_schema(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)
    # The exporter's output must itself be a valid seed document.
    validate_seed(exported)
    assert exported["schema_version"] == "1.0"
    assert exported["program"]["slug"] == "atlas"


def test_export_strips_derived_fields(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)
    task = exported["projects"][0]["tasks"][0]
    for derived in ("server_version", "short_id", "early_start", "early_finish", "is_critical"):
        assert derived not in task


def test_labels_round_trip_through_export_import(owner: Any) -> None:
    """ADR-0400 labels (#1089) fold into the seed and survive export→import (#1958).

    Slug-based identity (no UUID) consistent with the seed contract; the label's
    name + color and its task attachment must re-materialize on re-import.
    """
    from trueppm_api.apps.projects.models import Label, Task, TaskLabel

    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.order_by("name").first()
    assert project is not None
    task = Task.objects.filter(project=project).order_by("wbs_path").first()
    assert task is not None
    label = Label.objects.create(project=project, name="Needs Review", color="amber", position=1)
    TaskLabel.objects.create(task=task, label=label)

    exported = export_program(program)
    validate_seed(exported)  # the labels block must be schema-valid
    project_block = next(p for p in exported["projects"] if p["name"] == project.name)
    label_blocks = project_block.get("labels", [])
    assert any(b["name"] == "Needs Review" and b["color"] == "amber" for b in label_blocks)
    # The task carries the label slug in its labels list.
    label_slug = next(b["slug"] for b in label_blocks if b["name"] == "Needs Review")
    tblock = next(t for t in project_block["tasks"] if label_slug in t.get("labels", []))
    assert tblock is not None

    # Re-import into a fresh program: the label and its attachment survive.
    # replace=True: the re-import lands on the same program slug, which now
    # requires explicit consent (ADR-0726). It is what this call always did.
    program2 = import_seed(exported, owner=owner, create_users=True, replace=True)
    project2 = program2.projects.get(name=project.name)
    label2 = Label.objects.filter(project=project2, name="Needs Review").first()
    assert label2 is not None
    assert label2.color == "amber"
    assert label2.position == 1
    assert TaskLabel.objects.filter(label=label2).count() == 1


def test_round_trip_is_stable(owner: Any) -> None:
    # #616 guarantee: export -> re-import -> re-export is byte-identical.
    program1 = import_seed(_seed(), owner=owner, create_users=True)
    export1 = export_program(program1)

    program2 = import_seed(export1, owner=owner, create_users=True, replace=True)
    export2 = export_program(program2)

    assert dump_seed(export1) == dump_seed(export2)


def test_round_trip_preserves_key_facts(owner: Any) -> None:
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)

    projects = {p["slug"]: p for p in exported["projects"]}
    assert set(projects) >= {"platform-core", "migration-tooling"}

    # cross-project dependency survives as a qualified ref
    mt = projects["migration-tooling"]
    dep = mt["dependencies"][0]
    assert dep["predecessor"].startswith("platform-core:")
    assert dep["dep_type"] == "FS" and dep["lag"] == 2

    # three-point estimate preserved
    etl = next(t for t in mt["tasks"] if t["name"] == "ETL")
    assert etl["estimate"] == {"optimistic": 3, "most_likely": 5, "pessimistic": 12}


# --- single-project export (#967) ------------------------------------------


def test_export_project_wraps_single_project(owner: Any) -> None:
    # A project export wraps exactly one project in a synthesized program block
    # derived from the project itself (ADR-0109 #967 addendum) — not the parent.
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    doc = export_project(project)

    validate_seed(doc)  # the project export must itself be a valid seed document
    assert doc["schema_version"] == "1.0"
    assert len(doc["projects"]) == 1
    assert doc["projects"][0]["name"] == "Platform Core"
    # synthesized wrapper: program name is the project's, not the parent's ("Atlas...")
    assert doc["program"]["name"] == "Platform Core"
    # tasks come along
    assert any(t["name"] == "Build auth" for t in doc["projects"][0]["tasks"])


def test_export_project_drops_cross_project_dependencies(owner: Any) -> None:
    # A single-project export cannot reference the sibling project, so a
    # cross-project dependency (predecessor in another project) is omitted —
    # keeping the doc self-contained and re-importable.
    program = import_seed(_seed(), owner=owner, create_users=True)
    migration = program.projects.get(name="Migration Tooling")
    doc = export_project(migration)

    validate_seed(doc)
    for dep in doc["projects"][0].get("dependencies", []):
        # No qualified "<other-project>:..." predecessor refs survive.
        assert ":" not in dep["predecessor"]


def test_export_project_round_trip_is_stable(owner: Any) -> None:
    # #616 guarantee at project grain: export -> re-import -> re-export is
    # byte-identical (re-export via the same project-export path).
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")

    doc1 = export_project(project)
    program2 = import_seed(doc1, owner=owner, create_users=True, replace=True)
    project2 = program2.projects.get()
    doc2 = export_project(project2)

    assert dump_seed(doc1) == dump_seed(doc2)


def test_export_project_standalone_has_no_program(owner: Any) -> None:
    # A standalone project (Project.program is NULL, ADR-0070) still exports a
    # valid, round-trippable doc via the synthesized single-project wrapper.
    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    project.program = None
    project.save(update_fields=["program"])

    doc = export_project(project)
    validate_seed(doc)
    assert doc["program"]["name"] == "Platform Core"
    assert len(doc["projects"]) == 1


def test_calendar_exceptions_round_trip_through_v1(owner: Any) -> None:
    """A calendar with non-working exception ranges exports and re-imports (#2006).

    Regression: the exporter emitted ``calendars[].exceptions`` on the default
    v1 path, but the v1 schema (``additionalProperties: false``) rejected it, so
    any program with a holiday/shutdown could not be re-imported after export.
    """
    from datetime import date

    from trueppm_api.apps.projects.models import Calendar, CalendarException

    program = import_seed(_seed(), owner=owner, create_users=True)
    calendar = Calendar.objects.get(pk=program.projects.get(name="Platform Core").calendar_id)
    CalendarException.objects.create(
        calendar=calendar,
        exc_start=date(2026, 12, 24),
        exc_end=date(2026, 12, 26),
        description="Winter shutdown",
    )

    exported = export_program(program)
    # The offending field must now round-trip through v1 validation.
    validate_seed(exported)
    assert exported["schema_version"] == "1.0"
    cal_block = next(c for c in exported["calendars"] if c.get("exceptions"))
    assert cal_block["exceptions"] == [
        {"exc_start": "2026-12-24", "exc_end": "2026-12-26", "description": "Winter shutdown"}
    ]

    # Re-importing must materialize the exception back onto the calendar.
    reimported = import_seed(exported, owner=owner, create_users=True, replace=True)
    re_cal = Calendar.objects.get(pk=reimported.projects.get(name="Platform Core").calendar_id)
    assert re_cal.exceptions.count() == 1


def test_long_risk_title_slug_is_capped_at_40(owner: Any) -> None:
    """A risk title longer than 40 chars still emits a schema-valid slug (#2006).

    Regression: the export-only slug was slugified from the title with no length
    cap, so a descriptive risk title overflowed the schema's ``maxLength: 40``.
    """
    from trueppm_api.apps.projects.models import Risk

    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    # Two titles identical through their first >40 chars collapse to the same
    # 40-char base slug, so the second must trigger the collision-safe suffix
    # path (base trimmed to make room for "-2", re-stripped, still ≤ 40).
    Risk.objects.create(
        project=project,
        title="Cross-team dependency stalls the critical path in Q3",
        status="OPEN",
        probability=4,
        impact=5,
    )
    Risk.objects.create(
        project=project,
        title="Cross-team dependency stalls the critical path in Q4",
        status="OPEN",
        probability=3,
        impact=4,
    )

    exported = export_program(program)
    validate_seed(exported)

    project_block = next(p for p in exported["projects"] if p["slug"] == "platform-core")
    slugs = [r["slug"] for r in project_block["risks"]]
    assert all(len(s) <= 40 for s in slugs), slugs
    # Slugs must stay unique and kebab-case-valid even after truncation.
    assert len(set(slugs)) == len(slugs)
    assert all(not s.startswith("-") and not s.endswith("-") for s in slugs)


def test_risk_blocks_export_is_not_n_plus_1(owner: Any, django_assert_num_queries: Any) -> None:
    """Risk export must not fire a per-risk query for owners or task links (#2351).

    Regression lock: the loop resolves each risk's ``owner`` slug and its M2M task
    links. Before the fix these fired a query *per risk* (owner FK + through-table
    lookup); the queryset now ``select_related("owner").prefetch_related("tasks")``
    so the whole loop is a constant two queries (risks + task prefetch) regardless
    of risk count.
    """
    from trueppm_api.apps.projects.models import Risk, Task
    from trueppm_api.apps.projects.seed.exporter import _Exporter

    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    linked_tasks = list(Task.objects.filter(project=project, wbs_path__isnull=False)[:2])
    for n in range(4):
        risk = Risk.objects.create(
            project=project,
            title=f"N+1 probe risk {n}",
            status="OPEN",
            probability=3,
            impact=3,
            owner=owner,
        )
        risk.tasks.add(*linked_tasks)

    exporter = _Exporter(program=program, projects=[project])
    exporter.project_slugs[project.pk] = "platform-core"
    exporter._project_tasks = {}
    exporter._project_sprints = {}
    exporter._index_project(project)  # populate task_ref (queries run outside the assert)

    # Two queries total: the risks fetch (owner joined in) + the tasks prefetch.
    with django_assert_num_queries(2):
        blocks = exporter._risk_blocks(project, "platform-core")

    probe_blocks = [b for b in blocks if b["title"].startswith("N+1 probe risk")]
    assert len(probe_blocks) == 4
    assert all(b.get("tasks") for b in probe_blocks)


def test_board_columns_round_trip_and_omit_unset_metadata(owner: Any) -> None:
    """The board config exports in the shape the importer reads back (#3093).

    Optional per-column metadata is emitted only when set: a project that merely
    renamed its columns must round-trip as a rename, not as a config that also
    pins every null. The importer stores the nulls explicitly, so without the
    omission the second export would not be byte-stable against the first.
    """
    from trueppm_api.apps.projects.models import BoardColumnConfig

    program = import_seed(_seed(), owner=owner, create_users=True)
    project = program.projects.get(name="Platform Core")
    BoardColumnConfig.objects.create(
        project=project,
        columns=[
            {"status": "BACKLOG", "label": "Icebox", "visible": False, "color": "#8B5CF6"},
            {
                "status": "NOT_STARTED",
                "label": "Ready",
                "visible": True,
                "wip_limit": 3,
                "age_threshold_days": 5,
            },
            {
                "status": "IN_PROGRESS",
                "label": "Building",
                "visible": True,
                "lanes": [
                    {"key": "frontend", "label": "Frontend", "wip_limit": 2},
                    {"key": "backend", "label": "Backend", "wip_limit": None},
                ],
            },
            {"status": "REVIEW", "label": "Review", "visible": True, "wip_limit": 2},
            {
                "status": "COMPLETE",
                "label": "Shipped",
                "visible": True,
                "color": None,
                "wip_limit": None,
                "age_threshold_days": None,
                "lanes": [],
            },
        ],
    )

    exported = export_program(program)
    validate_seed(exported)
    block = next(p for p in exported["projects"] if p["name"] == project.name)
    columns = block["board_columns"]
    assert [c["status"] for c in columns] == [
        "BACKLOG",
        "NOT_STARTED",
        "IN_PROGRESS",
        "REVIEW",
        "COMPLETE",
    ]

    by_status = {c["status"]: c for c in columns}
    assert by_status["BACKLOG"] == {
        "status": "BACKLOG",
        "label": "Icebox",
        "visible": False,
        "color": "#8B5CF6",
    }
    assert by_status["NOT_STARTED"]["wip_limit"] == 3
    assert by_status["NOT_STARTED"]["age_threshold_days"] == 5
    # Every unset value is absent, not null — including the lane's own wip_limit.
    assert by_status["COMPLETE"] == {"status": "COMPLETE", "label": "Shipped", "visible": True}
    assert by_status["IN_PROGRESS"]["lanes"] == [
        {"key": "frontend", "label": "Frontend", "wip_limit": 2},
        {"key": "backend", "label": "Backend"},
    ]

    # Re-import: the config materializes with the same authored values.
    program2 = import_seed(exported, owner=owner, create_users=True, replace=True)
    project2 = program2.projects.get(name=project.name)
    config2 = BoardColumnConfig.objects.get(project=project2)
    assert [c["label"] for c in config2.columns] == [
        "Icebox",
        "Ready",
        "Building",
        "Review",
        "Shipped",
    ]
    assert config2.columns[0]["visible"] is False
    assert config2.columns[3]["wip_limit"] == 2
    assert config2.columns[2]["lanes"][0] == {
        "key": "frontend",
        "label": "Frontend",
        "wip_limit": 2,
    }
    # A second export is byte-stable against the first — the null-pinning check.
    reexported = next(p for p in export_program(program2)["projects"] if p["name"] == project.name)
    assert reexported["board_columns"] == columns


def test_a_project_with_no_board_config_omits_the_key(owner: Any) -> None:
    """Absent config must stay absent — emitting the API's hardcoded defaults
    would turn "uses the defaults" into "pinned today's defaults" on re-import.
    """
    program = import_seed(_seed(), owner=owner, create_users=True)
    exported = export_program(program)
    project = program.projects.get(name="Platform Core")
    block = next(p for p in exported["projects"] if p["name"] == project.name)
    assert "board_columns" not in block


# --- revoked program members must not survive the round trip (#3457) ---


def _seed_with_two_program_only_members() -> dict[str, Any]:
    """``_seed()`` plus a second account, so one can be revoked and one held live.

    ``sam`` and ``kit`` are named nowhere else in the *document* — not a task
    assignee, risk owner, resource account or the program lead — so the only
    thing that can put either of them in an export is a membership. Note the
    importer's fallback also grants each of them a ``ProjectMembership`` on every
    project (there is no ``members`` key), which is what makes this fixture able
    to tell a program revocation apart from a project one.
    """
    seed = _seed()
    seed["accounts"] = [
        *seed["accounts"],
        {"slug": "kit", "username": "seed-kit", "display_name": "Kit Osei", "role": "MEMBER"},
    ]
    return seed


def _revoke_everywhere(program: Any, user: Any) -> None:
    """Revoke a user's program membership and every project membership under it."""
    from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership

    ProgramMembership.objects.get(program=program, user=user).soft_delete()
    for pm in ProjectMembership.objects.filter(project__program=program, user=user):
        pm.soft_delete()


def test_revoked_program_member_carries_no_role_in_the_export(owner: Any) -> None:
    """#3457: a removed member must not carry a program ``role`` in the export.

    ``role`` is the only key the importer's program grant reads
    (``_ROLE_BY_NAME.get(account.get("role", ""))`` → ``None`` → skip), so its
    absence is precisely what withholds access. Asserted on the key rather than on
    the account's presence because an account block has other legitimate reasons
    to exist — being a task assignee, a resource, or, since this change, holding a
    live project membership. ``test_..._fully_removed_member_...`` below covers
    the case where nothing else references them.

    The fix has to be here rather than on the import side. The importer's
    ``_grant_program_memberships`` deliberately resets ``is_deleted`` (#3410) —
    a tombstoned row still owns the ``(program, user)`` slot, so a grant that
    touched only ``role`` would report success and confer nothing. Given a revoked
    member in the document, the importer is behaving to contract when it hands the
    role back; the defect is that the role is in the document at all.
    """
    from trueppm_api.apps.access.models import ProgramMembership

    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    revoked = User.objects.get(username="seed-sam")
    ProgramMembership.objects.get(program=program, user=revoked).soft_delete()

    exported = export_program(program)
    validate_seed(exported)

    sam_block = next(a for a in exported["accounts"] if a["username"] == "seed-sam")
    assert "role" not in sam_block
    # Paired control: the live member is exported with their role intact.
    kit_block = next(a for a in exported["accounts"] if a["username"] == "seed-kit")
    assert kit_block["role"] == "MEMBER"


def test_a_fully_removed_member_is_absent_from_the_export_entirely(owner: Any) -> None:
    """Revoked on both axes and referenced nowhere else → no account block at all.

    The paired control is the live member, who must survive untouched.
    """
    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    _revoke_everywhere(program, User.objects.get(username="seed-sam"))

    exported = export_program(program)
    validate_seed(exported)

    usernames = {a["username"] for a in exported["accounts"]}
    assert "seed-sam" not in usernames
    assert "seed-kit" in usernames
    kit_block = next(a for a in exported["accounts"] if a["username"] == "seed-kit")
    assert kit_block["role"] == "MEMBER"


def test_revoked_program_member_gains_no_access_through_the_round_trip(owner: Any) -> None:
    """#3457 end to end: revoke, export, import into a *fresh* program.

    Asserted on the round trip rather than on the export alone because the
    export is only half the mechanism — it is the re-grant on import that turns
    a stale roster entry into restored access.

    Both axes are revoked here so the assertion is the unqualified one: the user
    gains *nothing*. The narrower, more interesting case — program revoked while
    the project grant is still live — is
    ``test_program_revocation_does_not_strip_a_live_project_membership``.
    """
    from trueppm_api.apps.access.models import ProgramMembership, Role

    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    revoked = User.objects.get(username="seed-sam")
    live = User.objects.get(username="seed-kit")
    _revoke_everywhere(program, revoked)

    exported = export_program(program)
    # A distinct slug, so this is a clone into a program the revoked member has
    # never held any row on — no pre-existing tombstone can mask the result.
    exported["program"]["slug"] = "atlas-clone"
    exported["program"]["name"] = "Atlas Clone"
    clone = import_seed(exported, owner=owner, create_users=True)
    assert clone.pk != program.pk

    # No membership at all — not a live one, and not a tombstone either — on
    # either axis.
    from trueppm_api.apps.access.models import ProjectMembership

    assert not ProgramMembership.objects.filter(program=clone, user=revoked).exists()
    assert not ProjectMembership.objects.filter(project__program=clone, user=revoked).exists()
    # Paired control: the live member arrives with their role intact.
    assert (
        ProgramMembership.objects.get(program=clone, user=live, is_deleted=False).role
        == Role.MEMBER
    )
    # And the revocation on the source program was not disturbed by the export.
    assert ProgramMembership.objects.get(program=program, user=revoked).is_deleted is True


def test_program_revocation_does_not_strip_a_live_project_membership(owner: Any) -> None:
    """A program revocation must not take the member's *project* grant with it.

    Program and project membership are independent grants (ADR-0070 §RBAC). Once
    the roster stopped carrying revoked members (#3457), a user revoked from the
    program but still holding a live ``ProjectMembership`` reached
    ``_member_blocks`` with no account slug and was dropped from the document in
    silence — access lost rather than leaked, but lost. They must still be
    exported as an account *without* a role (so the importer confers no program
    membership) while their project ``members`` entry survives.
    """
    from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role

    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    revoked = User.objects.get(username="seed-sam")
    project = program.projects.get(name="Platform Core")
    # The importer's fallback already granted sam a project row; confirm it is live.
    assert ProjectMembership.objects.filter(
        project=project, user=revoked, is_deleted=False
    ).exists()
    ProgramMembership.objects.get(program=program, user=revoked).soft_delete()

    exported = export_program(program)
    validate_seed(exported)

    sam_block = next(a for a in exported["accounts"] if a["username"] == "seed-sam")
    # Present as an account, but carrying NO program role — that key is what the
    # importer's program grant keys off, so its absence is what withholds access.
    assert "role" not in sam_block
    project_block = next(p for p in exported["projects"] if p["name"] == project.name)
    assert sam_block["slug"] in {m["account"] for m in project_block["members"]}

    # Round trip into a fresh program: project grant restored, program grant not.
    exported["program"]["slug"] = "atlas-clone-2"
    exported["program"]["name"] = "Atlas Clone 2"
    clone = import_seed(exported, owner=owner, create_users=True)
    assert not ProgramMembership.objects.filter(program=clone, user=revoked).exists()
    clone_project = clone.projects.get(name=project.name)
    assert (
        ProjectMembership.objects.get(project=clone_project, user=revoked, is_deleted=False).role
        == Role.ADMIN
    )


def test_revoking_the_program_leads_membership_still_exports_a_valid_document(
    owner: Any,
) -> None:
    """The ``lead`` read is deliberately unfloored — flooring it breaks validation.

    ``Program.lead`` is a display FK distinct from the OWNER membership, and
    ``validate_seed`` requires ``$.program.lead`` to resolve to an ``accounts[]``
    entry. So a lead whose membership is revoked must still be emitted as an
    account — but without a ``role``, which is what withholds the program grant.
    This test exists so a future "floor it too, for symmetry" change fails loudly
    rather than emitting a document that fails the exporter's own validator.
    """
    from trueppm_api.apps.access.models import ProgramMembership

    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    lead = User.objects.get(username="seed-alex")
    assert program.lead_id == lead.pk
    ProgramMembership.objects.get(program=program, user=lead).soft_delete()

    exported = export_program(program)
    validate_seed(exported)  # the assertion that matters: the document still validates

    lead_block = next(a for a in exported["accounts"] if a["username"] == "seed-alex")
    assert exported["program"]["lead"] == lead_block["slug"]
    assert "role" not in lead_block

    exported["program"]["slug"] = "atlas-clone-3"
    exported["program"]["name"] = "Atlas Clone 3"
    clone = import_seed(exported, owner=owner, create_users=True)
    # Still named as the lead, but conferred no membership.
    assert clone.lead_id == lead.pk
    assert not ProgramMembership.objects.filter(program=clone, user=lead).exists()


def test_revoked_program_member_is_absent_from_the_v2_event_export_too(owner: Any) -> None:
    """The v2 (``with_events=True``) path shares ``_collect_account_users``.

    v2 derives event actor slugs from the same accounts list, so the floor has to
    hold there as well — asserted rather than assumed, because the two paths
    diverge everywhere else.
    """
    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    _revoke_everywhere(program, User.objects.get(username="seed-sam"))

    exported = export_program(program, with_events=True)
    validate_seed(exported)
    assert "seed-sam" not in {a["username"] for a in exported["accounts"]}
    assert "seed-kit" in {a["username"] for a in exported["accounts"]}


def test_revoked_project_member_is_not_written_into_the_export(owner: Any) -> None:
    """The project-side twin ``_member_blocks`` has the same contract (#3457).

    Its ``is_deleted=False`` filter predates this fix and was the precedent for
    it, but nothing on the export side pinned it — so the identical defect one
    level down was prevented only by an untested filter. A revoked project member
    must not reach ``projects[].members[]``, and must gain no project access
    through the round trip.
    """
    from trueppm_api.apps.access.models import ProjectMembership

    program = import_seed(_seed_with_two_program_only_members(), owner=owner, create_users=True)
    revoked = User.objects.get(username="seed-sam")
    project = program.projects.get(name="Platform Core")
    ProjectMembership.objects.get(project=project, user=revoked).soft_delete()

    exported = export_program(program)
    validate_seed(exported)
    sam_slug = next(a["slug"] for a in exported["accounts"] if a["username"] == "seed-sam")
    project_block = next(p for p in exported["projects"] if p["name"] == project.name)
    assert sam_slug not in {m["account"] for m in project_block.get("members", [])}

    exported["program"]["slug"] = "atlas-clone-4"
    exported["program"]["name"] = "Atlas Clone 4"
    clone = import_seed(exported, owner=owner, create_users=True)
    clone_project = clone.projects.get(name=project.name)
    assert not ProjectMembership.objects.filter(project=clone_project, user=revoked).exists()
