---
title: Workshop Mode
description: A live, collaborative board-planning surface — turn the board into a shared canvas for sprint planning, story mapping, and backlog refinement with the whole team present.
---

**Workshop mode** turns a project board into a live, shared planning canvas. Instead of
one person dragging cards while everyone watches over a screen-share, the team starts a
workshop session and edits the board together — adding phases, renaming them, and
reordering work — with everyone's presence shown in real time.

:::note[Edition]
Workshop mode is part of the **Community (OSS)** edition. It builds on the standard
board and the real-time WebSocket layer.
:::

## Starting and ending a session

A project **Admin** starts a workshop from the board toolbar (the *Start workshop
session* toggle). Only one workshop can be active per project at a time. While a session
is active, the board shows:

- A **sticky banner** with an elapsed-time counter and the avatars of everyone present.
- **Inline-editable phase names** — click a phase header to rename it.
- **Drag-to-reorder phases** so the team can restructure the plan together.
- An **+ Add phase** control, and a phase canvas in place of the usual empty state when
  the board has no phases yet.

Ending the session returns the board to its normal view. The session can be ended by the
**Admin who started it** (or any project Admin); an exit confirmation guards against
ending it by accident. If a facilitator's client crashes mid-session, any Admin can
**force-end** the orphaned session to unblock the board.

## Who can do what

| Action | Required role |
|--------|---------------|
| Start a workshop | Admin |
| Rename / reorder phases during a workshop | Admin |
| Add tasks during a workshop | Member or above |
| End the workshop | Admin, or the user who started it |
| Force-end an orphaned session | Admin |

## How presence works

When you have the board open during an active workshop, the client subscribes to a
per-project workshop WebSocket channel. Joining and leaving update your presence in the
banner, and each participant is assigned a stable color for their avatar. Reconnecting to
the same session (for example after a brief network drop) rejoins you rather than
creating a duplicate presence.

## API

Workshop sessions are managed through the project API:

| Method & path | Purpose | Permission |
|---|---|---|
| `POST /api/v1/projects/{id}/workshop/start/` | Start a session (`409` if one is already active) | Admin |
| `POST /api/v1/projects/{id}/workshop/end/` | End the active session | Admin or session owner |
| `POST /api/v1/projects/{id}/workshop/force-end/` | Force-end an orphaned session | Admin |
| `GET /api/v1/projects/{id}/workshop/current/` | Fetch the active session and its participants | Member |

Session start and end broadcast `workshop_started` / `workshop_ended` events to all
connected board clients, deferred to transaction commit so the board only reacts once the
change is durable.
