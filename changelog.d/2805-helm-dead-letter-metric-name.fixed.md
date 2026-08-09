- **Helm dead-letter alert and dashboard panel never fired**: the starter
  `TruePPMDeadLetterPresent` alert and the "Dead-letter parked tasks" Grafana panel
  queried `trueppm_deadletter_parked`, which nothing emits — the API publishes
  `trueppm_task_dead_letter_parked`. Prometheus evaluates an unknown name to an
  empty vector rather than an error, so the alert could never fire and the panel
  was permanently blank, leaving permanently-lost background work unnoticed. Both
  now use the emitted name.
- **Observability docs**: the Helm observability page now states that the
  dead-letter gauge is Prometheus text exposition on `/api/v1/health/dead-letter/`
  and needs its own scrape job — it does not arrive over OTLP like the outbox and
  database gauges.
- **New `helm:metric-names` CI gate**: fails the pipeline whenever the chart's
  PromQL references a `trueppm_*` series the application does not emit, in either
  direction (a chart-only edit or an API-side rename).
