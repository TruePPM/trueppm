---
title: Subtasks
description: Checklist-style task decomposition that rolls up into the parent task's progress without entering the CPM schedule.
---

Subtasks are a checklist-style decomposition of a single task. They live inside a task's detail drawer, carry their own assignee and status, and roll up into the parent task's progress — but they are **not** independently scheduled. The CPM engine treats the parent task as the scheduling unit; subtasks are the implementer's internal breakdown of how to complete it.

## Why subtasks exist alongside child tasks under a phase

TruePPM has two ways to break work down:

| Mechanism | Created via | CPM participation | Use when |
|---|---|---|---|
| **Child tasks under a phase** | Schedule-view indent (Tab key / context menu) | Yes — each task gets its own duration, float, dependencies, resource assignments | The sub-items need to be sequenced, separately resourced, or tracked on the Schedule view |
| **Subtasks** | Task detail drawer | No — the parent task is the CPM node | The sub-items are the assignee's to-do list for a single deliverable |

The practical test: _if any of the sub-items could end up on the critical path, or if a PM needs to see them on the Schedule view, make them child tasks under a phase._ If they're internal steps that only the task owner cares about, use subtasks.

### Example

A task called **"Write requirements document"** might have subtasks:

- Draft stakeholder interview questions
- Conduct interviews
- Write first draft
- Circulate for review
- Incorporate feedback

None of these need their own Schedule-view bar. The PM cares only that "Write requirements document" finishes by Friday. The subtasks are the author's own workflow for getting there.

If, on the other hand, the work is **"Design → Build → Test"**, those belong as three separate tasks under a phase — they have distinct durations, different assignees, and a Finish-to-Start dependency chain the scheduler needs to know about.

## How subtasks work

### Depth limit

Subtasks are one level deep. A subtask cannot have its own subtasks. This keeps the data model and the UI predictable — there is no unlimited nesting that gradually becomes an unmaintainable tree.

### Progress rollup

The parent task's % complete is the weighted average of its subtasks' progress. Completing all subtasks brings the parent to 100%. If the parent has no subtasks, progress is set directly on the parent as normal.

### Independent assignment

Each subtask has its own assignee. Subtasks assigned to you appear in **My Tasks** with a label showing the parent task name so you always have context.

### Sprint scope tracking

If a subtask is added to a task that belongs to an active sprint, TruePPM records a scope-change event on the sprint. Sprint leads can see what subtasks were added mid-sprint and by whom, supporting the kind of transparency a Scrum team needs for retrospectives and velocity accuracy.

### Board visibility

Subtasks appear in board columns by default (they have status and assignee). Use the **Hide subtasks** toggle in the board filter bar to declutter the board view if your team prefers to work at the task level only.

### Schedule-view visibility

Subtasks are hidden from the Schedule view by default. The parent task renders as a summary bar with a subtask count badge. Expanding the parent inlines the subtask bars as indented leaf rows beneath it.

## When to use which

| Situation | Recommendation |
|---|---|
| Breaking a sprint story into developer to-dos | Subtasks |
| Decomposing a deliverable into steps only the assignee tracks | Subtasks |
| Work that has separate owners, durations, or deadlines | Child tasks under a phase |
| Items that must be sequenced with Finish-to-Start dependencies | Child tasks under a phase |
| Items a PM wants visible on the Schedule view | Child tasks under a phase |
| A QA checklist inside a "QA" task | Subtasks |
| Separate "Design", "Build", "Test" workstreams | Child tasks under a phase |
