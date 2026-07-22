"""Per-task custom-field values — read map, typed writes, RBAC, sync (#2143, ADR-0528).

Covers the value store that #521's ``ProjectCustomField`` definitions were missing:
the flat ``custom_fields`` map on the Task read payload, the idempotent
``PUT/DELETE .../field-values/<field_id>/`` write path with its typed 400 contract,
the ``show_on_card`` opt-in flag, and the ride-``Task.server_version`` sync behavior.
"""

from __future__ import annotations

from datetime import date

import pytest
from django.contrib.auth import get_user_model
from rest_framework import serializers
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProjectMembership, Role
from trueppm_api.apps.projects.custom_field_values import (
    build_custom_fields_map,
    resolve_custom_field_value,
    validate_custom_field_write,
)
from trueppm_api.apps.projects.models import (
    Calendar,
    CustomFieldType,
    Project,
    ProjectCustomField,
    Task,
    TaskCustomFieldValue,
)

User = get_user_model()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def calendar(db):
    return Calendar.objects.create(name="Standard")


@pytest.fixture
def project(calendar):
    return Project.objects.create(name="CF Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def other_project(calendar):
    return Project.objects.create(name="Other Proj", start_date=date(2026, 1, 1), calendar=calendar)


@pytest.fixture
def task(project, member_user):
    # Assigned to member_user so the Team-Member "edit my own task" path is exercised;
    # editing an *unassigned* task requires Scheduler+ (IsProjectMemberWriteOrOwn).
    return Task.objects.create(
        project=project, name="Migrate billing", wbs_path="1", assignee=member_user
    )


@pytest.fixture
def scheduler_user(db):
    return User.objects.create_user(
        username="sched", password="pw", first_name="Sam", last_name="Scheduler"
    )


@pytest.fixture
def member_user(db):
    return User.objects.create_user(
        username="mem", password="pw", first_name="Aisha", last_name="Bello"
    )


@pytest.fixture
def viewer_user(db):
    return User.objects.create_user(username="view", password="pw")


@pytest.fixture
def scheduler_client(scheduler_user, project):
    ProjectMembership.objects.create(project=project, user=scheduler_user, role=Role.SCHEDULER)
    client = APIClient()
    client.force_authenticate(user=scheduler_user)
    return client


@pytest.fixture
def member_client(member_user, project):
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)
    client = APIClient()
    client.force_authenticate(user=member_user)
    return client


@pytest.fixture
def viewer_client(viewer_user, project):
    ProjectMembership.objects.create(project=project, user=viewer_user, role=Role.VIEWER)
    client = APIClient()
    client.force_authenticate(user=viewer_user)
    return client


def _field(project, name, field_type, *, options=None, order=0, show_on_card=False):
    return ProjectCustomField.objects.create(
        project=project,
        name=name,
        field_type=field_type,
        options=options or [],
        order=order,
        show_on_card=show_on_card,
        server_version=1,
    )


def _value_url(project, task, field):
    return f"/api/v1/projects/{project.pk}/tasks/{task.pk}/field-values/{field.pk}/"


# ---------------------------------------------------------------------------
# Pure resolver / validator unit coverage
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_resolver_maps_each_type(project, task, member_user):
    """Each field type resolves to its documented flat-map shape; unset → None."""
    text = _field(project, "Client", CustomFieldType.TEXT)
    num = _field(project, "Cost", CustomFieldType.NUMBER)
    dt = _field(project, "Go-live", CustomFieldType.DATE)
    boolean = _field(project, "Signed", CustomFieldType.BOOLEAN)
    single = _field(
        project, "Env", CustomFieldType.SINGLE_SELECT, options=[{"value": "prod", "label": "Prod"}]
    )
    multi = _field(
        project,
        "Area",
        CustomFieldType.MULTI_SELECT,
        options=[{"value": "be", "label": "BE"}, {"value": "fe", "label": "FE"}],
    )
    person = _field(project, "Reviewer", CustomFieldType.USER)

    v_text = TaskCustomFieldValue.objects.create(task=task, field=text, value_text="Northwind")
    v_num = TaskCustomFieldValue.objects.create(task=task, field=num, value_number="1240")
    v_dt = TaskCustomFieldValue.objects.create(task=task, field=dt, value_date=date(2026, 8, 12))
    v_bool_f = TaskCustomFieldValue.objects.create(task=task, field=boolean, value_bool=False)
    v_single = TaskCustomFieldValue.objects.create(task=task, field=single, value_option="prod")
    v_multi = TaskCustomFieldValue.objects.create(task=task, field=multi, value_multi=["be", "fe"])
    v_person = TaskCustomFieldValue.objects.create(task=task, field=person, value_user=member_user)

    assert resolve_custom_field_value(v_text, text) == "Northwind"
    assert resolve_custom_field_value(v_num, num) == 1240.0
    assert resolve_custom_field_value(v_dt, dt) == "2026-08-12"
    assert resolve_custom_field_value(v_bool_f, boolean) is False  # set-false is a real value
    assert resolve_custom_field_value(v_single, single) == "prod"
    assert resolve_custom_field_value(v_multi, multi) == ["be", "fe"]
    assert resolve_custom_field_value(v_person, person) == {
        "id": str(member_user.pk),
        "name": "Aisha Bello",
        "initials": "AB",
    }

    # Unset rows resolve to None (omitted from the map).
    empty_text = TaskCustomFieldValue.objects.create(
        task=task, field=_field(project, "Note", CustomFieldType.TEXT)
    )
    assert resolve_custom_field_value(empty_text, empty_text.field) is None


