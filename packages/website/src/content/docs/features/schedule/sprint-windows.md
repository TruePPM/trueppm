---
title: "Sprint windows on the schedule"
description: "How sprint windows are drawn on the Schedule, and what they tell a PM and a Scrum Master."
documentedFor: "0.4"
---

## Sprint windows

:::note[Ships in 0.4]
Sprint window bands and the cadence rail ship in 0.4. On the current release the Schedule draws neither; a sprint's dates are visible only on the [Sprints](/features/sprints/) workspace.
:::

A hybrid program is **one plan**, so its sprint cadence is drawn on the same timeline as its gated bars — not on a second view, and not behind a toggle that swaps one for the other. Sprints reach the Schedule two ways, and the pair is deliberate:

- the **cadence rail** — a strip of named sprint windows across the top of the chart, under the date ruler, which answers *when is each sprint*;
- the **sprint window bands** — tinted, hatched regions over the rows a sprint drives, which answer *which work is in it*.

The point is what you can see in one glance: the gated critical path, the sprint cadence, and the dependencies crossing between them. A predecessor in a gated phase drives a story inside a sprint window exactly as it drives anything else — **the band is paint, not a container**. It changes no dates, no dependency routing, and no bar. Nothing forks.

### The cadence rail

The rail sits directly below the month/week ruler and names every sprint window on the time axis: **S1**, **S2**, **Sprint 4**, whatever you called them. Each window starts at a thin vertical rule on its start date and runs to the end of its finish day. There is no rule on the right-hand side — the next window's opening rule *is* the boundary, so adjacent sprints read as a continuous cadence rather than as boxes with gaps between them. Where no sprint covers a stretch of the axis, the rail is simply empty there; the space between two sprints is not a nameless sprint.

The **active** sprint is filled; planned and completed ones are outlined. Cancelled sprints draw nothing, in the rail and in the bands alike.

Three things the rail can do that a band cannot, and they are why it exists:

- **An empty sprint still appears.** A sprint nobody has committed work to drives no rows, so it has no band — but it is a real planning fact, and on the rail you can see it sitting there waiting.
- **One sprint, one name.** Bands break at every gap in the WBS, so a sprint whose work is scattered draws several bands. The rail is addressed by date, so it names each sprint exactly once.
- **The name survives scrolling.** A band's name used to be anchored to the band's first row and vanished the moment you scrolled past it. The rail is fixed under the ruler, so scrolling down a long plan never leaves you looking at an unnamed window.

The rail is one row high and never stacks. If two sprint windows overlap — usually a sign something needs fixing — the overlapping stretch reads **2 sprints** rather than picking one of them, because naming one would assert that the other does not cover those days.

At a wide zoom a window can get too narrow to hold its name. Below about 24 pixels the label is dropped entirely rather than shown as a bare `…`, which names nothing; the window's opening rule still marks the boundary. Pan into the middle of a sprint wider than your screen and the name slides along to stay visible instead of scrolling off with the window's start.

On a project with no drawable sprint window, the rail takes up no space at all — the chart's geometry is identical to a pure waterfall plan's.

The rail is painted on a canvas, which assistive technology cannot read, so every sprint window also reaches a screen reader in text. For a sprint that drives rows, each of those bars already names its window and dates. For a sprint with **no committed work** there is no bar to carry it — the very case the rail exists for — so the chart's own description names those windows instead: *"One sprint window has no committed work on this schedule: Sprint 5 (May 4 – May 15)."*

Only the empty ones are named there. A sprint that drives rows is already announced on each of its bars, and repeating it would read the same sprint twice. And the sentence rides the chart's existing description rather than adding a focusable stop per window — N sprint stops ahead of every task row would be a worse tab order than the problem it solved. "Empty" means empty *on this screen*: if a filter or a collapsed phase hides a sprint's only rows, the rail shows an uncovered window and the description agrees with it.

### Which rows a band covers

A band covers a **contiguous run of rows** that all resolve to the same sprint. If a sprint's work sits in two places in the WBS with other work between them, you get two bands — never one tall band claiming the rows in between, which are in no sprint at all.

Rows resolve exactly the way the [delivery-mode chip](/features/task-classification/) does, so the band and the chip can never disagree about what a subtree is:

- A **phase reads from its descendants**, not from its own sprint field. A phase whose branches sit in different sprints gets no band of its own; its children get theirs. A phase can never carry a sprint window of its own for a stronger reason than that, too: starting in 0.4, assigning a phase to a sprint will be refused outright, not just discouraged — see [Phases and sprints](/features/summary-tasks/#phases-and-sprints).
- **Milestones contribute nothing.** A gate inside a sprint-driven phase is a gate, not evidence the phase spans two sprints — so a gate never splits a band.
- A row carrying no sprint of its own — that gate, or a task nobody has pulled in yet — **inherits the band around it**, so a sprint-driven phase reads as one region instead of one with holes in it.

**Cancelled** sprints draw nothing. **Planned**, **active** and **completed** sprints all draw: past cadence explains the shape of the plan behind the today line as much as the live sprint explains the shape ahead of it.

### Reading the band

The band uses the same visual vocabulary as the delivery-mode marks it sits behind — the same violet as the cadence rail, the same diagonal hatch as a scrum bar, at a lower density because it covers a region rather than an 18px bar. Its two **dashed** vertical rules *are* the window: work that runs past them is work that runs past the sprint. The **Sprint window** entry in the schedule legend explains the mark, alongside **Scrum**, **Kanban** and **Mixed subtree** — one legend for the whole hybrid vocabulary.

The band never relies on color alone: hue, hatch, the dashed edges and the named window on the rail above each carry the fact, so it survives a color-vision deficiency and a monochrome print. In Windows High Contrast the tint drops away entirely — a solid region would erase the grid and row separators it sits over — and the window survives as its two dashed rules and a gray hatch, which is also why they are dashed rather than solid: there, a solid rule would be indistinguishable from the today line.

Screen readers get the fact as text, and they get the *window*, not just the membership: a task inside one announces `…, in Sprint 4 (Apr 20 – May 1)`, and a task whose finish runs past the window adds `, finishes after the sprint window` — the thing a sighted user reads off the band's right-hand rule. Hovering a row surfaces the full sprint name even when the rail had to truncate it.

One gap worth stating plainly: the rail is a canvas drawing, and its windows reach a screen reader through the *rows* they cover. A sprint with no committed work therefore appears on the rail but has no row to announce it — until you commit something to it, read that sprint's dates on the [Sprints](/features/sprints/) workspace.

Bands survive zoom and pan — the window is re-derived from the live timescale on every repaint, so it narrows correctly from Month to Quarter rather than holding a stale width. They fade in briefly when they first appear; under `prefers-reduced-motion` they simply appear, with no animation scheduled at all.

### Turning them off

**Display → Chart → Sprint windows** hides both the bands and the cadence rail — they are two readings of one fact, so one control governs both. This is a presentation toggle, not a view switch: hiding the window changes nothing else — the same rows, the same bars, the same links. The choice persists per browser, and the Display badge counts it so you are never left wondering where the band went. On a project with no sprint window to draw the option is not offered at all, and it never lights the badge.
