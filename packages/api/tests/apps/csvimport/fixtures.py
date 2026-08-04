"""Inline spreadsheet fixtures for the CSV / Excel import tests (#743).

The CSV fixtures are written the way real exported sheets are: mixed header
spellings, a comment row, a blank row, US-format dates, "5d" durations, and a
predecessor column that references the ID column rather than row order.
"""

from __future__ import annotations

import io
import zipfile

# The reference fixture from the #111 alias table: every mappable field present
# under a *different* spelling than the canonical one, so a clean auto-detect
# proves the alias table works rather than proving exact-match works.
#
#   Task        -> name              Days      -> duration
#   Begin       -> planned_start     Due       -> planned_finish
#   Progress    -> percent_complete  Owner     -> resource
#   Depends On  -> predecessors      Phase     -> wbs
REFERENCE_CSV = b"""\
# Exported from Acme Planning.xlsx
Task ID,Phase,Task,Days,Begin,Due,Progress,Owner,Depends On,Description
1,1,Discovery,,09/01/2026,,,,,Phase rollup
2,1.1,Stakeholder interviews,5,09/01/2026,,100%,A. Rivera,,
3,1.2,Requirements draft,8,,,60%,A. Rivera,2,

4,2,Build,,,,,,,Phase rollup
5,2.1,Data model,10,,,0,J. Chen,3,
6,2.2,API endpoints,15,,,0,J. Chen,5SS,Starts with the data model
7,2.3,Web UI,12,,,0,P. Osei,5FS+2d,
"""

# Hierarchy carried by *indentation* in the name column rather than a WBS code.
# Two spaces per level is the common Excel convention.
INDENTED_CSV = b"""\
Name,Duration
Phase One,1
  Design,3
  Build,5
    Backend,2
    Frontend,2
Phase Two,1
  Ship,1
"""

# Every row-level error class in one file, each of which must be reported by row
# number while the row itself still imports:
#   row 2 -- unreadable date
#   row 3 -- unreadable duration
#   row 4 -- predecessor that matches no row
#   row 5 -- self-dependency
#   row 6 -- no name at all (this row is dropped, not imported)
MESSY_CSV = b"""\
ID,Name,Duration,Start,Predecessors
1,Good row,3,2026-03-02,
2,Bad date,3,not-a-date,
3,Bad duration,three days,2026-03-02,
4,Ghost predecessor,2,2026-03-02,99
5,Self referential,2,2026-03-02,5
6,,2,2026-03-02,
"""

# An indent depth deep enough that, unclamped, it would blow past Postgres's
# ltree label-count ceiling once routed through _wbs_paths_from_levels (#2761).
# The parser must clamp it to MAX_OUTLINE_DEPTH rather than let it reach
# persistence unbounded.
EXTREME_INDENT_CSV = b"Name,Duration\n" + (b"\t" * 70000) + b"Deep,1\nSibling,1\n"

# Same failure mode via the bare-digit WBS/"Level" column instead of
# name-column indentation (#2761).
EXTREME_WBS_DEPTH_CSV = b"""\
Name,Level
Shallow,1
Deep,70000
"""

# A 2-cycle in the predecessor column: 1 depends on 2 and 2 depends on 1. The
# parser leaves the edge set intact; the graph guard must reject it before any
# write happens.
CYCLIC_CSV = b"""\
ID,Name,Duration,Predecessors
1,A,2,2
2,B,2,1
"""

# Unambiguous day-first dates (13 and 25 cannot be months), which must flip the
# whole file's interpretation to D/M/Y -- including the ambiguous 03/04 row.
DAY_FIRST_CSV = b"""\
Name,Start
Ambiguous,03/04/2026
Clearly day first,13/04/2026
Also day first,25/12/2026
"""

# Semicolon-delimited, which European Excel emits by default.
SEMICOLON_CSV = b"""\
Name;Duration;Start
Design;3;2026-03-02
Build;5;2026-03-05
"""

# No column that can supply Task.name -- structurally unusable, so this is the
# one case that raises rather than reporting row errors.
NO_NAME_COLUMN_CSV = b"""\
Widget,Quantity,Cost
Bolt,4,1.20
"""

EMPTY_CSV = b"   \n\n"


def build_xlsx(rows: list[list[object]], sheet_names: list[str] | None = None) -> bytes:
    """Build a real .xlsx in memory from ``rows`` (first row = headers).

    Uses openpyxl rather than a checked-in binary so the fixture stays readable
    in the diff and cannot drift from what the test claims it contains.
    """
    import openpyxl

    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = (sheet_names or ["Plan"])[0]
    for row in rows:
        worksheet.append(row)
    for extra in (sheet_names or ["Plan"])[1:]:
        workbook.create_sheet(extra)

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def build_zip_bomb(declared_size: int) -> bytes:
    """Build a zip whose central directory declares a huge uncompressed size.

    Highly compressible content, so the archive itself stays tiny while
    ``ZipFile.infolist()`` reports ``declared_size`` -- exactly the shape the
    parser's pre-parse guard exists to reject.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", b"\0" * declared_size)
    return buffer.getvalue()


# Labels spread across two columns with different spellings, mixed separators,
# and a case variant — the shape a real migrated sheet has (#2406).
LABELS_CSV = b"""\
ID,Name,Duration,Tags,Component
1,Site survey,3,"safety, rework",Civil
2,Foundation pour,5,safety;permit,Civil
3,Steel erection,8,SAFETY,Structural
4,Fit-out,10,,
"""

# Dependencies spread across numbered columns, as MS Project's CSV export writes
# them, plus one duplicate reference across the two columns.
MULTI_PREDECESSOR_CSV = b"""\
ID,Name,Duration,Predecessor 1,Predecessor 2
1,Design,5,,
2,Procure,3,,
3,Build,8,1,2
4,Inspect,2,3,3
"""
