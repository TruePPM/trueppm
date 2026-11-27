---
title: Forecast calibration capture
documentedFor: "0.5"
description: Opt a project in to recording its P50/P80/P95 forecasts at each baseline, and export them joined to actual finishes for calibration analysis.
---

:::note[Ships in 0.5]
Forecast calibration capture, the `forecast_calibration_capture` project setting, and the `export_forecast_calibration` management command ship in 0.5. The current release does not record forecasts for calibration.
:::

A P80 is a claim: across many forecasts, about 80% of forecast items should finish on or before it. Checking that claim takes a record of what was forecast and of when the work actually finished. Calibration capture keeps that record for projects that opt in. TruePPM does no calibration analysis itself. The export gives you the raw data.

## What is recorded

Each baseline of an opted-in project records one forecast. That covers the commit baseline, a named baseline, and a new version taken through a baseline decision (recorded as a *replan*). A forecast holds:

- **Project level**: the deterministic CPM finish, plus the P50/P80/P95 of the project's most recent Monte Carlo run, with each one's day edge, the time that run was computed, its iteration count, and the CPM finish it was computed against. The percentiles are empty if Monte Carlo has never run.
- **Each committed task**: the deterministic CPM finish, whether it is a milestone, and its estimate as it stood at that moment (duration, the three-point estimate, and the estimate's approval status). Per-task P50/P80/P95 are left empty for now.

Work that had already finished when a baseline was taken is recorded too, marked `finished_at_capture`. Leave those rows out when you measure how often a forecast held.

Backlog and epic items are not recorded. Nothing personal is stored: no user, assignee, team, task type, task or project name, or free text.

Actual dates are not copied when work starts or completes. The export reads them from the task at the time you export, so a corrected actual date is always the one you get.

## Turn it on for a project

The setting is off by default and is set per project. It is never inherited from a program or workspace, and settings templates do not copy it. Only a project **Admin** or **Owner** can change it, and every change is recorded in the project's history.

```bash
curl -X PATCH https://trueppm.example.com/api/v1/projects/<project-id>/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"forecast_calibration_capture": true}'
```

Recording starts at the project's next baseline. Earlier forecasts cannot be recovered, because their distributions were never kept.

Turning the setting off stops recording, and the project no longer appears in exports. Its existing records are kept, so turning it back on resumes with the old history intact. A project in the trash is not exported either. Its records are deleted when the project is permanently deleted.

## Retention

Calibration records are not covered by any [retention](/administration/retention/) purge. Forecast snapshots and Monte Carlo runs are trimmed after a while, but a calibration record is only useful once its actual finish arrives, often months later. Expect roughly one record per committed task per baseline.

## Export

The export is a management command, run from an API pod. It is not an API endpoint, so no API token or agent can pull the data.

```bash
python manage.py export_forecast_calibration                       # to stdout
python manage.py export_forecast_calibration --output cal.jsonl
python manage.py export_forecast_calibration --project <uuid> --project <uuid>
```

On Kubernetes, use `kubectl exec deploy/<release>-api -- python manage.py export_forecast_calibration > cal.jsonl`.

Only projects with the setting turned on, and not in the trash, are exported. The output is JSON Lines. The first line is a header:

```json
{"record": "header", "schema": "trueppm.forecast-calibration", "version": 1, "exported_at": "2026-12-01T09:00:00+00:00", "project_count": 1}
```

Each following line is one forecast:

| Field | Meaning |
|---|---|
| `project_id`, `capture_id` | The project, and the capture that this forecast was recorded in |
| `baseline_id` | The baseline that recorded the forecast, or `null` once that baseline is permanently removed |
| `captured_at` | When the forecast was made |
| `forecast_kind` | `baseline` or `replan` |
| `scope` | `project` or `task` (`task_id` is `null` for `project`) |
| `is_milestone` | Whether the task is a milestone |
| `finished_at_capture` | `true` if the work already had an actual finish when this was recorded (project scope: every committed task had one) |
| `duration` | Duration in working days at capture (`null` for `project`) |
| `optimistic_duration`, `most_likely_duration`, `pessimistic_duration` | The three-point estimate at capture, or `null` |
| `estimate_status` | The estimate's approval status at capture, or `null` |
| `deterministic_finish`, `deterministic_finish_at_day_start` | The CPM finish at capture, and whether it falls at the start of that day |
| `p50`, `p80`, `p95` | Forecast percentiles, or `null` |
| `p50_at_day_start`, `p80_at_day_start`, `p95_at_day_start` | Whether each percentile falls at the start of its day, or `null` |
| `distribution_computed_at`, `mc_iterations` | When the Monte Carlo run behind the percentiles was computed, and its iteration count |
| `distribution_cpm_finish`, `distribution_cpm_finish_at_day_start` | The CPM finish that Monte Carlo run was computed against, and its day edge, or `null` |
| `actual_start` | The task's actual start as of the export, or `null` (always `null` for `project`) |
| `actual_finish` | The actual finish as of the export, or `null` |
| `outcome` | `finished`, `open`, or `deleted` (the task was deleted; its forecast is kept) |

If `distribution_cpm_finish` differs from `deterministic_finish`, the plan moved after the Monte Carlo run, and you can leave that distribution out. Matching values do not prove the run was current.

## Compare actual with estimated duration

Estimates are in working days, but `actual_start` and `actual_finish` are calendar dates. To get an actual duration in working days, count the dates from `actual_start` to `actual_finish`, both included, whose weekday is a working day in the calendar that the baseline named by `baseline_id` froze. The baseline record keeps that weekday mask. The export file does not include it, so you need access to the instance. Skip milestones.

The result has limits. The frozen calendar has no holidays, other exceptions, or overlay calendars, so a task that spanned one comes out longer than it was. Work done on a non-working weekday is not counted. It is the project calendar, not a task's or a resource's own calendar. Treat the working-day actual as unknown when either actual date or `baseline_id` is `null`, or when the baseline has no calendar recorded.

A project-level forecast counts as `finished` only once every committed task has an actual finish. Its `actual_finish` is then the latest of those dates.

New fields can be added without changing the `version`. A renamed, removed, or retyped field increases it.