@pytest.mark.django_db
def test_build_map_omits_unset(project, task):
    text = _field(project, "Client", CustomFieldType.TEXT)
    empty = _field(project, "Note", CustomFieldType.TEXT)
    TaskCustomFieldValue.objects.create(task=task, field=text, value_text="Northwind")
    TaskCustomFieldValue.objects.create(task=task, field=empty, value_text="")

    task.refresh_from_db()
    result = build_custom_fields_map(task)
    assert result == {str(text.pk): "Northwind"}  # empty field absent, not null


@pytest.mark.django_db
def test_validate_rejects_unknown_select_option(project):
    field = _field(
        project, "Env", CustomFieldType.SINGLE_SELECT, options=[{"value": "prod", "label": "Prod"}]
    )
    with pytest.raises(Exception) as exc:
        validate_custom_field_write(field, "staging")
    assert "valid option" in str(exc.value)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "field_type,options,bad_value,needle",
    [
        # TEXT — non-string, and the 2000-char length cap.
        (CustomFieldType.TEXT, None, 123, "must be a string"),
        (CustomFieldType.TEXT, None, "x" * 2001, "2000 characters"),
        # NUMBER — the type guard (bool is an int subclass; lists are not numbers) fires
        # before the Decimal parse, so it is a distinct branch from the parse-failure path.
        (CustomFieldType.NUMBER, None, True, "must be a number"),
        (CustomFieldType.NUMBER, None, [1], "must be a number"),
        # DATE — a non-string never reaches date.fromisoformat.
        (CustomFieldType.DATE, None, 20260812, "date string"),
        # SINGLE_SELECT — a non-string never reaches the option-membership check.
        (CustomFieldType.SINGLE_SELECT, [{"value": "prod", "label": "P"}], 123, "option value"),
        # MULTI_SELECT — non-list, list of non-strings, and the 50-option cap (which is
        # checked before option membership, so raw ints past the length limit still trip it).
        (CustomFieldType.MULTI_SELECT, [{"value": "be", "label": "B"}], "be", "list of option"),
        (CustomFieldType.MULTI_SELECT, [{"value": "be", "label": "B"}], [1, 2], "list of option"),
        (
            CustomFieldType.MULTI_SELECT,
            [{"value": "be", "label": "B"}],
            [str(i) for i in range(51)],
            "at most 50",
        ),
        # USER — a non-string never reaches the DB lookup.
        (CustomFieldType.USER, None, 123, "user id string"),
    ],
)
def test_validate_type_guard_branches(project, field_type, options, bad_value, needle):
    """Each writer's leading type/shape guard raises the documented 400 message.

    These are the guard branches that fire *before* value parsing / DB lookup, so
    they are not reachable through the endpoint's parse-failure and membership tests.
    """
    field = _field(project, "F", field_type, options=options)
    with pytest.raises(serializers.ValidationError) as exc:
        validate_custom_field_write(field, bad_value)
    assert needle in str(exc.value)


@pytest.mark.django_db
def test_validate_user_unknown_id_is_not_an_oracle(project):
    """A non-existent (or malformed) user id resolves to the same generic 400 as a
    live-but-non-member user, so the endpoint is not a user-existence oracle."""
    field = _field(project, "Reviewer", CustomFieldType.USER)
    for bad in ["00000000-0000-0000-0000-000000000000", "not-a-uuid"]:
        with pytest.raises(serializers.ValidationError) as exc:
            validate_custom_field_write(field, bad)
        assert "not a valid member" in str(exc.value)


@pytest.mark.django_db
def test_validate_unsupported_field_type_rejected(project):
    """An unknown field_type has no writer and is rejected rather than silently no-op."""
    field = _field(project, "F", CustomFieldType.TEXT)
    field.field_type = "geospatial"  # not in _VALUE_WRITERS
    with pytest.raises(serializers.ValidationError) as exc:
        validate_custom_field_write(field, "x")
    assert "unsupported field type" in str(exc.value)


