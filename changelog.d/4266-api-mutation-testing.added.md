- **Nightly mutation testing for the API's resource-utilization engine**: `api:mutation`
  runs `mutmut` against `apps/projects/utilization.py` — the calendar-aware
  capacity/utilization computation that has shipped wrong on green test suites before
  (bare `Task.assignee` reading as zero load; `early_start` misread as a commitment date
  instead of the remaining-work window) — and publishes its mutation score as a CI
  artifact. Report-only for now (no floor); a follow-up issue tracks setting one once a
  baseline window of nightly runs exists.
