"""The downloadable known-good CSV template (#743).

An operator with a messy spreadsheet needs a target shape, not a spec to read.
The template is deliberately a *worked example* rather than a bare header row:
the sample rows demonstrate WBS nesting, a lag on a predecessor, a milestone
with zero duration, and a comment row — the four things the alias table alone
does not communicate.

Header spellings here are chosen to be the exact-match aliases in
``mapping.py``, so a file built from this template maps with zero manual
correction. ``test_template_maps_cleanly`` asserts that, which is what keeps the
two files from drifting apart.
"""

from __future__ import annotations

TEMPLATE_FILENAME = "trueppm-import-template.csv"

CSV_TEMPLATE = """\
# TruePPM import template. Lines starting with '#' are ignored.
# Duration is in working days. Dates are YYYY-MM-DD.
# Predecessors reference the ID column: "3" is finish-to-start on task 3,
# "3FS+2d" adds 2 days of lag, and "5SS" starts with task 5.
ID,WBS,Name,Duration,Start,Finish,% Complete,Assignee,Predecessors,Notes
1,1,Discovery,,2026-09-01,,,,,Phase
2,1.1,Stakeholder interviews,5,2026-09-01,,100,A. Rivera,,
3,1.2,Requirements draft,8,,,60,A. Rivera,2,
4,2,Build,,,,,,,Phase
5,2.1,Data model,10,,,0,J. Chen,3,
6,2.2,API endpoints,15,,,0,J. Chen,5SS,Can start with the data model
7,2.3,Web UI,12,,,0,P. Osei,5,
8,3,Launch readiness,,,,,,,Phase
9,3.1,Cutover rehearsal,2,,,0,P. Osei,"6,7",
10,3.2,Go live,0,,,0,,9FS+2d,Milestone
"""