@pytest.mark.django_db
def test_validate_happy_paths_return_column_kwargs(project, member_user):
    """Each writer's success branch sets exactly its own typed column and returns kwargs."""
    ProjectMembership.objects.create(project=project, user=member_user, role=Role.MEMBER)

    text = _field(project, "Client", CustomFieldType.TEXT)
    assert validate_custom_field_write(text, "Northwind")["value_text"] == "Northwind"

    dt = _field(project, "Go-live", CustomFieldType.DATE)
    assert validate_custom_field_write(dt, "2026-08-12")["value_date"] == date(2026, 8, 12)

    boolean = _field(project, "Signed", CustomFieldType.BOOLEAN)
    assert validate_custom_field_write(boolean, True)["value_bool"] is True

    multi = _field(
        project,
        "Area",
        CustomFieldType.MULTI_SELECT,
        options=[{"value": "be", "label": "BE"}, {"value": "fe", "label": "FE"}],
    )
    # Duplicates are collapsed while author order is preserved.
    assert validate_custom_field_write(multi, ["be", "fe", "be"])["value_multi"] == ["be", "fe"]

    person = _field(project, "Reviewer", CustomFieldType.USER)
    assert validate_custom_field_write(person, str(member_user.pk))["value_user"] == member_user


# ---------------------------------------------------------------------------
# Read — custom_fields map on the Task payload
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_task_payload_carries_custom_fields_map(scheduler_client, project, task, member_user):
    ProjectMembership.objects.get_or_create(
        project=project, user=member_user, defaults={"role": Role.MEMBER}
    )
    env = _field(
        project,
        "Env",
        CustomFieldType.SINGLE_SELECT,
        options=[{"value": "prod", "label": "Prod"}],
        show_on_card=True,
    )
    reviewer = _field(project, "Reviewer", CustomFieldType.USER)
    unset = _field(project, "Cost", CustomFieldType.NUMBER)
    TaskCustomFieldValue.objects.create(task=task, field=env, value_option="prod")
    TaskCustomFieldValue.objects.create(task=task, field=reviewer, value_user=member_user)

    resp = scheduler_client.get(f"/api/v1/tasks/{task.pk}/")
    assert resp.status_code == 200
    cf = resp.data["custom_fields"]
    assert cf[str(env.pk)] == "prod"
    assert cf[str(reviewer.pk)]["initials"] == "AB"
    assert str(unset.pk) not in cf  # unset omitted


# ---------------------------------------------------------------------------
# Write — typed upsert, idempotency, version bump
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_put_sets_value_and_bumps_task_version(member_client, project, task):
    field = _field(project, "Client", CustomFieldType.TEXT)
    v0 = task.server_version

    resp = member_client.put(
        _value_url(project, task, field), {"value": "Northwind"}, format="json"
    )
    assert resp.status_code == 200
    assert resp.data["value"] == "Northwind"
    task.refresh_from_db()
    assert task.server_version > v0

    # Idempotent re-write with the same value does NOT churn the version.
    v1 = task.server_version
    resp = member_client.put(
        _value_url(project, task, field), {"value": "Northwind"}, format="json"
    )
    assert resp.status_code == 200
    task.refresh_from_db()
    assert task.server_version == v1


@pytest.mark.django_db
def test_put_overwrites_previous_value(member_client, project, task):
    field = _field(
        project,
        "Env",
        CustomFieldType.SINGLE_SELECT,
        options=[{"value": "prod", "label": "Prod"}, {"value": "dev", "label": "Dev"}],
    )
    member_client.put(_value_url(project, task, field), {"value": "prod"}, format="json")
    member_client.put(_value_url(project, task, field), {"value": "dev"}, format="json")
    row = TaskCustomFieldValue.objects.get(task=task, field=field)
    assert row.value_option == "dev"
    assert TaskCustomFieldValue.objects.filter(task=task, field=field).count() == 1


@pytest.mark.django_db
def test_delete_clears_value_and_bumps_version(member_client, project, task):
    field = _field(project, "Client", CustomFieldType.TEXT)
    member_client.put(_value_url(project, task, field), {"value": "Northwind"}, format="json")
    task.refresh_from_db()
    v0 = task.server_version

    resp = member_client.delete(_value_url(project, task, field))
    assert resp.status_code == 204
    assert not TaskCustomFieldValue.objects.filter(task=task, field=field).exists()
    task.refresh_from_db()
    assert task.server_version > v0

    # Idempotent re-delete is a no-op (still 204, no further bump).
    v1 = task.server_version
    assert member_client.delete(_value_url(project, task, field)).status_code == 204
    task.refresh_from_db()
    assert task.server_version == v1


