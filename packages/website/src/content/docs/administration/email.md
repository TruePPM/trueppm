---
title: Outbound Email (SMTP)
description: How TruePPM sends outbound notification email, the writable Workspace Email & SMTP page, and the Django EMAIL_* settings that configure the fallback transport.
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

You configure the outbound transport one of two ways: in-app from the
**Workspace → Settings → Email & SMTP** page, or through Django's standard
`EMAIL_*` environment settings. The in-app page is the primary surface; the
`EMAIL_*` settings remain the fallback the page uses in its default **TruePPM
cloud** mode.

:::note[The writable Email & SMTP page lands in 0.4]
The in-app SMTP configuration surface described in the next section **ships in
0.4** (TruePPM's first beta). Before 0.4, transport is set only through the
`EMAIL_*` environment settings below; those settings stay valid afterward as the
default "TruePPM cloud" mode's fallback.
:::

## Configuring email in-app

The **Workspace → Settings → Email & SMTP** page lets the install **operator**
configure the outbound transport without editing settings or redeploying. Once a
transport is configured here, it governs **all** outbound mail — notifications,
invites, and password-reset messages alike — overriding the `EMAIL_*`
environment defaults. Left on the default **TruePPM cloud** mode, behavior is
unchanged: mail flows through whatever the `EMAIL_*` settings configure, exactly
as it did before this page existed.

### Who can configure it

Any workspace admin can **view** the current email posture on this page. Only the
**install operator** — a Django superuser — can **change** it. The transport is
installation-global, so a single-project admin cannot repoint every outbound
message at an attacker-controlled relay: the write path is operator-only by
design, while the read path stays open to admins who need to see how mail is set
up.

### Transport modes

The page offers four transports:

| Mode | What it does |
|---|---|
| **TruePPM cloud** | The default. Falls back to the `EMAIL_*` environment settings — today's behavior. No SMTP credentials are stored on the row. |
| **Custom SMTP** | You supply the host, port, connection security (None / STARTTLS / SSL-TLS), username, and password. |
| **SendGrid** | Sends through SendGrid's SMTP relay. You supply only the API key (the host and username are fixed). |
| **Amazon SES** | Sends through the region's SES SMTP relay. You supply the region-derived host, username, and password. |

SendGrid and SES are SMTP relays, so no extra backend is needed — all three
non-cloud modes build a standard SMTP connection.

### The password is encrypted and never returned

The SMTP password (or SendGrid API key) is **encrypted at rest** with Fernet,
using the `INTEGRATION_ENCRYPTION_KEY`, and is **never returned by the API** —
the page shows only whether a password is set (`password_is_set`), never the
value. Leaving the password field blank on save **keeps the stored secret**, so
you can edit other fields without re-entering it. Switching to a different
transport does require re-entering the password (a SendGrid API key is not an
SES password).

### Validation before save

A save **opens the candidate transport before it is persisted**. If the host,
port, security, or credentials are wrong, the save is rejected with a `400` and
**nothing is written** — a bad configuration can never lock the workspace out of
mail. The error message is deliberately generic and never echoes the underlying
SMTP exception (which could leak credentials).

### From identity, limits, and bounce webhook

Alongside the transport, the page configures:

- **From identity** — a From name, From address, reply-to address, and DKIM
  selector for the outbound `From:` header.
- **Delivery limits** — a maximum recipients per message and an optional
  per-minute throttle (`0` means no throttle).
- **Bounce webhook URL** — where the provider can post bounce events.

Both the SMTP host and the bounce webhook URL are **SSRF-guarded**: a host or URL
that resolves to a private, loopback, link-local, or cloud-metadata address is
rejected, and the host is re-checked at send time to close the DNS-rebinding
window.

### Send a test email

The page has a **Send test email** action that sends a fixed test message
through the resolved transport. It always sends to the **requesting operator's
own account address** — never an address from the request — so the action can
never be used as an authenticated open relay. You get an immediate pass/fail
result; a transport failure returns a generic `502`.

### Deliverability health

The page runs live **SPF / DKIM / DMARC** checks against the From-address domain:
bounded DNS `TXT` lookups that report each record as `pass`, `warn`, or `fail`.
The lookups run only against the persisted, validated From domain (never a domain
from request input), are operator-gated, and degrade to "checks unavailable"
rather than erroring when no DNS resolver is present. Use this to confirm your
DNS is aligned before mail starts landing in spam — see
[SPF, DKIM, and DMARC alignment](#spf-dkim-and-dmarc-alignment) for what each
record means.

### Rate limits

The write, send-test, and health endpoints are **tightly rate-limited** — each
write re-opens a candidate SMTP connection and each health check is an outbound
DNS egress, so both are throttled to keep the surface from being abused.

## Environment configuration (`EMAIL_*`)

In the default **TruePPM cloud** transport mode — and on any install before the
in-app page ships — TruePPM uses Django's standard `EMAIL_*` settings. The
Beat-driven drain runs on the `api`, `celery`, and `celery-beat` workloads, so
all three need the same transport configuration.

:::tip[Set these via environment variables / Helm values]
Every `EMAIL_*` setting binds directly from the container environment, so you
configure SMTP with plain environment variables — no settings override needed.
Under the Helm chart, set them under `env:` in `values.yaml` (they flow to the
`api`, `celery`, and `celery-beat` workloads automatically); source
`EMAIL_HOST_PASSWORD` from a Kubernetes Secret via `secretKeyRef`, never plain
`values.yaml`. Leave `EMAIL_HOST` empty to run without outbound mail.
:::

| Setting | Purpose |
|---|---|
| `EMAIL_HOST` | SMTP relay hostname. Unconfigured ⇒ "Not configured" on the Email & SMTP page. |
| `EMAIL_PORT` | SMTP port (e.g. `587`). |
| `EMAIL_USE_TLS` | Use STARTTLS. |
| `EMAIL_USE_SSL` | Use implicit SSL/TLS (mutually exclusive with TLS). |
| `EMAIL_HOST_USER` | SMTP username. **Never exposed by the API.** |
| `EMAIL_HOST_PASSWORD` | SMTP password. **Never exposed by the API**, never logged. |
| `DEFAULT_FROM_EMAIL` | From address on every message (e.g. `notify@example.com`). |
| `EMAIL_BACKEND` | Django backend; use the SMTP backend in production. |

Source `EMAIL_HOST_PASSWORD` from a secret manager that your settings override
reads — never commit it in plain text.

### SPF, DKIM, and DMARC alignment

`DEFAULT_FROM_EMAIL` is the domain receiving mail servers check `SPF`, `DKIM`,
and `DMARC` alignment against. TruePPM sends the mail; **your** DNS
configuration is what makes it trusted:

- Use a `DEFAULT_FROM_EMAIL` domain you control and have published `SPF` and
  `DKIM` DNS records for. Most self-hosters send through a relay (Amazon SES,
  SendGrid, Postmark, or their own mail server via `EMAIL_HOST`) — the relay's
  setup docs walk through adding the required `SPF` (`TXT`) and `DKIM`
  (`CNAME`/`TXT`) records at your registrar or DNS host.
- `DMARC` alignment requires the `From` domain (`DEFAULT_FROM_EMAIL`) to match
  either the `SPF`-authenticated domain or the `DKIM`-signing domain. If your
  relay signs with a different domain than `DEFAULT_FROM_EMAIL`, alignment
  fails even though the message was accepted and delivered by the relay.
- A relay reporting "sent successfully" only confirms SMTP accepted the
  message — it says nothing about `SPF`/`DKIM`/`DMARC` alignment at the
  receiving end. Misaligned records are the most common reason self-hosted
  notification email lands in spam even though delivery looked fine from the
  sending side.

`SPF`, `DKIM`, and `DMARC` are DNS records you own and publish, not something a
`.env` value or Helm value configures — TruePPM cannot enforce alignment for
you. It can, however, **check** it: the [Deliverability health](#deliverability-health)
panel on the Email & SMTP page runs live `SPF`/`DKIM`/`DMARC` lookups against
your From domain and flags each as `pass`, `warn`, or `fail`, so you can confirm
the records are in place before mail goes out.

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
- Comment/mention snippets embedded in the body are bounded and word-wrapped
  before sending, so a very long unbroken string (a pasted URL, log line, or
  base64 blob) can't render as one unbounded line in the recipient's mail
  client.

### List-Unsubscribe headers

Notification email carries `List-Unsubscribe` and `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` headers (RFC 8058), pointed at the recipient's
**User → Settings → Notifications** page. Gmail, Outlook, and other large
mailbox providers weight the presence of these headers into their
bulk-sender spam heuristics, so including them helps delivery even at
TruePPM's low, opt-in notification volume.

The headers link to the login-gated preferences page, not a no-auth one-click
unsubscribe endpoint — TruePPM issues no per-notification unsubscribe token,
so "one click" here means one click through to sign-in and preferences, not
an anonymous unsubscribe. The headers are only added when
[`FRONTEND_BASE_URL`](/administration/configuration/) is configured, since a
bare relative path is not a valid header value; leave it unset and the email
still sends, just without them.

## Disabling email

Leave the transport on **TruePPM cloud** with no `EMAIL_HOST` configured to run
without outbound email — in-app notifications keep working and the Email & SMTP
page reports the transport as not configured.
