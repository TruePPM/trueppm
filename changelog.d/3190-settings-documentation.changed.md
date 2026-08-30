**Four documented defaults contradicted the code, and about forty settings were
documented nowhere.** `configuration.md` listed `SECRET_KEY` as
`dev-secret-key-change-in-prod` and `REDIS_URL` as `redis://valkey:6379` — both
quoting `docker-compose.yml` rather than the code fallbacks
(`django-insecure-change-me-in-prod`, `redis://redis:6379`), so an operator
grepping their configuration for the documented string found nothing and could
conclude they had already changed it. The whole `EMAIL_*` row claimed
_(Django default)_ while four are overridden — including `DEFAULT_FROM_EMAIL`,
whose `notifications@trueppm.local` default uses a reserved TLD most relays
reject, silently breaking outbound mail on an otherwise correct SMTP setup.

New sections document logging, the OpenTelemetry family, retention windows, and
the rate-limiting and access knobs to the same standard as the rest of the page:
stated default, why you would change it, and what the options are. The handful
of variables that are read from the environment but are **not** operator
settings (pytest's own, the test-DB isolation vars, the SSO and integration
seeding fixtures) are listed as such, so a grep of the source does not leave
gaps unexplained.

**`packages/helm/values.yaml` and `.env.example` now carry documentation links.**
Between them they had none: their only `https://` strings were example values,
and the single pointer that existed read `Full variable list:
docs/administration/configuration.` — no scheme, no host, and a trailing period
that reads as part of the path. Both files now link to the relevant part of the
docs at each block, and `scripts/check-config-doc-links.sh` (CI job
`docs:config-links`, also in `make pre-push`) verifies every link resolves to a
page and anchor that exist — a link that 404s reads as authoritative and is
worse than no link. Closes #3190.
