"""Contract-hygiene ratchets on the published schema (#4091, #4093, #4665, #3792, #4090).

Reads the committed `docs/api/openapi.json` (the published artifact; `api:schema-drift`
proves it matches the code).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
from django.urls import resolve
from trueppm_scheduler.derive import ContributionKind, DerivationPass

from trueppm_api.apps.scheduling.serializers import (
    SCHEDULE_CONTRIBUTION_KIND_CHOICES,
    SCHEDULE_DERIVATION_PASS_CHOICES,
)

_SCHEMA = json.loads(
    (Path(__file__).resolve().parents[3] / "docs" / "api" / "openapi.json").read_text()
)
_METHODS = ("get", "post", "put", "patch", "delete")


def _auth_names(path: str, method: str) -> set[str]:
    op = _SCHEMA["paths"][path][method]
    return {name for entry in op.get("security", []) for name in entry}


#: Hash-named components already published, pinned by ENUM_NAME_OVERRIDES so they cannot
#: move. Renaming them to readable names is a breaking change batched into #2844.
_PINNED_HASH_ENUMS = frozenset({"Status9bdEnum", "RoleF2cEnum", "StatusE83Enum"})


def test_no_new_component_is_named_by_a_choices_hash() -> None:
    hashed = [
        n
        for n in _SCHEMA["components"]["schemas"]
        if re.search(r"[0-9A-Fa-f][0-9a-f]{2}Enum$", n) and n not in _PINNED_HASH_ENUMS
    ]
    assert not hashed, (
        f"{hashed} are named by a hash of their choices, so an unrelated choices edit "
        "renames them for every generated client. Pin each in ENUM_NAME_OVERRIDES."
    )


def test_pinned_enum_names_are_still_published() -> None:
    schemas = _SCHEMA["components"]["schemas"]
    for name in ("Status9bdEnum", "RoleF2cEnum", "StatusE83Enum"):
        assert name in schemas, f"{name} was renamed; that is a breaking change for SDKs"


def test_id_and_pk_path_params_declare_uuid_or_a_non_string_type() -> None:
    bare = []
    for path, item in _SCHEMA["paths"].items():
        for method, op in item.items():
            if method not in _METHODS:
                continue
            for p in op.get("parameters", []) + item.get("parameters", []):
                name = p.get("name", "")
                if p.get("in") != "path" or not (name == "id" or name.endswith("_pk")):
                    continue
                schema = p["schema"]
                if schema.get("type") == "string" and "format" not in schema:
                    bare.append(f"{method.upper()} {path} {{{name}}}")
    assert not bare, "untyped UUID path parameters:\n  " + "\n  ".join(bare)


#: Paths that legitimately carry no trailing slash. Every other route does.
_UNSLASHED_ALLOWED = frozenset(
    {"/api/v1/readyz", "/api/v1/projects/{project_pk}/export/msproject.xml"}
)


def test_every_published_path_ends_in_a_slash() -> None:
    offenders = sorted(
        p for p in _SCHEMA["paths"] if not p.endswith("/") and p not in _UNSLASHED_ALLOWED
    )
    assert not offenders, (
        "These paths omit the trailing slash all other endpoints carry (an integrator "
        "who learned the convention gets a bare 404; APPEND_SLASH only adds a slash):\n  "
        + "\n  ".join(offenders)
    )


@pytest.mark.parametrize(
    "slashed",
    [
        "/api/v1/me/timer/start/",
        "/api/v1/me/timer/stop/",
        "/api/v1/me/timesheets/2026-06-15/submit/",
    ],
)
def test_legacy_unslashed_spelling_still_routes_to_the_same_view(slashed: str) -> None:
    """The 0.4 unslashed paths keep working so no existing client breaks (#3792)."""
    assert resolve(slashed).func is resolve(slashed.rstrip("/")).func


@pytest.mark.parametrize(
    ("path", "method"),
    [
        ("/api/v1/projects/{project_pk}/webhooks/", "post"),
        ("/api/v1/projects/{project_pk}/webhooks/{id}/", "put"),
        ("/api/v1/projects/{project_pk}/webhooks/{id}/", "patch"),
        ("/api/v1/programs/{program_pk}/webhooks/", "post"),
        ("/api/v1/programs/{program_pk}/webhooks/{id}/", "patch"),
        ("/api/v1/projects/{project_pk}/share-links/", "post"),
        ("/api/v1/resources/{id}/rate/", "post"),
    ],
)
def test_token_refusing_writes_do_not_advertise_token_schemes(path: str, method: str) -> None:
    if path not in _SCHEMA["paths"]:
        pytest.skip(f"{path} not published under that spelling")
    assert not ({"personalApiTokenAuth", "projectApiTokenAuth"} & _auth_names(path, method))


def test_token_accepting_siblings_keep_the_token_scheme() -> None:
    assert "personalApiTokenAuth" in _auth_names("/api/v1/projects/{project_pk}/webhooks/", "get")
    assert "personalApiTokenAuth" in _auth_names(
        "/api/v1/projects/{project_pk}/webhooks/{id}/", "delete"
    )


def _header_names(op: dict[str, Any]) -> set[str]:
    return {p["name"] for p in op.get("parameters", []) if p.get("in") == "header"}


def test_idempotent_mutations_declare_the_header_and_replay_contract() -> None:
    op = _SCHEMA["paths"]["/api/v1/me/timer/start/"]["post"]
    assert "Idempotency-Key" in _header_names(op)
    assert "Idempotent-Replay" in op["responses"]["201"]["headers"]
    assert op["responses"]["422"] == {"$ref": "#/components/responses/IdempotencyKeyConflict"}
    assert "IdempotencyKeyConflict" in _SCHEMA["components"]["responses"]


def test_exempt_and_safe_operations_do_not_declare_idempotency_key() -> None:
    # One-time-secret mint: idempotency_exempt, must not promise replay.
    exempt = _SCHEMA["paths"]["/api/v1/projects/{project_pk}/webhooks/"]["post"]
    assert "Idempotency-Key" not in _header_names(exempt)
    safe = _SCHEMA["paths"]["/api/v1/me/timer/"]["get"]
    assert "Idempotency-Key" not in _header_names(safe)


def test_deprecated_aliases_are_marked_deprecated() -> None:
    pull = _SCHEMA["components"]["schemas"]["SyncPullResponse"]["properties"]["has_more"]
    assert pull.get("deprecated") is True
    task = _SCHEMA["components"]["schemas"]["Task"]["properties"]["sprint_scope_changes"]
    assert task["items"]["properties"]["subtask_name"]["deprecated"] is True


def test_derivation_vocabulary_is_published_as_enums() -> None:
    """`kind`/`dep_type` are enums and the derivation union is discriminated (#4291)."""
    schemas = _SCHEMA["components"]["schemas"]
    props = schemas["ScheduleDerivationContribution"]["properties"]
    assert props["kind"] == {"$ref": "#/components/schemas/ScheduleDerivationContributionKindEnum"}
    assert set(schemas["ScheduleDerivationContributionKindEnum"]["enum"]) == {
        k.value for k in ContributionKind
    }
    assert {"$ref": "#/components/schemas/DepTypeEnum"} in props["dep_type"]["oneOf"]

    discriminator = schemas["ScheduleDerivationResponse"]["discriminator"]
    assert discriminator["propertyName"] == "pass"
    cpm = "#/components/schemas/ScheduleCpmDerivation"
    assert discriminator["mapping"] == {
        **{p.value: cpm for p in DerivationPass},
        "monte_carlo": "#/components/schemas/ScheduleMonteCarloDerivation",
    }


def test_derivation_choice_literals_match_the_engine_enums() -> None:
    """The API spells the vocabulary out so it imports against scheduler 0.4.0 (#4291)."""
    assert sorted(SCHEDULE_CONTRIBUTION_KIND_CHOICES) == sorted(k.value for k in ContributionKind)
    assert sorted(SCHEDULE_DERIVATION_PASS_CHOICES) == sorted(p.value for p in DerivationPass)
