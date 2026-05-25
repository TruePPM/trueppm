# Outbound email (SMTP)

TruePPM sends outbound email — @mention notifications and the own-task
notifications added in #639 (task assigned to you, planned date changed,
comment on your task) — through Django's email backend. Delivery is
**best-effort and opt-in**: a notification is emailed only when the recipient
has turned the Email channel on for that event under
**User → Settings → Notifications** (email is OFF by default).

There is no in-app SMTP credential editor in the community edition. Transport is
configured entirely through environment variables / Helm values, and the
read-only **Workspace → Settings → Email & SMTP** page reflects whatever the
deployment is configured with.

## Configuration

All settings are standard Django email settings, read from the environment (or
your Helm `values.yaml`). Set them on the `api`, `celery`, and `celery-beat`
workloads — the Beat-driven drain is what actually sends the mail.

| Variable | Purpose | Example |
|---|---|---|
| `EMAIL_HOST` | SMTP relay hostname. When unset, no host is configured and the status page shows "Not configured". | `smtp.example.com` |
| `EMAIL_PORT` | SMTP port. | `587` |
| `EMAIL_USE_TLS` | Use STARTTLS on connect. | `true` |
| `EMAIL_USE_SSL` | Use implicit SSL/TLS (mutually exclusive with `EMAIL_USE_TLS`). | `false` |
| `EMAIL_HOST_USER` | SMTP auth username. **Never exposed by the API.** | `apikey` |
| `EMAIL_HOST_PASSWORD` | SMTP auth password. **Never exposed by the API**, never logged. | *(secret)* |
| `DEFAULT_FROM_EMAIL` | From address on every outbound message. | `notify@example.com` |
| `EMAIL_BACKEND` | Django backend. Defaults to SMTP in production; `console`/`locmem` in dev/test. | `django.core.mail.backends.smtp.EmailBackend` |

Store `EMAIL_HOST_PASSWORD` as a Kubernetes Secret referenced by the Helm chart,
not in plain `values.yaml`.

## The read-only status page

**Workspace → Settings → Email & SMTP** (visible to org admins — any user with
the Admin role on a project) shows the resolved transport mode, host, port,
TLS/SSL, and the From address — sourced from the settings above. It is
**read-only**: the page never displays the username or password, and it cannot
change configuration. To change transport, update the environment / Helm values
and redeploy.

A writable in-app SMTP configuration surface (transport switching, bring-your-own
credentials, DKIM, throttling) is planned as a follow-up and is not part of the
community edition today.

## Delivery behavior

- Emails are queued as notification rows and sent by the
  `drain_notification_emails` Beat task (every 30 s), not inline on the request.
  A broker or SMTP outage delays delivery; it does not block the triggering
  action (assigning a task, commenting, etc.).
- Each message is retried up to 3 times; after that the notification stays in the
  in-app inbox but stops attempting email.
- Bodies are plain text. A recipient with no email address on their account is
  skipped (the in-app notification still appears).

## Disabling email

Leave `EMAIL_HOST` unset to run without outbound email entirely — in-app
notifications continue to work, and the status page reports the transport as not
configured. Users will still see their inbox; no email is attempted.
