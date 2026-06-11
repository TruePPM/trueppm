"""Content assertions for the bundled sample seeds (#621, #622).

Pure — no database. Reads each committed fixture and asserts the resource/RBAC
(#621) and risk-register (#622) story an evaluator should feel is actually
present, and that every sample is a valid v2 document.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from trueppm_api.apps.projects.seed import validate_seed

_SEEDS_DIR = (
    Path(__file__).resolve().parents[4]
    / "src"
    / "trueppm_api"
    / "apps"
    / "projects"
    / "fixtures"
    / "seeds"
)

# (fixture stem, min risks, max risks)
SAMPLES = [
    ("aurora-mobile-app", 3, 5),
    ("bayside-civic-center", 10, 15),
    ("helios-crm-replacement", 5, 5),
    ("atlas-platform-launch", 20, 20),
]

ALL_ROLES = {"OWNER", "ADMIN", "SCHEDULER", "MEMBER", "VIEWER"}


def _load(stem: str) -> dict:
    return json.loads((_SEEDS_DIR / f"{stem}.json").read_text(encoding="utf-8"))


def _risks(doc: dict) -> list[dict]:
    return [r for p in doc["projects"] for r in p.get("risks", [])] + doc.get("risks", [])


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_sample_is_valid_v2(stem: str, _min: int, _max: int) -> None:
    doc = _load(stem)
    assert doc["schema_version"] == "2.0"
    validate_seed(doc)  # does not raise


@pytest.mark.parametrize("stem,lo,hi", SAMPLES)
def test_risk_register_meets_target(stem: str, lo: int, hi: int) -> None:
    risks = _risks(_load(stem))
    assert lo <= len(risks) <= hi, f"{stem}: {len(risks)} risks, want {lo}-{hi}"
    # Status mix is exercised, not a single state repeated.
    statuses = {r["status"] for r in risks}
    assert len(statuses) >= 2, f"{stem}: risk statuses are all {statuses}"


def test_atlas_has_schedule_driving_risks_for_monte_carlo() -> None:
    # Several Atlas risks must be high probability*impact so toggling them in the
    # Monte Carlo modal visibly shifts P80 (#622).
    risks = _risks(_load("atlas-platform-launch"))
    driving = [r for r in risks if r["probability"] * r["impact"] >= 12]
    assert len(driving) >= 5


def test_all_five_roles_demonstrated_across_programs() -> None:
    seen: set[str] = set()
    for stem, *_ in SAMPLES:
        seen |= {a["role"] for a in _load(stem).get("accounts", []) if a.get("role")}
    assert seen >= ALL_ROLES


@pytest.mark.parametrize("stem,_min,_max", SAMPLES)
def test_capacity_profiles_present(stem: str, _min: int, _max: int) -> None:
    # Not everyone is full-time: each sample shows < 1.0 capacity somewhere.
    units = {float(r.get("max_units", 1.0)) for r in _load(stem).get("resources", [])}
    assert any(u < 1.0 for u in units), f"{stem}: no part-time/advisor capacity"


@pytest.mark.parametrize(
    "stem", ["aurora-mobile-app", "bayside-civic-center", "helios-crm-replacement"]
)
def test_non_default_calendar_attached_to_a_resource(stem: str) -> None:
    doc = _load(stem)
    non_default = {c["slug"] for c in doc.get("calendars", []) if c.get("working_days", 31) != 31}
    assert non_default, f"{stem}: no non-default working calendar"
    on_resource = {r.get("calendar") for r in doc.get("resources", [])}
    assert non_default & on_resource, f"{stem}: non-default calendar not attached to a resource"
