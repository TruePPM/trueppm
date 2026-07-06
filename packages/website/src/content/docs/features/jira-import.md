---
title: Jira import
description: Import a Jira Server / Data Center XML export into an existing TruePPM project — one task per issue, durations from original estimates, and Finish-to-Start dependencies from Blocks links — as a CPM-schedulable network. An offline, one-way, file-based migration path, not a live connector.
---

:::note[Coming in 0.4]
Offline Jira import lands in **TruePPM 0.4**, the first beta. On unreleased
builds the mapping and endpoint may still be changing.
:::

TruePPM can turn a **Jira Server / Data Center** issue export into a
**CPM-schedulable** project: upload the XML you get from Jira's issue navigator,
and TruePPM creates one task per issue, sets each task's duration from its
original estimate, and draws a Finish-to-Start dependency for every **Blocks**
link. The result is a real critical-path network — durations plus dependencies
are exactly what the [scheduling engine](/features/scheduler/) needs to compute
dates.

This is the **minimal "get real data in and computable" slice**: enough to lift
a Jira issue set into a schedule and see a critical path, not a full-fidelity
Jira replica. See [What does *not* map](#what-does-not-map) for the deliberate
exclusions.

:::note[This is an offline import, not a live Jira connector]
Jira import is an **offline, one-way, file-based** migration — the same shape as
[MS Project import](/features/msproject-import-export/). You export a file from
Jira and upload it; TruePPM never talks to Jira, never authenticates against it,
and never writes anything back. It is **not** the bidirectional, org-wide
Integration Hub (that lives in the enterprise edition), and it does **not** imply
ongoing Jira ↔ TruePPM synchronization. It is a point-in-time snapshot import.
:::

## Export your issues from Jira (Server / Data Center)

Jira import reads the **XML** produced by Jira's issue navigator — the format
that carries the `<issuelinks>` block, which is what makes the network
computable. (CSV does not include issue links, so it is not accepted.)

1. In Jira, open the **issue navigator** and run the filter (or search) whose
   issues you want to import.
2. Choose **Export → XML** (top-right of the navigator).
3. Save the resulting `.xml` file.

:::caution[Server / Data Center only — Jira Cloud has no XML export]
This importer targets **Jira Server / Data Center**, which offers **Export →
XML**. **Jira Cloud removed the XML export**, so there is no Cloud file to
upload here — Cloud migration is a separate track and is out of scope for this
offline importer. (Ongoing one-way Jira → TruePPM card sync is a distinct,
later feature; see the [roadmap](/overview/roadmap/).)
:::

## Import the file into a project (Admin only)

Jira import lands issues into an **existing** project. Upload runs through the
API described below; the import is enforced server-side to require the
**Project Admin** role on the destination project — members below Admin cannot
import.

The import runs **asynchronously**. A successful upload returns immediately with
an `import_request_id`; the worker parses the file, validates the derived graph,
persists the tasks and dependencies, and triggers a CPM recalculation in the
background. The schedule refreshes once the import finishes.

## What maps

| Jira export | TruePPM | Notes |
|---|---|---|
| One `<item>` (issue) | one `Task` | Flat WBS — sequential top-level outline numbers, no hierarchy |
| `<summary>` | `Task.name` | Falls back to the RSS `<title>` (key prefix stripped), then the bare issue key, so a task is never nameless |
| `<timeoriginalestimate seconds="…">` | `Task.duration` | Seconds → whole working days on an 8-hour day (see [Duration mapping](#duration-mapping)) |
| `Blocks` issue link | Finish-to-Start `Dependency` | Both directions read ("blocks" and "is blocked by"); lag `0`. See [Dependency mapping](#dependency-mapping) |
| `<channel><title>` | `Project.name` (on the import summary) | Used to label the imported set; falls back to "Imported from Jira" |

### Duration mapping

Jira stores the original estimate in **seconds**. TruePPM converts to whole
working days on an **8-hour day**, rounding **up** to the next whole day and
**flooring at 1** — an issue with no estimate (or an unparseable one) still
becomes a **1-day** task, never zero-length. A zero-duration task is invisible
to CPM float and critical-path math, which is the entire reason the importer
reads estimates at all.

| Jira `timeoriginalestimate` | Working days |
|---|---|
| _(absent / unparseable)_ | 1 |
| 4 h (14 400 s) | 1 |
| 8 h (28 800 s) | 1 |
| 12 h (43 200 s) | 2 |
| 16 h (57 600 s) | 2 |
| 3 d @ 8 h (86 400 s) | 3 |

### Dependency mapping

Every Jira **Blocks** link becomes a **Finish-to-Start** dependency with **lag
0**. The link direction sets predecessor and successor:

- An **outward** "blocks" link makes the issue the **predecessor** (the blocker).
- An **inward** "is blocked by" link makes the issue the **successor** (the
  blocked issue).

Because both endpoints of a single link appear in the export, TruePPM normalizes
and de-duplicates the two halves so a link is imported once. Only the **Blocks**
link type is read — other Jira link types (Relates, Duplicates, Clones, and any
custom link types) are ignored.

## What does *not* map

This is the minimal computable slice. The following are **deliberately out of
scope** for this importer — they are not imported, and no error is raised for
their presence:

- **Sprints** and sprint assignment
- **Assignees as resources** (no resource records or allocations are created)
- **Parent / subtask hierarchy** — the WBS is flat; subtasks import as their own
  top-level tasks
- **Epics and epic links**
- **Custom fields**
- **Saved filters / board views**
- **Start-date, due-date, and other fixed-date constraints** — CPM derives dates
  from durations and dependencies
- **Non-`Blocks` link types** (Relates, Duplicates, Clones, custom links)
- **Jira Cloud exports** — Cloud has no XML export (Server / DC only)
- **Any writeback to Jira** — this is a one-way, read-only import

CPM needs only durations and dependencies to compute a critical path, so the
excluded fields are not required to get a working schedule. Richer, multi-format
import (including broader Jira coverage and a mapping-preview step) is on the
[roadmap](/overview/roadmap/).

## Invalid and skipped input

The import is **validated before anything is written**, so a messy export can
never persist an infeasible schedule that would later crash the CPM / what-if
engine.

- **A cyclic or self-blocking set of `Blocks` links fails the import.** If the
  derived dependency graph contains a cycle (A blocks B blocks … blocks A), the
  whole import is **rejected and marked failed** — no tasks or dependencies are
  created. CPM cannot schedule a cyclic network, so the importer refuses it up
  front rather than persisting a graph the engine can't compute.
- **Self-referential links are silently skipped.** A `Blocks` link from an issue
  to itself is dropped (quarantined) with a warning; it does not fail the import.
- **Links to issues not in the export are silently skipped.** A `Blocks` link
  pointing at an issue that isn't part of this XML (e.g. it was filtered out) is
  dropped with a warning — an issue outside the export can't be scheduled.
- **Issues with no key**, and **duplicate keys**, are skipped with a warning.

Skipped items are recorded as warnings on the import summary; only a genuine
cycle (or an unparseable file) fails the import outright.

## Using the API

The import authenticates with a bearer token (`$JWT`); `$PROJECT_ID` is the
destination project UUID. The endpoint accepts a single `.xml` file as multipart
form-data in the `file` field, and requires **Project Admin**.

```bash
# POST a Jira Server/DC XML export as multipart form-data (field: "file").
# Requires project Admin. Default upload cap 25 MB (JIRA_IMPORT_MAX_UPLOAD_MB).
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  -F "file=@jira-export.xml" \
  https://trueppm.example.com/api/v1/projects/$PROJECT_ID/import/jira/
# 202 Accepted: {"detail": "Import queued.", "import_request_id": "<uuid>"}
```

A `202` means the file was accepted and queued — **not** that the import has
finished. The import runs asynchronously and is **durable**: it is committed to
an outbox row before dispatch, so a brief task-broker outage does not lose it —
the request stays queued and is picked up automatically. A deterministic failure
(an unparseable file, or a cyclic graph) marks the request terminal so it is not
retried forever.

Only `.xml` is accepted. A different extension is rejected with `400` before any
parsing happens; a file above the size cap is rejected with `400` naming the
configured limit; a caller without the Admin role gets `403`.

## Configuration

The only operator-facing knob is the upload size cap, `JIRA_IMPORT_MAX_UPLOAD_MB`
(default **25** MB), documented in the
[configuration reference](/administration/configuration/#jira-import-limit).

Like the MS Project importer, Jira XML is parsed through `defusedxml`, which
refuses entity declarations and external-entity resolution — a "billion laughs"
or XXE payload is rejected at parse time. The parser treats every uploaded byte
as untrusted input; this protection is unconditional.
</content>
