---
title: Outbound Email (SMTP)
description: How TruePPM sends outbound notification email, the Django EMAIL_* settings that configure transport, and the read-only Email & SMTP status page.
---


:::note[Added in 0.2 (alpha)]
This page documents functionality added in **TruePPM 0.2**, available since the `0.2.0-alpha.1` pre-release (May 31, 2026). 0.2 is an alpha release; the first beta is planned for 0.4.
:::

TruePPM sends outbound email — @mention notifications and the own-task
notifications (a task assigned to you, the planned date of your task changing, a
comment on your task) — through Django's email backend. Delivery is
**best-effort and opt-in**: a notification is emailed only when the recipient has
turned the Email channel on for that event under **User → Settings →
Notifications**. Email is **off by default**.

There is no in-app SMTP credential editor in the community edition. Transport is
configured through Django's standard `EMAIL_*` settings, and the read-only
**Workspace → Settings → Email & SMTP** page reflects whatever the deployment is
configured with.

## Configuration

TruePPM uses Django's standard `EMAIL_*` settings. The Beat-driven drain runs on
the `api`, `celery`, and `celery-beat` workloads, so all three need the same
transport configuration.

:::caution[Set these via a Django settings override]
Dedicated environment-variable and Helm bindings for these settings are **not yet
wired**. Setting bare `EMAIL_HOST` and friends as container environment variables
has no effect today — configure SMTP with a Django settings override on your image
(a `local_settings`/override module that the settings package imports).
:::

| Setting | Purpose |
|---|---|
| `EMAIL_HOST` | SMTP relay hostname. Unconfigured ⇒ "Not configured" on the status page. |
| `EMAIL_PORT` | SMTP port (e.g. `587`). |
| `EMAIL_USE_TLS` | Use STARTTLS. |
| `EMAIL_USE_SSL` | Use implicit SSL/TLS (mutually exclusive with TLS). |
| `EMAIL_HOST_USER` | SMTP username. **Never exposed by the API.** |
| `EMAIL_HOST_PASSWORD` | SMTP password. **Never exposed by the API**, never logged. |
| `DEFAULT_FROM_EMAIL` | From address on every message (e.g. `notify@example.com`). |
| `EMAIL_BACKEND` | Django backend; use the SMTP backend in production. |

Source `EMAIL_HOST_PASSWORD` from a secret manager that your settings override
reads — never commit it in plain text.

## Read-only status page

**Workspace → Settings → Email & SMTP** (workspace Admins and Owners only) shows
the resolved transport mode, host, port, TLS/SSL, and From address. It never displays the
username or password and cannot change configuration — update the Django settings
and redeploy to change transport. A writable in-app SMTP
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
- Bodies carry a direct deep-link to the affected task when
  [`FRONTEND_BASE_URL`](/administration/configuration/) is set (e.g. the
  `task.blocked` email links straight to the blocked task). Leave it empty and the
  email still renders — it just omits the link.

## Disabling email

Leave SMTP unconfigured to run without outbound email — in-app notifications
keep working and the status page reports the transport as not configured.
