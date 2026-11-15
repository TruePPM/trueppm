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


@pytest.mark.django_db
def test_every_202_json_body_declares_queued() -> None:
    schema = SchemaGenerator().get_schema(request=None, public=True)
    comps = schema["components"]["schemas"]
    missing: list[str] = []
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
            if not body or "$ref" not in body:
                continue  # empty 202
            name = body["$ref"].rsplit("/", 1)[1]
            if name in _NOT_AN_ACK:
                continue
            if "queued" not in comps[name].get("properties", {}):
                missing.append(f"{method.upper()} {path} -> {name}")
    assert not missing, missing
