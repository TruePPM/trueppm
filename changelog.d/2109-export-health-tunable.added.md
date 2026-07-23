- **Operator-tunable export-health thresholds**: the three thresholds behind the live
  export-health strip are now adjustable without a code change, via
  `TRUEPPM_OTEL_EXPORT_HEALTH_STALENESS_SECONDS`,
  `TRUEPPM_OTEL_EXPORT_HEALTH_HEALTHY_WITHIN_SECONDS`, and
  `TRUEPPM_OTEL_EXPORT_HEALTH_WINDOW_SECONDS` (with matching
  `observability.otlp.exportHealth.*` values in the Helm chart, rendered onto the api,
  celery-worker, and celery-beat pods). Unset knobs fall back to the documented defaults.
  A self-hoster with an unusual export cadence can retune the exporting / idle / stalled
  state machine to match their environment.
