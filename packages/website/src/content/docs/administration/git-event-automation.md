---
title: Git-event automation
description: Move task cards automatically when a linked pull/merge request opens or merges. Set up the per-project webhook, signing secret, and provider configuration from Project → Settings → Integrations.
---

:::note[Added in 0.3 (alpha)]
The Git-event automation settings UI was added in **TruePPM 0.3**, available
since the `0.3.0-alpha.1` pre-release (Jun 28, 2026). 0.3 is an alpha release;
the first beta is planned for 0.4.
:::

**Git-event automation** moves a task's board card automatically when its linked
pull/merge request changes state — so the board reflects delivery without anyone
dragging cards. When a linked PR/MR **opens**, the card moves to **Review**; when
it **merges**, the card moves to **Complete** (#1257, backend #329).

The receiver is **off by default** and project-scoped: each project has its own
webhook URL and signing secret. It moves cards **forward only** and never bypasses
your board's WIP or permission rules.

## Who can configure it

The Git-event automation section is **project-admin only** (Owner or Admin). A
Member never sees it. Configuration lives under **Project → Settings →
Integrations → Git-event automation**.

## Set it up

1. Open **Project → Settings → Integrations**. In the **Git-event automation**
   section, turn the toggle **on**. It is off by default — cards only move while
   it is on.
2. **Copy the webhook URL.** It is unique to this project.
3. Click **Generate secret**. The signing secret is shown **once** — copy it
   immediately. It can't be retrieved again; if you lose it, rotate to issue a
   new one.
4. Add the webhook in your Git provider (see below), pasting in the URL and the
   secret.

If automation is **on** but no secret is set, the receiver rejects every webhook
until you generate one — the settings page warns you when this is the case.

### GitHub

In the repository's **Settings → Webhooks → Add webhook**:

- **Payload URL** — the webhook URL you copied
- **Content type** — `application/json`
- **Secret** — the generated secret
- **Which events** — *Let me select individual events* → **Pull requests**

### GitLab

In the project's **Settings → Webhooks**:

- **URL** — the webhook URL you copied
- **Secret token** — the generated secret
- **Trigger** — **Merge request events**

## Rotating the secret

Click **Rotate secret** to issue a new signing secret. The previous secret stops
working **immediately**, so update your provider's webhook with the new value or
automation will stop. As with generation, the new secret is shown only once.

## How it stays safe

- **Signature-verified.** Every inbound webhook must carry a valid signature
  computed from the project's secret; unsigned or mis-signed requests are
  rejected. The secret is stored encrypted and is never returned by the API after
  generation.
- **Off by default.** Nothing happens until an admin both enables automation and
  sets a secret.
- **Forward-only.** Cards advance (→ Review, → Complete); the receiver never moves
  a card backward and never overrides board permissions.

## Relationship to the Integration Hub

This is the **OSS**, user-driven, per-project automation. The org-wide,
bidirectional **Integration Hub** (centrally administered connectors with
writeback) is an Enterprise feature (ADR-0097). Git-event automation needs no
Enterprise edition — a single team can wire it up themselves.
