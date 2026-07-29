---
title: The data model, in 90 seconds
description: The one fact that makes TruePPM's hybrid model work — a sprint story and a WBS work package are the same database row, not two systems kept in sync.
---

Every persona guide eventually explains this, so here it is once, short enough
to link to instead of re-narrating.

## The one fact

TruePPM has **one table for work items** (`Task`). A phase, a deliverable, a
sprint story, and a milestone are all rows in that same table — not separate
objects synced between a "schedule" tool and a "board" tool.

A **work package** is a task with a duration and CPM dependencies: the PM's
Gantt bars. A **story** is the same kind of row, with a `sprint` foreign key
and a `story_points` field added, and a `parent` pointing at the work package
it decomposes: the Scrum Master's board cards. Story points roll up to the
parent work package automatically, because they're the same row's children —
not a second system reporting in.

## What follows from that

- **No sync, because there's nothing to sync.** A contributor drags a card to
  Done; the row's status changes; the PM's Gantt reads the updated row on its
  next render. There is no export, no webhook, no reconciliation job between
  "the board" and "the schedule" — there's one row, and two views of it.
- **Velocity feeds the forecast directly.** When a sprint closes, the
  completed story points roll up to their parent work packages, and TruePPM
  computes a revised CPM duration suggestion from measured velocity — the PM
  reviews and applies it, non-destructively. Automatic reforecast on sprint
  close shipped in 0.3.
- **An epic is a work package too.** The epic/story hierarchy the Product
  Owner sees and the WBS the PM sees are the same tree, viewed from either
  end.

## Go deeper

- [The Story](/the-story/) — the same idea, walked through as an eight-step
  narrative across a real program
- [Unified data model](/features/unified-data-model/) — the full field-by-field
  technical reference