@pytest.mark.django_db
def test_put_person_value_requires_project_member(member_client, project, task):
    field = _field(project, "Reviewer", CustomFieldType.USER)
    stranger = User.objects.create_user(username="stranger", password="pw")

    resp = member_client.put(
        _value_url(project, task, field), {"value": str(stranger.pk)}, format="json"
    )
    assert resp.status_code == 400
    assert "not a valid member" in str(resp.data["value"])


@pytest.mark.django_db
def test_put_number_value_stores_and_quantizes(member_client, project, task):
    """A valid number persists and round-trips as a JSON number (not a string)."""
    field = _field(project, "Cost", CustomFieldType.NUMBER)
    resp = member_client.put(_value_url(project, task, field), {"value": 1240.5}, format="json")
    assert resp.status_code == 200
    assert resp.data["value"] == 1240.5
    row = TaskCustomFieldValue.objects.get(task=task, field=field)
    assert float(row.value_number) == 1240.5


@pytest.mark.django_db
@pytest.mark.parametrize(
    "field_type,options,bad_value,needle",
    [
        (CustomFieldType.NUMBER, None, "not-a-number", "number"),
        # A raw APIView bypasses DRF's DecimalField, so NaN/Infinity/overflow must be
        # rejected here or they reach the numeric(20,6) column (500) or JSON as NaN (#2123).
        (CustomFieldType.NUMBER, None, "NaN", "finite"),
        (CustomFieldType.NUMBER, None, "Infinity", "finite"),
        (CustomFieldType.NUMBER, None, "1e30", "out of range"),
        (CustomFieldType.DATE, None, "13/40/2026", "ISO-8601"),
        (CustomFieldType.BOOLEAN, None, "yes", "boolean"),
        (
            CustomFieldType.SINGLE_SELECT,
            [{"value": "prod", "label": "P"}],
            "staging",
            "valid option",
        ),
        (CustomFieldType.MULTI_SELECT, [{"value": "be", "label": "B"}], ["nope"], "valid option"),
    ],
)
def test_put_typed_write_400_contract(
    member_client, project, task, field_type, options, bad_value, needle
):
    field = _field(project, "F", field_type, options=options)
    resp = member_client.put(_value_url(project, task, field), {"value": bad_value}, format="json")
    assert resp.status_code == 400
    assert needle in str(resp.data["value"])


# ---------------------------------------------------------------------------
# RBAC + IDOR
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_viewer_cannot_write_value(viewer_client, project, task):
    field = _field(project, "Client", CustomFieldType.TEXT)
    resp = viewer_client.put(_value_url(project, task, field), {"value": "x"}, format="json")
    assert resp.status_code == 403


@pytest.mark.django_db
def test_anonymous_cannot_write_value(project, task):
    field = _field(project, "Client", CustomFieldType.TEXT)
    resp = APIClient().put(_value_url(project, task, field), {"value": "x"}, format="json")
    assert resp.status_code in (401, 403)


@pytest.mark.django_db
def test_field_from_another_project_is_404(member_client, project, other_project, task):
    """A field id from another project must not resolve — cross-project IDOR guard."""
    foreign_field = _field(other_project, "Env", CustomFieldType.TEXT)
    resp = member_client.put(
        _value_url(project, task, foreign_field), {"value": "x"}, format="json"
    )
    assert resp.status_code == 404
    assert not TaskCustomFieldValue.objects.filter(field=foreign_field).exists()


# ---------------------------------------------------------------------------
# show_on_card flag
# ---------------------------------------------------------------------------


@pytest.mark.django_db
def test_show_on_card_defaults_false_and_scheduler_can_toggle(scheduler_client, project):
    field = _field(project, "Env", CustomFieldType.TEXT)
    assert field.show_on_card is False

    resp = scheduler_client.patch(
        f"/api/v1/projects/{project.pk}/fields/{field.pk}/",
        {"show_on_card": True},
        format="json",
    )
    assert resp.status_code == 200
    assert resp.data["show_on_card"] is True
    field.refresh_from_db()
    assert field.show_on_card is True


@pytest.mark.django_db
def test_member_cannot_toggle_show_on_card(member_client, project):
    """show_on_card rides the field-definition PATCH — Scheduler+, not Member."""
    field = _field(project, "Env", CustomFieldType.TEXT)
    resp = member_client.patch(
        f"/api/v1/projects/{project.pk}/fields/{field.pk}/",
        {"show_on_card": True},
        format="json",
    )
    assert resp.status_code == 403
