- **Local dev stack SMTP catch-all**: `make up` now also starts a Mailpit
  container. The `api` and `celery` worker services are pre-wired to it via
  `EMAIL_HOST`/`EMAIL_PORT`/`EMAIL_USE_TLS`/`DEFAULT_FROM_EMAIL`, so
  password-reset, invite, and mention-notification emails sent by the dev
  stack are viewable at http://localhost:8025 instead of silently going
  nowhere against the previously-unset local `EMAIL_HOST`.
