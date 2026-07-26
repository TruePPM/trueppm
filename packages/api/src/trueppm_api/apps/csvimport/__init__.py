"""CSV / Excel spreadsheet import (#743, ADR-0632).

Parses a `.csv` or `.xlsx` upload into the shared ``ProjectData`` interchange
dataclass and hands it to ``msproject.importer.import_project`` — the same
persistence path MS Project and Jira already use (ADR-0259). This app owns a
parser, a fuzzy column mapper, and its own transactional outbox; it writes no
task, dependency, or resource rows itself.

The spreadsheet is the single largest source of new users: most small and
mid-size teams run their schedule in Excel and cannot evaluate TruePPM without
a migration path that is not manual re-entry.
"""
