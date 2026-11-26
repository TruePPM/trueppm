"""P50/P80 cost from the Monte Carlo, served on the cost summary (#4809).

Expected amounts are hand arithmetic in the comment beside each, not a call into the
engine: the API only loads rates and assignments, and the point is to pin what reaches
the engine and what comes back.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from tests.apps.projects import cost_helpers as h
from trueppm_api.apps.access.models import Role
from trueppm_api.apps.projects.models import Task
from trueppm_api.apps.resources.models import TaskResource
from trueppm_api.apps.scheduling.models import MonteCarloRun


@pytest.fixture
def scenario(db: object) -> dict[str, Any]:
    """Two people, two rates, known durations, no uncertainty.

    Alice @ 100.00/h on A (5 days, full time) and logs 60 min = 100.00 actual.
    Bob   @  50.00/h on B (3 days, half time).
    Each run: 100 + 5 x 8 x 1.0 x 100 + 3 x 8 x 0.5 x 50 = 100 + 4,000 + 600 = 4,700.00.
    """
    pm, alice, bob = h.user("pm"), h.user("alice"), h.user("bob")
    p = h.project("Costed", budget="10000.00")
    h.member(p, pm, Role.ADMIN)
    a = Task.objects.create(project=p, name="A", duration=5)
    b = Task.objects.create(project=p, name="B", duration=3)
    ra = h.resource("Alice", alice, "100.00")
    rb = h.resource("Bob", bob, "50.00")
    h.assign(a, ra)
    TaskResource.objects.create(task=b, resource=rb, units=Decimal("0.50"))
    h.log(a, alice, 60)
    return {"p": p, "pm": pm, "a": a, "b": b}


def _simulate(client: Any, p: Any) -> Any:
    r = client.post(f"/api/v1/projects/{p.pk}/monte-carlo/", {"n_simulations": 50}, format="json")
    assert r.status_code == 200, r.data
    return r


def _cost(client: Any, p: Any) -> Any:
    r = client.get(f"/api/v1/projects/{p.pk}/cost/")
    assert r.status_code == 200, r.data
    return r.data


def test_hand_computed_p50_p80_cost_on_the_summary(scenario: dict[str, Any]) -> None:
    c = h.client(scenario["pm"])
    mc = _simulate(c, scenario["p"])
    # Cost is an Admin+ fact: never on the Member-readable forecast or its cache.
    assert "cost" not in mc.data
    data = _cost(c, scenario["p"])
    run = MonteCarloRun.objects.get(project=scenario["p"])
    for key in ("p50_cost", "p80_cost"):
        assert data[key]["available"] is True
        assert data[key]["value"] == "4700.00"
        assert data[key]["n_simulations"] == 50
        assert data[key]["as_of"] is not None
        assert key in data["definitions"]
    assert run.cost_forecast == {
        "computable": True,
        "missing_rate_count": 0,
        "actual_to_date": "100.00",
        "p50": "4700.00",
        "p80": "4700.00",
        "p95": "4700.00",
    }


def test_unrated_assignee_reports_missing_rates_and_dates_are_unchanged(
    scenario: dict[str, Any],
) -> None:
    c = h.client(scenario["pm"])
    before = _simulate(c, scenario["p"]).data
    cy = h.resource("Cy", h.user("cy"), None)
    h.assign(scenario["b"], cy)
    after = _simulate(c, scenario["p"]).data
    assert (after["p50"], after["p80"], after["p95"]) == (
        before["p50"],
        before["p80"],
        before["p95"],
    )
    data = _cost(c, scenario["p"])
    assert data["cost_computable"] is False
    assert data["missing_rate_count"] == 1
    assert data["p80_cost"] == {
        "available": False,
        "reason": "missing_rates",
        "as_of": data["p80_cost"]["as_of"],
        "n_simulations": 50,
    }
    latest = MonteCarloRun.objects.filter(project=scenario["p"]).order_by("-taken_at").first()
    assert latest is not None and latest.cost_forecast is not None
    assert latest.cost_forecast["p80"] is None
    assert latest.cost_forecast["missing_rate_count"] == 1


def test_unpriced_actual_hours_make_the_percentiles_unavailable(
    scenario: dict[str, Any],
) -> None:
    """Every assignee is rated, but someone logged hours with no rate: AC is partial."""
    dan = h.user("dan")
    h.resource("Dan", dan, None)
    h.log(scenario["a"], dan, 30)
    c = h.client(scenario["pm"])
    _simulate(c, scenario["p"])
    assert _cost(c, scenario["p"])["p50_cost"]["reason"] == "missing_rates"


def test_no_recorded_run_reports_no_simulation(scenario: dict[str, Any]) -> None:
    data = _cost(h.client(scenario["pm"]), scenario["p"])
    assert data["p50_cost"] == {
        "available": False,
        "reason": "no_simulation",
        "as_of": None,
        "n_simulations": None,
    }


def test_member_run_records_no_cost_and_leaks_none(scenario: dict[str, Any]) -> None:
    m = h.user("member")
    h.member(scenario["p"], m, Role.MEMBER)
    mc = _simulate(h.client(m), scenario["p"])
    assert "cost" not in mc.data
    assert not MonteCarloRun.objects.filter(project=scenario["p"]).exists()
    latest = h.client(m).get(f"/api/v1/projects/{scenario['p'].pk}/monte-carlo/latest/")
    assert "cost" not in latest.data
