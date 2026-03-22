---
id: gantt
title: Gantt View
sidebar_position: 5
---

The Gantt view is the primary scheduling interface in TruePPM. It is a split-pane layout: a task list on the left and a timeline on the right, synchronized by scroll.

Navigate to `http://localhost:5173/gantt` to open it.

:::note Early stage
The Gantt view currently renders fixture data. Live API wiring (real projects, tasks, and dependencies) is planned for a subsequent milestone.
:::

## Layout

```
┌──────────────────────────────────┬───────────────────────────────────────┐
│  Task list (280px)               │  SVAR Gantt timeline (flex)           │
│                                  │                                       │
│  WBS  Name           Dur  Start  │  Apr       May       Jun              │
│  ─────────────────────────────── │  ──────────────────────────────────── │
│  1    Project A      —           │  ████████████ (summary)               │
│  1.1  Design         5d  Apr 1   │    ████ (critical)                    │
│  1.2  Build         10d  Apr 8   │         ██████████ (normal)           │
│  1.3  Test           3d  Apr 22  │  ◆ (milestone)                        │
└──────────────────────────────────┴───────────────────────────────────────┘
```

The task list is virtualized (`@tanstack/react-virtual`, fixed 28px row height) and supports arbitrarily large task counts without DOM performance degradation. WBS indentation is derived from the dot-separated WBS string.

## Bar types

| Bar type | Color | Meaning |
|----------|-------|---------|
| Normal | Blue 400 | Standard task, not on the critical path |
| Critical | Red 400 | Task is on the critical path (total float = 0) |
| Complete | Green 400 | Task marked as 100% complete |
| Summary | Blue 400, 8px tall | WBS parent / summary row |
| Milestone | Diamond, 12px | Zero-duration event |
| Baseline ghost | Gray, 6px | Original planned dates (shown below the live bar) |

Bar labels always use `#1A1917` (dark text) regardless of bar color. All 400-stop Tailwind colors fail WCAG 4.5:1 contrast with white at Gantt label font sizes (10–11px).

## Dependency types

All four standard dependency types are rendered as arrows on the timeline:

| Type | Name | Meaning |
|------|------|---------|
| FS | Finish-to-Start | Successor starts after predecessor finishes |
| SS | Start-to-Start | Successor starts after predecessor starts |
| FF | Finish-to-Finish | Successor finishes after predecessor finishes |
| SF | Start-to-Finish | Successor finishes after predecessor starts |

Critical dependencies (on the critical path) render in Red 400 to match critical bars.

## Zoom levels

The toolbar exposes four zoom levels:

| Level | Scale |
|-------|-------|
| Day | Individual days |
| Week | Week columns |
| Month | Month columns (default) |
| Quarter | Quarter columns |

## Scroll sync

Scrolling the task list vertically scrolls the timeline to match, and vice versa. A `isSyncing` ref guard prevents infinite scroll feedback loops. Sync is implemented via the SVAR `IApi` interface:

- Task list → timeline: `api.exec('scroll-chart', { top })`
- Timeline → task list: `api.on('scroll-chart', ({ top }) => ...)`

## Adapter layer

TruePPM types are mapped to SVAR's internal shapes by two pure adapter functions:

- `toSvarTasks(tasks: Task[]): ITask[]` — maps `isMilestone`, `isSummary`, `isCritical`, `isComplete`, baseline fields, and WBS
- `toSvarLinks(links: TaskLink[]): ILink[]` — maps `FS/SS/FF/SF` to SVAR's `e2s/s2s/e2e/s2e` type codes

These functions are pure (no side effects) and are unit-tested independently of the component tree.

## Read-only mode

The Gantt is rendered with `readonly={true}`. Drag-to-reschedule will be enabled in a subsequent milestone once WASM-based CPM recalculation is available on the client (issue #19).

## Source

| Path | Purpose |
|------|---------|
| `src/features/gantt/GanttView.tsx` | Route entry component |
| `src/features/gantt/GanttTimeline.tsx` | SVAR `<Gantt>` wrapper, zoom config |
| `src/features/gantt/TaskListPanel.tsx` | Virtualized task list |
| `src/features/gantt/adapters/toSvarTasks.ts` | Task adapter |
| `src/features/gantt/adapters/toSvarLinks.ts` | Link adapter |
| `src/features/gantt/gantt.css` | Scoped bar color overrides |
| `src/features/gantt/ganttConstants.ts` | Column widths, row height |
| `src/hooks/useScrollSync.ts` | Two-way scroll sync hook |
| `src/hooks/useGanttTasks.ts` | Stub hook (fixture data) |
| `src/stores/ganttStore.ts` | Zoom level + selected task state |
