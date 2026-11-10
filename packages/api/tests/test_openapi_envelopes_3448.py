"""Five operations that declared "No response body" now publish their envelope (#3448).

Each assertion is key-set equality (``assert_declared_properties_match_body``) plus
JSON Schema validation: validation alone ignores undeclared keys, which is exactly
how ``can_edit`` would have gone missing from a serializer-shaped declaration.
"""

from __future__ import annotations

import pytest
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from trueppm_api.apps.access.models import ProgramMembership, ProjectMembership, Role
from trueppm_api.apps.notifications import email_backend
from trueppm_api.apps.projects.models import Program, Project
from trueppm_api.apps.workspace import services
from trueppm_api.apps.workspace.models import Workspace, WorkspaceRole

from .test_openapi_response_conformance import (
    assert_declared_properties_match_body,
    assert_response_matches_schema,
    load_committed_schema,
)

User = get_user_model()

EMAIL = "/api/v1/workspace/email-settings/"
HEALTH = "/api/v1/workspace/email-settings/health/"
CATALOG = "/api/v1/programs/{program_pk}/label-catalog/"
ACCEPT = "/api/v1/workspace/invites/accept/"


@pytest.fixture(scope="module")
def schema() -> dict:
    return load_committed_schema()


@pytest.fixture
def operator_client(db: object) -> APIClient:
    user = User.objects.create_superuser(username="root3448", email="r@x.test", password="pw")
    client = APIClient()
    client.force_authenticate(user=user)
    return client


@pytest.mark.parametrize("method", ["get", "put", "patch"])
def test_email_settings_envelope(
    schema: dict, operator_client: APIClient, monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    monkeypatch.setattr(email_backend, "probe_transport", lambda **kwargs: None)
    resp = getattr(operator_client, method)(EMAIL, {} if method != "get" else None, format="json")
    assert resp.status_code == 200, resp.content
    assert_declared_properties_match_body(schema, resp, EMAIL, method)
    assert_response_matches_schema(schema, resp, EMAIL, method)
    # The post-serialize keys are the whole point of the explicit envelope.
    assert {"can_edit", "configured_via", "frontend_base_url"} <= set(resp.json())
    assert "password" not in resp.json()


def test_email_health_envelope(schema: dict, operator_client: APIClient) -> None:
    resp = operator_client.get(HEALTH)
    assert resp.status_code == 200, resp.content
    assert_declared_properties_match_body(schema, resp, HEALTH, "get")
    assert_response_matches_schema(schema, resp, HEALTH, "get")


def test_label_catalog_envelope(schema: dict, db: object) -> None:
    lead = User.objects.create_user(username="lead3448", password="pw")
    program = Program.objects.create(name="Apollo", code="APO3448")
    ProgramMembership.objects.create(program=program, user=lead, role=Role.OWNER)
    project = Project.objects.create(
        name="Ares", code="ARS", start_date="2026-01-05", program=program
    )
    ProjectMembership.objects.create(project=project, user=lead, role=Role.OWNER)
    client = APIClient()
    client.force_authenticate(user=lead)
    resp = client.get(CATALOG.format(program_pk=program.pk))
    assert resp.status_code == 200, resp.content
    path = "/api/v1/programs/{program_pk}/label-catalog/"
    assert_declared_properties_match_body(schema, resp, path, "get")
    assert_response_matches_schema(schema, resp, path, "get")


def test_invite_accept_envelope(schema: dict, db: object) -> None:
    admin = User.objects.create_user(username="adm3448", password="pw", is_superuser=True)
    invite = services.create_invite(
        workspace=Workspace.load(), email="j3448@x.io", role=WorkspaceRole.MEMBER, invited_by=admin
    )
    resp = APIClient().post(
        ACCEPT,
        {"token": invite.email_token, "username": "joiner3448", "password": "s3cretpw123"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert_declared_properties_match_body(schema, resp, ACCEPT, "post")
    assert_response_matches_schema(schema, resp, ACCEPT, "post")
