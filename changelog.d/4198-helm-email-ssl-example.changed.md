- **Helm chart `EMAIL_*` example**: `values.yaml`'s commented outbound-email
  block now includes a paired example for implicit-SSL/port-465 relays
  (`EMAIL_USE_SSL: "true"` with `EMAIL_USE_TLS: "false"`), alongside the
  existing STARTTLS/587 example, so setting only `EMAIL_USE_SSL` doesn't
  silently inherit TruePPM's `EMAIL_USE_TLS: "true"` default and fail at
  send time.
