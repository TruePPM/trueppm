---
name: changelog
description: >
  CHANGELOG.md update for TruePPM. Use before finishing any branch that touches
  source code to ensure the [Unreleased] section is updated. The CI changelog-check
  job will block the pipeline if it is missing.
---

# Changelog Skill

You are updating `CHANGELOG.md` for a TruePPM branch before it is merged.

## Format (Keep a Changelog)

```markdown
## [Unreleased]

### Added
- New features or capabilities

### Changed
- Changes to existing behavior (breaking or not)

### Fixed
- Bug fixes

### Removed
- Removed features or deprecated items
```

Rules:
- Only use the headings that apply — omit empty sections
- Never create duplicate headings within the same `[Unreleased]` block
- Append to the existing block; do not create a new `## [Unreleased]` section
- Each bullet is one user-facing change: what changed and why it matters
- Internal refactors, CI config, and test-only changes do not need entries
- Dependency bumps only need an entry if they change user-visible behavior

## What to Include

**Always include:**
- New API endpoints or fields
- Changed API behavior (even non-breaking)
- New CLI flags or commands
- New model fields visible to API consumers
- Bug fixes that affected users
- Performance improvements with measurable impact

**Never include:**
- CI pipeline changes
- Test additions with no behavior change
- Internal refactors with no API/UI impact
- Dependency version bumps (unless behavior changes)
- Code style / lint fixes

## Process

1. Read the current `CHANGELOG.md`
2. Read `git diff main...HEAD` to understand all changes on the branch
3. Group changes under the correct headings
4. Write entries in plain English from the user's perspective
5. Confirm no duplicate headings exist in `[Unreleased]`
6. Commit with message: `docs: update CHANGELOG for <feature>`

## Example Entries

```markdown
### Added
- REST endpoint `POST /api/v1/schedules/trigger/` to kick off CPM recalculation
  for a project asynchronously; returns a Celery task ID for polling.
- `Task.is_critical` field exposed on the task list endpoint with filter support
  (`?is_critical=true`).

### Changed
- `GET /api/v1/tasks/` now requires `?project=<uuid>` — unfiltered list is rejected
  with 400 to prevent full-table scans.

### Fixed
- CPM backward pass incorrectly computed late_finish for tasks with SS dependencies
  when lag > 0; schedules with this pattern now produce correct float values.
```
