# MS Project test fixtures

## `sample.xml` — MS Project XML (2003+), namespaced

A 15-task, 3-phase "Office Relocation" project covering the core import surface:

| Feature | Example |
|---|---|
| Summary tasks | Phase 1 / 2 / 3 |
| Leaf tasks | 10 work tasks |
| Milestones | UID 5 (`Planning complete`), UID 15 (`Move complete`) |
| Dependency types | FS (most), SS (UID 8→7), FF (UID 10→9) |
| Lag | 2-day positive lag on UID 9→7 |
| Resources | 3 people, one at 50 % max units |
| Assignments | 8 assignments, one task (UID 3) with two resources |
| Percent complete | 100 % (UID 2), 50 % (UID 3), 0 % elsewhere |
| Notes | UID 2 has a freetext note |

---

## `sample_legacy.xml` — Pre-2003 style (no XML namespace)

A 13-task, 4-phase "Website Redesign" project. **Primary purpose:** exercises the
non-namespaced parser branch (`ns = ""`) in `parser.py`. The XML structure is
identical to the 2003+ format except the `<Project>` element carries no xmlns
attribute, matching the export style of older tools (MS Project 2000/2002,
ProjectLibre, GanttProject).

| Feature | Example |
|---|---|
| No XML namespace | Root `<Project>` has no xmlns |
| Summary tasks | Discovery / Design / Build / Launch |
| Milestones | UID 4 (`Discovery sign-off`), UID 13 (`Go live`) |
| Dependency types | FS (most), SS (UID 7→6), FF (UID 10→9) |
| Resources | 2 people, one at 50 % on a task |
| Percent complete | 100 % (UID 2), 75 % (UID 3) |

---

## `sample_2019.xml` — MS Project 2019 / Microsoft 365 style

A 19-task, 4-phase "ERP System Rollout" project. **Primary purpose:** verifies the
importer cleanly ignores modern elements that TruePPM does not (yet) use, while
correctly parsing tasks, dependencies, resources, and assignments.

Additional elements present (all silently skipped by the importer):

| Element | Notes |
|---|---|
| `<GUID>` / `<LastSaved>` | Project-level metadata |
| `<Calendars>` | Full working-time calendar block |
| `<ExtendedAttributes>` | Custom field definitions (RAG Status, Risk Score) |
| `<OutlineCodes>` | Workstream code definition |
| `<WBS>` on each task | Modern WBS field (redundant with OutlineNumber) |
| `<LagFormat>` on links | Per-link lag unit hint |
| `<CalendarUID>` on tasks/resources | Calendar assignment |
| `<EmailAddress>` / `<NTAccount>` on resources | Directory fields |
| `<ExtendedAttribute>` values on tasks | Inline custom field values |

Import surface covered:

| Feature | Example |
|---|---|
| Summary tasks | All 4 phases |
| Milestones | UIDs 4, 9, 19 |
| Dependency types | FS (most), SS with 2-day lag (UID 12→11), SF (UID 8→7) |
| Multiple predecessors | UID 17 has two FS predecessors (UIDs 15 and 16) |
| Resources | 4 people; one at 50 % max units |
| Assignments | 14 assignments; UID 3 and 12 each have two resources |
| XML-escaped characters | `&amp;` in task names (`Requirements &amp; Analysis`) |

---

## `sample.mpp` — MS Project binary (MPP)

Not committed to the repository. The binary format is proprietary and cannot be
generated without a licensed copy of Microsoft Project or the MPXJ CLI.

**To generate `sample.mpp` for local testing:**

```bash
# Requires: MPXJ CLI jar at /opt/mpxj/mpxj-cli.jar and JRE 11+
java -jar /opt/mpxj/mpxj-cli.jar \
  -i fixtures/sample.xml \
  -o fixtures/sample.mpp
```

Track the need for a committed MPP fixture in GitLab issue #118.

---

## Edge-case fixtures (issue #153)

The following ten fixtures cover edge cases not represented in the core samples.
Each has a corresponding `@pytest.mark.parametrize` case in `test_msproject.py::TestEdgeCaseFixtureFiles`.

| File | Tasks | Deps | Resources | Primary edge case |
|------|-------|------|-----------|-------------------|
| `minimal.xml` | 1 | 0 | 0 | Minimum valid import; regression baseline |
| `milestones_only.xml` | 5 | 0 | 0 | All tasks are milestones (`duration=0`, `Milestone=1`) |
| `deep_wbs.xml` | 13 | 3 | 0 | 4 outline levels; parent/child roll-up at depth |
| `all_dependency_types.xml` | 6 | 6 | 0 | FS + SS + FF + SF links; multi-predecessor; 2-day positive lag |
| `large_flat.xml` | 200 | 0 | 0 | Performance baseline; UID 1–200 continuity |
| `resource_overallocation.xml` | 3 | 1 | 2 | Resource assigned >100 % across concurrent tasks |
| `recurring_task.xml` | 6 | 1 | 0 | `<Recurring>1</Recurring>` container + 3 occurrences (flattened) |
| `cross_project_link.xml` | 3 | 2 | 0 | External `PredecessorUID` not in local task list |
| `unicode_names.xml` | 5 | 2 | 1 | CJK, RTL Arabic, emoji, XML-significant chars |
| `calendar_exceptions.xml` | 3 | 1 | 1 | Full `<Calendars>` block with exceptions (silently ignored) |
