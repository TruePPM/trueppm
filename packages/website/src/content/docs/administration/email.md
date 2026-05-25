---
title: Outbound Email (SMTP)
description: How TruePPM sends outbound notification email, the EMAIL_* environment variables that configure transport, and the read-only Email & SMTP status page.
---

TruePPM sends outbound email — @mention notifications and the own-task
notifications (a task assigned to you, the planned date of your task changing, a
comment on your task) — through Django's email backend. Delivery is
**best-effort and opt-in**: a notification is emailed only when the recipient has
turned the Email channel on for that event under **User → Settings →
Notifications**. Email is **off by default**.

There is no in-app SMTP credential editor in the community edition. Transport is
configured through environment variables / Helm values, and the read-only
**Workspace → Settings → Email & SMTP** page reflects whatever the deployment is
configured with.

## Configuration

Standard Django email settings, read from the environment (or your Helm
`values.yaml`). Set them on the `api`, `celery`, and `celery-beat` workloads —
the Beat-driven drain is what sends the mail.

| Variable | Purpose |
|---|---|
| `EMAIL_HOST` | SMTP relay hostname. Unset ⇒ "Not configured" on the status page. |
| `EMAIL_PORT` | SMTP port (e.g. `587`). |
| `EMAIL_USE_TLS` | Use STARTTLS. |
| `EMAIL_USE_SSL` | Use implicit SSL/TLS (mutually exclusive with TLS). |
| `EMAIL_HOST_USER` | SMTP username. **Never exposed by the API.** |
| `EMAIL_HOST_PASSWORD` | SMTP password. **Never exposed by the API**, never logged. |
| `DEFAULT_FROM_EMAIL` | From address on every message (e.g. `notify@example.com`). |
| `EMAIL_BACKEND` | Django backend; defaults to SMTP in production. |

Store `EMAIL_HOST_PASSWORD` as a Kubernetes Secret referenced by the chart, not
in plain `values.yaml`.

## Read-only status page

**Workspace → Settings → Email & SMTP** (org admins only) shows the resolved
transport mode, host, port, TLS/SSL, and From address. It never displays the
username or password and cannot change configuration — update the environment /
Helm values and redeploy to change transport. A writable in-app SMTP
configuration surface is a planned follow-up, not part of the community edition
today.

## Delivery behavior

- Email is queued as a notification row and sent by the
  `drain_notification_emails` Beat task (every 30 s), never inline — a broker or
  SMTP outage delays delivery but does not block the triggering action.
- Each message is retried up to 3 times; after that the notification remains in
  the in-app inbox but stops attempting email.
- Bodies are plain text. A recipient with no email address is skipped (the in-app
  notification still appears).

## Disabling email

Leave `EMAIL_HOST` unset to run without outbound email — in-app notifications
keep working and the status page reports the transport as not configured.
