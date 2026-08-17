---
title: Git-event automation
description: Move task cards automatically when a linked pull/merge request opens or merges. Set up the per-project webhook, signing secret, task link, and provider configuration from Project → Settings → Integrations.
documentedFor: "0.4"
---

:::note[Added in 0.3 (alpha)]
The Git-event automation settings UI was added in **TruePPM 0.3**, available
since the `0.3.0-alpha.1` pre-release (Jun 28, 2026). 0.3 is an alpha release;
the first beta is planned for 0.4.
:::

:::note[Ships in 0.4]
Two things on this page ship in **0.4** and are not in `0.3.0-alpha.3`: the
**Last delivery** row described under [Check what happened to a delivery](#check-what-happened-to-a-delivery),
and the rule that a **draft** pull/merge request does not move the card. On 0.3,
the settings card shows no delivery history at all, and opening a draft moves the
card straight to Review. Everything else on this page describes 0.3 as shipped.
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

## The prerequisite: each task needs a link to its pull/merge request

**Automation moves a card only if some task in the project already carries the
pull/merge request URL as a link.** There is no branch-name convention, no commit
trailer, and no search — matching is an exact URL comparison against the links
saved on the project's tasks. If no task links to the incoming PR/MR, the delivery
verifies successfully, your provider shows a green check, and **nothing moves**.

This is the single most common reason a correctly configured webhook appears to do
nothing, so do it first:

1. Open the task on the board or in the schedule.
2. In the task drawer, go to **Files → External links**.
3. Paste the pull/merge request URL and save it.

A few things worth knowing:

- The link must point at the pull/merge request itself
  (`https://github.com/acme/api/pull/5`,
  `https://gitlab.com/acme/api/-/merge_requests/7`) — not at a branch, a commit,
  or an issue.
- One link per task per PR/MR is enough. The comparison ignores host casing and
  the usual URL noise, but it is still the *same* pull/merge request that has to
  be named.
- Add the link **before** the pull request opens if you want the open event to
  move the card. A delivery that arrives with no link is not replayed — you can
  re-send it from your provider's webhook page after adding the link, or just move
  the card by hand that once.

## Set it up

1. **Link the task to its pull/merge request** (above). Without this nothing moves.
2. Open **Project → Settings → Integrations**. In the **Git-event automation**
   section, turn the toggle **on**. It is off by default — cards only move while
   it is on.
3. **Copy the webhook URL.** It is unique to this project.
4. Click **Generate secret**. The signing secret is shown **once** — copy it
   immediately. It can't be retrieved again; if you lose it, rotate to issue a
   new one.
5. Add the webhook in your Git provider (see below), pasting in the URL and the
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

## Draft pull/merge requests do not move the card

A **draft** pull request (GitHub) or **draft / work-in-progress** merge request
(GitLab) that opens leaves the card exactly where it is. Opening a draft to run CI
is not a request for review, and because automation only ever moves cards
*forward*, a card promoted by mistake cannot be walked back by a later event.

The card moves to **Review** when the pull/merge request is marked **ready for
review**. A merge always completes the card, draft flag or not.

## Check what happened to a delivery

The **Last delivery** row in the Git-event automation section reports what the
receiver did with the most recent webhook it received for this project — the
outcome, the provider, and when it arrived. It is the place to look when cards are
not moving, because most failures are invisible from your provider's side: the
provider shows a green check for anything the receiver accepted, including
"verified, but no task links to this pull request".

What the outcomes mean:

| Last delivery says | What happened | What to do |
| --- | --- | --- |
| Card moved to Review / Complete | Working as intended. | Nothing. |
| Card already at or past the target | Forward-only: the card was already there. | Nothing. |
| No task is linked to that pull/merge request | The delivery verified, but nothing matched. | Add the PR/MR URL to the task (see the prerequisite above). |
| Draft pull/merge request ignored | Deliberate — a draft does not promote. | Mark the pull/merge request ready for review. |
| Signature rejected | The secret in your provider does not match this project. | Rotate the secret and paste the new value into the webhook. |
| Delivery arrived while automation was off | The toggle is off. | Turn it on. |
| Delivery arrived with no secret set | Automation is on but unsecured. | Generate a secret and paste it into your provider. |
| Unrecognized provider | The request carried neither a GitHub nor a GitLab event header. | Check you pasted the URL into a Git provider's webhook settings. |
| Stored secret could not be read | The encryption key changed since the secret was stored. | Rotate the secret, then update your provider. |
| No webhook delivery received yet | Nothing has reached this project. | Check the URL in your provider and use its "Redeliver" / "Test" button. |

Every refused delivery is also written to the API server log as a warning naming
the project and the reason, so an operator can alert on them.

**Your provider will report a refusal as `404 Not Found`, whatever the cause.**
That is deliberate. The receiver is unauthenticated — anyone who knows a project's
ID can POST to it — so a wrong secret, a disabled toggle, and a project with no
automation at all must be impossible to tell apart from outside. Otherwise the
endpoint becomes a way to discover which of your projects have automation
configured. The real reason is in the **Last delivery** row and the server log,
both of which require you to already be an Owner or Admin of that project.

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
- **Uniform refusals.** Every rejection before signature verification returns the
  same `404`, so the endpoint cannot be used to find out which projects have
  automation enabled. See [Check what happened to a delivery](#check-what-happened-to-a-delivery).
- **Bounded.** Inbound payloads over **1 MB** are rejected before they are read,
  and deliveries are rate-limited both per project and per source address.

## Relationship to the Integration Hub

This is the **OSS**, user-driven, per-project automation. The org-wide,
bidirectional **Integration Hub** (centrally administered connectors with
writeback) is an Enterprise feature (ADR-0097). Git-event automation needs no
Enterprise edition — a single team can wire it up themselves.
