"""Guard the beta-1 duration-unit conversion seam (#2290).

The canonical scheduling unit through beta 1 is the whole working day; only the
MS Project and Jira import/export adapters cross into hours/minutes/seconds, and
they must do so through the single ``scheduling.units`` seam so a 0.5
canonical-unit change (#1835, #2289) re-homes in one place instead of being
hunted down across every adapter. These are pure-function tests — no DB.
"""

from __future__ import annotations

from trueppm_api.apps.jiraimport import parser as jira_parser
from trueppm_api.apps.msproject import exporter, parser
from trueppm_api.apps.scheduling.units import (
    HOURS_PER_WORKING_DAY,
    MINUTES_PER_WORKING_DAY,
    MSPDI_LAG_TENTHS_PER_WORKING_DAY,
    SECONDS_PER_WORKING_DAY,
)


def test_seam_constants_are_internally_consistent() -> None:
    """The derived constants stay locked to the nominal working-day length.

    A 0.5 unit swap changes ``HOURS_PER_WORKING_DAY`` (or replaces the seam
    wholesale); until then the minute/second/tenths derivations must follow from
    it, so a partial edit that touches one constant but not the others is caught.
    """
    assert MINUTES_PER_WORKING_DAY == HOURS_PER_WORKING_DAY * 60
    assert SECONDS_PER_WORKING_DAY == MINUTES_PER_WORKING_DAY * 60
    assert MSPDI_LAG_TENTHS_PER_WORKING_DAY == MINUTES_PER_WORKING_DAY * 10
    # Beta-1 nominal working day is 8h; pinned so a silent change is visible.
    assert HOURS_PER_WORKING_DAY == 8


def test_msproject_duration_routes_through_the_seam() -> None:
    """Export/parse duration conversion uses the seam, not a bare ``* 8``/``// 8``."""
    assert exporter._days_to_duration(3) == f"PT{3 * HOURS_PER_WORKING_DAY}H0M0S"
    # One nominal working day of hours parses back to exactly one day.
    assert parser._parse_duration_to_days(f"PT{HOURS_PER_WORKING_DAY}H0M0S") == 1
    # Round-trip: whole-day durations survive export → parse unchanged.
    for days in (0, 1, 5, 20):
        assert parser._parse_duration_to_days(exporter._days_to_duration(days)) == days


def test_msproject_lag_routes_through_the_seam() -> None:
    """LinkLag (tenths of a minute) conversion uses the seam in both directions."""
    assert parser._parse_lag_to_days(str(MSPDI_LAG_TENTHS_PER_WORKING_DAY)) == 1
    for lag in (0, 1, 3, 10):
        tenths = lag * MSPDI_LAG_TENTHS_PER_WORKING_DAY
        assert parser._parse_lag_to_days(str(tenths)) == lag


def test_jira_seconds_routes_through_the_seam() -> None:
    """Jira estimate→days conversion uses the seam, not a bare ``8 * 60 * 60``."""
    assert jira_parser._SECONDS_PER_DAY == SECONDS_PER_WORKING_DAY
    assert jira_parser._seconds_to_days(str(SECONDS_PER_WORKING_DAY)) == 1
    assert jira_parser._seconds_to_days(str(SECONDS_PER_WORKING_DAY * 5)) == 5
    # Sub-day estimates round up to a schedulable minimum of one day.
    assert jira_parser._seconds_to_days(str(SECONDS_PER_WORKING_DAY // 4)) == 1
