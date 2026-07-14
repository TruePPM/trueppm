---
title: Timezone and date format
description: Two personal display preferences — your timezone and how dates are written — that re-clock and re-format what you see without changing anyone else's view or any data.
---

:::note[Ships in 0.4]
Personal timezone and date-format preferences ship in 0.4.
:::

**Timezone** and **Date format** are two personal display preferences on your
**Preferences → General** page (`/me/settings/general`). They change how TruePPM shows
times and dates **to you** — nothing about the underlying data, your teammates' views, or
anyone's permissions changes. They are display settings, not team or admin settings.

Both default to **Automatic**, so they work with zero configuration: until you pick an
override, TruePPM follows your device's timezone and locale.

## Timezone

Your timezone controls how *instant* timestamps are shown — a moment that happened at one
specific point in time, the same instant for everyone, just displayed in each person's
local clock. That covers:

- the **activity feed**,
- **comments**, and
- relative times like "2 hours ago".

Choose any IANA timezone (for example `Europe/London` or `America/New_York`), or leave it
on **Automatic** to use the zone your browser detects. If a colleague in another zone
comments at the same moment, you each see it in your own local time — the event is the
same, the clock is yours.

### Why your schedule dates don't move

Changing your timezone re-clocks timestamps, but it does **not** shift your schedule,
forecast, or Gantt dates. That is deliberate. A task that finishes on **July 14** is a
*calendar date*, not an instant — it means the fourteenth for everyone on the project,
whether they're in London, New York, or Tokyo. Calendar dates are timezone-independent by
design: if they slid around with each viewer's zone, a deadline could appear to land on a
different day for different people, and the schedule would stop meaning the same thing to
the team. So instants (activity, comments, "2 hours ago") follow your timezone; calendar
dates (schedule, forecast, milestones) stay put.

## Date format

Your date format controls how every displayed date is written — across **both** the
activity feed **and** the schedule, forecast, and Gantt. It changes the spelling of the
date, never the date itself.

| Option | Example | What it follows |
|---|---|---|
| **Automatic** (default) | — | Your device's locale |
| **ISO 8601** | `2026-07-14` | Year-month-day |
| **US** | `Jul 14, 2026` | Month-day-year |
| **European** | `14 Jul 2026` | Day-month-year |

Pick the one you read most fluently. If you leave it on **Automatic**, TruePPM uses your
device locale's convention.

## Display-only, end to end

These preferences never touch your data. Every timestamp is stored and sent over the API
in UTC as ISO-8601 — the server is timezone-neutral and format-neutral. Your timezone and
date format are applied only when TruePPM renders a value on **your** screen. That means:

- Switching either setting changes nothing for your teammates.
- Neither setting grants, removes, or affects any permission.
- Exports, the API, and integrations always carry the canonical UTC ISO-8601 value,
  independent of what you chose to see.

## Where to find it in the app

Open **Preferences → General** (`/me/settings/general`) and set **Timezone** and **Date
format**. Your choices are remembered and applied the next time you sign in.

## For developers

Both fields live on your user profile:

- **Read** — `GET /auth/me/` returns `timezone` (an IANA zone string) and `date_format`
  (one of `auto`, `iso`, `us`, `eu`).
- **Write** — `PATCH /auth/me/profile/` with `timezone` and/or `date_format`.

An empty or automatic `timezone` means "use the client's detected zone", and
`date_format: "auto"` means "use the client's locale". The API payload itself is always
UTC ISO-8601 regardless of these values — they are consumed by the client at render time.
