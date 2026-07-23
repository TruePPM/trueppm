"""Beta-1 duration-unit conversion seam (#2290).

TruePPM's canonical scheduling unit through beta 1 (0.4) is the **whole working
day**: task durations, lags, and estimates are integers of working days, and the
CPM engine schedules in whole-day steps — ``trueppm_scheduler`` treats
``Calendar.hours_per_day`` as reserved-but-inert (#826), so a calendar's
hours-per-day never enters the schedule math.

External formats — MS Project (MSPDI) and Jira — express those same quantities in
hours / minutes / seconds, so *importing and exporting* must convert across a
nominal working-day length. That length is **only** an import/export boundary
concern; it is not a promise about TruePPM's internal representation, and it is
deliberately distinct from a user-facing ``Calendar.hours_per_day`` (a separate,
per-calendar knob). The effort/duration split and the canonical-unit move to
minutes planned for 0.5 (#1835, #2289) re-home these constants — keeping them in
one module means that change touches a single place instead of hunting the
assumption down across every importer and exporter.

Units may change before GA; do not treat the working-day length as a stable
contract or leak it into a public field, mapping, or copy that a 0.5 unit swap
would have to chase.
"""

from __future__ import annotations

# Nominal working-day length used *solely* to convert durations across the
# MS Project / Jira import-export boundary. This is NOT the engine's scheduling
# unit (whole days) and NOT a user-facing ``Calendar.hours_per_day``.
HOURS_PER_WORKING_DAY = 8
MINUTES_PER_WORKING_DAY = HOURS_PER_WORKING_DAY * 60  # 480
SECONDS_PER_WORKING_DAY = MINUTES_PER_WORKING_DAY * 60  # 28_800

# MS Project stores ``PredecessorLink/LinkLag`` in tenths of a minute, so one
# working day of lag is ``MINUTES_PER_WORKING_DAY * 10``.
MSPDI_LAG_TENTHS_PER_WORKING_DAY = MINUTES_PER_WORKING_DAY * 10  # 4800
