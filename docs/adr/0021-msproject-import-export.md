# ADR-0021: MS Project Import/Export

## Status
Accepted

## Context
MS Project import/export is the #1 migration-gate feature for PMs evaluating TruePPM
(VoC panel 6.4/10). Without it, PMs cannot move existing schedules into TruePPM or
share schedules with stakeholders who use MS Project. Two file formats must be
supported:

- **.mpp** (binary, Microsoft proprietary) — read-only via MPXJ, a mature Java/C#
  library that is the de facto standard for reading binary Project files.
- **.xml** (MS Project XML schema) — read and write via Python stdlib
  `xml.etree.ElementTree`. The schema is well-documented and stable across
  Project 2010-2021.

VoC key blockers identified:
1. Dependency mapping is make-or-break for critical path preservation
2. WBS hierarchy must map correctly to `wbs_path` LtreeField
3. Import summary report needed in `result_summary`
4. Resource assignment import with name-matching

Relevant prior decisions:
- ADR-0001: `wbs_path` semantics (client-supplied ltree, `_build_wbs_path` utility)
- ADR-0011: Bulk import must bypass history via `.update()` not `.save()`
- ADR-0020: TaskRunTracker infrastructure (explicitly names MS Project import as a
  primary driver)

No file upload infrastructure currently exists (no MEDIA_ROOT, no FileField models).

## Decision

### Architecture

Create a new Django app `trueppm_api.apps.msproject` containing:

1. **Parser layer** — two parsers behind a common interface:
   - `MppParser`: shells out to MPXJ CLI (`mpxj-cli.jar`) as a subprocess, which
     converts `.mpp` to MS Project XML on stdout. Then delegates to `XmlParser`.
   - `XmlParser`: parses MS Project XML using `xml.etree.ElementTree` (stdlib).
   - Both return a `ProjectData` dataclass containing tasks, dependencies, resources,
     assignments, and project-level metadata.

2. **Importer** — `import_project(project_id, project_data, tracker)`:
   - Creates Task rows via `bulk_create` (bypasses history per ADR-0011)
   - Builds `wbs_path` from the MS Project `OutlineLevel` + `OutlineNumber` fields
   - Creates Dependency rows from `PredecessorLink` elements
   - Matches resources by name (case-insensitive); creates new Resource if no match
   - Creates TaskResource assignments
   - Reports progress via TaskRunTracker at 10/30/50/70/90%
   - Stores import summary in `result_summary`

3. **Exporter** — `export_project_xml(project_id) -> bytes`:
   - Queries all tasks, dependencies, resources, and assignments for the project
   - Builds MS Project XML document with correct schema namespace
   - Returns XML bytes (synchronous — no Celery needed for export)

4. **Celery task** — `import_msproject(project_id, file_content_b64, filename)`:
   - Wraps import in TaskRunTracker (falls back to no-op if not available)
   - Decodes base64 file content, detects format from extension
   - Calls parser -> importer pipeline
   - Triggers CPM recalculation on success

5. **REST endpoints**:
   - `POST /api/v1/projects/{pk}/import/msproject/` — accepts multipart file upload,
     validates size (10 MB max) and extension (.mpp/.xml), enqueues Celery task
   - `GET /api/v1/projects/{pk}/export/msproject.xml` — returns XML file download

### File Handling

Files are passed to Celery as base64-encoded content in the task kwargs (max 10 MB
= ~13.3 MB base64, well within Redis message limits). No persistent file storage
(MEDIA_ROOT) is needed — the file is consumed during import and discarded.

### MPXJ Integration

MPXJ is distributed as a Java JAR. The API container needs a JRE and the
`mpxj-cli.jar` on the filesystem. Configured via `MPXJ_JAR_PATH` setting
(default: `/opt/mpxj/mpxj-cli.jar`). Environments without Java get a clear
error on .mpp import; .xml import and all exports work without Java.

### Field Mapping

| MS Project XML | TruePPM Model | Notes |
|----------------|---------------|-------|
| Task/Name | Task.name | Direct |
| Task/Duration | Task.duration | Parse ISO 8601 duration to working days |
| Task/Start | Task.planned_start | Only if not auto-scheduled |
| Task/OutlineNumber | Task.wbs_path | Convert dotted outline to ltree |
| Task/Milestone | Task.is_milestone | Direct boolean |
| Task/PercentComplete | Task.percent_complete | 0-100 to 0.0-1.0 |
| Task/Notes | Task.notes | Direct |
| PredecessorLink/Type | Dependency.dep_type | 0=FF, 1=FS, 2=SF, 3=SS |
| PredecessorLink/LinkLag | Dependency.lag | Tenths of minutes to days |
| Resource/Name | Resource.name | Match or create |
| Resource/MaxUnits | Resource.max_units | Direct |
| Assignment/Units | TaskResource.units | Direct |

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| MPXJ via jpype (in-process JVM) | No subprocess overhead | JVM memory complexity |
| lxml for XML parsing | XPath, faster | Extra dependency; stdlib ET suffices |
| Store uploaded file on disk/S3 | Supports re-import | Adds storage infrastructure |
| Synchronous import (no Celery) | Simpler flow | Large files block request workers |

## Consequences

- **Easier**: PMs can migrate existing MS Project schedules into TruePPM
- **Harder**: Docker image grows (~200 MB for JRE); MPXJ JAR must be managed
- **Risks**: MPXJ subprocess could hang (mitigated by timeout); XML schema
  variations across versions (mitigated by defensive parsing with warnings)

## Implementation Notes

- P3M layer: Programs and Projects (single-project import/export)
- Affected packages: api (new app, Celery task, endpoints)
- Migration required: no (no new models)
- API changes: yes — two new endpoints under `/api/v1/projects/{pk}/`
- OSS or Enterprise: OSS (single-project scope, PM migration tool)
- Dependencies added: none (stdlib XML; MPXJ is a runtime binary, not pip)

## Tracking

Tracking: implemented in #128 (MS Project MPP import via MPXJ); the production-ready
migration on-ramp is tracked under epic #796, and the PERT-mapping extension under
ADR-0093 / #798.
