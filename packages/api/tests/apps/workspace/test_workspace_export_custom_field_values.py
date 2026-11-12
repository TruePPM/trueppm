"""Workspace archive carries TaskCustomFieldValue rows (#3156)."""

from __future__ import annotations

import io
import json
import tarfile
from datetime import date
from decimal import Decimal

import pytest
from django.core.files.storage import default_storage

from trueppm_api.apps.projects.models import (
    Project,
    ProjectCustomField,
    Task,
    TaskCustomFieldValue,
)
from trueppm_api.apps.workspace.export import build_and_store_archive

pytestmark = pytest.mark.django_db


def _members() -> dict[str, bytes]:
    path, _size = build_and_store_archive("cfv-test")
    try:
        with default_storage.open(path, "rb") as fh:
            raw = fh.read()
    finally:
        default_storage.delete(path)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        return {
            m.name: tar.extractfile(m).read()  # type: ignore[union-attr]
            for m in tar.getmembers()
            if m.isfile()
        }


def test_archive_contains_custom_field_values() -> None:
    project = Project.objects.create(name="Apollo", start_date=date(2026, 1, 1))
    task = Task.objects.create(project=project, name="Contract review", duration=1)
    field = ProjectCustomField.objects.create(project=project, name="Ticket", field_type="text")
    TaskCustomFieldValue.objects.create(task=task, field=field, value_text="ABC-123")

    members = _members()
    rows = json.loads(members["projects/task_custom_field_values.json"])
    assert len(rows) == TaskCustomFieldValue.objects.count() == 1
    assert rows[0]["task_id"] == str(task.pk)
    assert rows[0]["field_id"] == str(field.pk)
    assert rows[0]["value_text"] == "ABC-123"


def test_archive_serializes_non_text_value_columns() -> None:
    project = Project.objects.create(name="Apollo", start_date=date(2026, 1, 1))
    task = Task.objects.create(project=project, name="Budget", duration=1)
    field = ProjectCustomField.objects.create(project=project, name="Cost", field_type="number")
    TaskCustomFieldValue.objects.create(task=task, field=field, value_number=Decimal("12.5"))

    rows = json.loads(_members()["projects/task_custom_field_values.json"])
    assert len(rows) == 1
    assert Decimal(str(rows[0]["value_number"])) == Decimal("12.5")
