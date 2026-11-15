"""Every ``202 Accepted`` JSON body carries ``queued`` (#4661).

An integrator writing one submit-then-poll helper must find the same
``{queued: true}`` marker on every async endpoint. The allowlist is the set of
202 bodies that are a full resource rather than a queue acknowledgement.
"""

from __future__ import annotations

import pytest
from drf_spectacular.generators import SchemaGenerator

# Bodies that are a job/resource representation or a delivery receipt, not a
# queue acknowledgement. Do NOT add an entry to dodge the rule for a new endpoint:
# new async endpoints return `queued: true` (see api/stability.md).
_NOT_AN_ACK = {
    "ProgramExportJob": "job resource: carries its own status",
    "ProjectExportJob": "job resource: carries its own status",
    "WorkspaceExportJob": "job resource: carries its own status",
    "CeilingProposal": "the created proposal resource",
    "WebhookTestPingResponse": "delivery receipt; tracked for 1.0 shape batch (#2844)",
}

# Operations that return 202 with no declared body. Pinned so a NEW bare 202 fails
# instead of passing vacuously: give it a `queued: true` body schema, or (only if it
# genuinely has none) add it here with a reason.
_EMPTY_202_OPERATIONS = {
    ("POST", "/api/v1/project-templates/{id}/apply/"),
    ("POST", "/api/v1/projects/{project_pk}/task-runs/{id}/cancel/"),
    ("POST", "/api/v1/sprints/{id}/close/"),
    ("POST", "/api/v1/workspace/invites/{invite_id}/resend/"),
    ("POST", "/api/v1/workspace/invites/resend-all/"),
}


@pytest.mark.django_db
def test_every_202_json_body_declares_queued() -> None:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    comps = schema["components"]["schemas"]
    missing: list[str] = []
    empty: set[tuple[str, str]] = set()
    for path, item in schema["paths"].items():
        for method, op in item.items():
            if not isinstance(op, dict):
                continue
            body = (
                op.get("responses", {})
                .get("202", {})
                .get("content", {})
                .get("application/json", {})
                .get("schema")
            )
            if not body:
                if "202" in op.get("responses", {}):
                    empty.add((method.upper(), path))
                continue
            # An inline schema would skip the `queued` check below vacuously.
            assert "$ref" in body, f"{method.upper()} {path}: 202 body must be a $ref"
            name = body["$ref"].rsplit("/", 1)[1]
            if name in _NOT_AN_ACK:
                continue
            if "queued" not in comps[name].get("properties", {}):
                missing.append(f"{method.upper()} {path} -> {name}")
    assert not missing, missing
    assert empty == _EMPTY_202_OPERATIONS, (
        f"unexpected bare 202s: {sorted(empty - _EMPTY_202_OPERATIONS)}; "
        f"stale allowlist entries: {sorted(_EMPTY_202_OPERATIONS - empty)}"
    )
