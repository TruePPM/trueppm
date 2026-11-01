---
title: Program Decision Log
description: Track the calls a program is waiting on — each with an owner, a due date, and the owner's own impact estimate — until they are made.
documentedFor: "0.5"
---

:::note[Ships in 0.5]
The program decision log ships in **0.5**. The current release has no program-level
decision log; the closest thing is the project [Decisions](/features/decisions/) view,
which collects decision-flagged task notes. In the 0.5 preview, the **Decisions** tab
is reached from **More** in the redesigned shell (`?ff=shell_v2`), or directly at
`/programs/<key>/decisions` in either shell.
:::

A program waits on decisions: a vendor go/no-go, a scope cut, a release date. The
**program decision log** keeps each of those calls in one place, with the person who
owns it, when it is due, and what the owner expects it to change, until somebody
makes the call.

## How it differs from project Decisions

The project [Decisions](/features/decisions/) view is a record of what a team **already
decided**, written as notes on tasks. The program decision log tracks a call **before it
is made**: it has an owner, a due date, and an open state. A decision can be logged
here and later explained in a task note. The two features are separate and neither
one feeds the other.

## The log

Open a program, then **More → Decisions**. The page has two lists:

- **Awaiting**: decisions that are still open, soonest due first. Undated decisions
  come last. A decision past its due date reads **Overdue**.
- **Made**: decisions that have been made, most recent first, each with the date it
  was decided.

A decision that is **withdrawn** leaves both lists. The record is kept, and nobody
has to pretend the call was made.

A program with no decisions shows **No decisions logged**.

## Logging a decision

Choose **Log a decision** and fill in:

| Field | Notes |
|-------|-------|
| **Decision** | Required. The call being waited on, e.g. "Go or no-go on the vendor cutover". |
| **Owner** | Optional. Any member of the program. |
| **Due date** | Optional. |
| **Owner's impact estimate** | Optional free text, e.g. "recovers 2 days · P80 back to Dec 5". |

On an awaiting decision, **Mark made** moves it to Made and records the date.
**Withdraw** removes it from the log. On a made decision, **Reopen** moves it back to
Awaiting. A made decision cannot be withdrawn directly: reopen it first.

### The impact estimate is the owner's, not the engine's

TruePPM does not compute the impact estimate. It is text the owner typed, and it is
always shown under the label **Owner's estimate · as of** the date the decision was
last changed. It is never styled like a forecast figure. Editing any field of the
decision moves that date. Impact computed from a linked task or risk against the live
P80 is planned as a separate feature.

## Who can do what

The log follows the program's [roles](/features/programs/):

| Action | Role |
|--------|------|
| Read the log | Viewer and up |
| Log, edit, mark made, withdraw, reopen | Team Member and up |
| Delete a decision | Program Manager and up |

A closed program's log is read-only. Deleting is held one tier above editing because
the log is a record. To take a decision off the log, withdraw it.

## Linking a task or risk

Through the API, a decision can link to **one** task or **one** risk. The linked item
must belong to a project in the same program, and you must be a member of that
project to set the link. A program member who is not in the linked project still
sees that a task or risk is linked, but not its name.

## API

```
GET    /api/v1/programs/{program_id}/decisions/?status=awaiting|made|withdrawn
POST   /api/v1/programs/{program_id}/decisions/
GET    /api/v1/programs/{program_id}/decisions/{id}/
PATCH  /api/v1/programs/{program_id}/decisions/{id}/
DELETE /api/v1/programs/{program_id}/decisions/{id}/
```

`decided_at` is set by the server when `status` becomes `made` and cleared on reopen.
It cannot be written directly. The full schema is in the
[API reference](/api/reference/).
