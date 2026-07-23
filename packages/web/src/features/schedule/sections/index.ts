/**
 * OSS section registrations for `task_detail.section` (ADR-0050).
 *
 * Imported once at app init via TaskDetailDrawer.tsx so the registry is
 * populated before the drawer first renders. Enterprise sections register
 * themselves in their own init module — OSS does not import from
 * `trueppm_enterprise`.
 *
 * Priority allocation (multiples of 100 reserved for OSS):
 *   100 Overview · 200 Dependencies · 225 Related tasks (#2068) · 300 Subtasks (#308)
 *   400 Attachments (#310) · 450 External links (#637) · 480 Notes (#740)
 *   500 Comments (issue 311) · 600 Activity (issue 307 + issue 874 history, unified issue 869) · 700 Recurring (issue 312)
 *   800 Estimates · 1000 Baseline  (900 History merged into 600 Activity, ADR-0096)
 *
 * Subtasks / Attachments / Comments / Activity / Recurring are added in
 * their own MRs as each feature ships; their absence in this index leaves
 * those slots empty until then.
 */

import { registry } from '@/lib/widget-registry';
import type { DrawerSectionContext } from '@/lib/widget-registry';
import type { Task, TaskLink } from '@/types';
import { OverviewSection } from './OverviewSection';
import { BlockerSection } from './BlockerSection';
import { SprintSection } from './SprintSection';
import { SubtasksSection } from './SubtasksSection';
import { DependenciesSection } from './DependenciesSection';
import { RelatedLinksSection } from './RelatedLinksSection';
import { AttachmentSection } from './AttachmentSection';
import { ExternalLinksSection } from './ExternalLinksSection';
import { NotesSection } from './NotesSection';
import { CommentSection } from './CommentSection';
import { ActivityTimeline } from '../ActivityTimeline';
import { RecurrenceSection } from './RecurrenceSection';
import { EstimatesSection } from './EstimatesSection';
import { BaselineSection } from './BaselineSection';

// ---------------------------------------------------------------------------
// Progressive-disclosure predicates (ADR-0605, #2315)
//
// `isPopulated(ctx)` reports whether an optional Details-tab section has content
// for the current task, WITHOUT firing that section's TanStack Query — every
// signal below is read from the task object (or the already-warm schedule cache
// threaded onto the context), so the drawer can collapse empty sections behind
// "Add detail" without the eager fetch ADR-0050's lazy-load exists to avoid.
// Only sections whose emptiness is task-derivable get a predicate; related-links
// and recurring carry no task-level signal (they need a server annotation,
// deferred follow-up) and so stay always-shown by omitting `isPopulated`.
// ---------------------------------------------------------------------------

/** Narrow the registry's `unknown` predicate context to the drawer context.
 *  Mirrors how the `canRender` predicates in this file cast inline. */
function asDrawerCtx(ctx: unknown): DrawerSectionContext {
  return ctx as DrawerSectionContext;
}

/** Read the task off the (loosely-typed) drawer-section context. */
function ctxTask(ctx: unknown): Task {
  return asDrawerCtx(ctx).task as Task;
}

/** Any three-point (PERT) duration set directly on a leaf task. */
function hasOwnPert(t: Task): boolean {
  return (
    t.optimisticDuration != null || t.mostLikelyDuration != null || t.pessimisticDuration != null
  );
}

/**
 * True when any descendant (recursive, by `parentId`) carries a PERT estimate.
 * A summary task surfaces a rolled-up PERT block, so it counts as populated when
 * a child does — mirroring EstimatesSection's own summary render gate. Reads the
 * already-loaded task list; an empty/cold list reports false (the section is
 * then revealable via "Add detail"), never a wrong fetch.
 */
function hasDescendantPert(tasks: Task[], rootId: string): boolean {
  return tasks.some(
    (c) => c.parentId === rootId && (hasOwnPert(c) || hasDescendantPert(tasks, c.id)),
  );
}

let registered = false;

/**
 * Register all OSS drawer sections. Idempotent — safe to call repeatedly
 * (the registry sorts on every register, so duplicate calls would re-add
 * the same id; the guard avoids that).
 */
export function registerOssDrawerSections(): void {
  if (registered) return;
  registered = true;

  registry.register('task_detail.section', {
    id: 'overview',
    title: 'Overview',
    component: OverviewSection,
    priority: 100,
    tab: 'details',
  });

  registry.register('task_detail.section', {
    id: 'sprint',
    title: 'Sprint',
    component: SprintSection,
    priority: 150,
    tab: 'details',
    // Sprint assignment is not meaningful for summary or milestone tasks.
    canRender: (ctx) => {
      const t = (ctx as { task: Task }).task;
      return !t.isSummary && !t.isMilestone;
    },
    // Populated once the task is assigned to a sprint (ADR-0605).
    isPopulated: (ctx) => ctxTask(ctx).sprintId != null,
  });

  registry.register('task_detail.section', {
    id: 'subtasks',
    title: 'Subtasks',
    component: SubtasksSection,
    priority: 300,
    tab: 'subtasks',
    // Milestones have no subtasks — duration is 0 and breaking them down is meaningless.
    // Phases (summary tasks with real structural children, #1750) don't get subtasks
    // either: a subtask on a phase conflates the two decomposition models. Gate on
    // hasStructuralChildren, NOT isSummary — a leaf that already has drawer-subtasks
    // is also isSummary, and must keep its tab to add more.
    canRender: (ctx) => {
      const { task, hasStructuralChildren } = ctx as DrawerSectionContext & { task: Task };
      return !task.isMilestone && !hasStructuralChildren;
    },
  });

  registry.register('task_detail.section', {
    id: 'dependencies',
    title: 'Dependencies',
    component: DependenciesSection,
    priority: 200,
    tab: 'details',
    // Populated when any dependency edge touches this task, in either direction.
    // Prefer the warm `links` cache (exact — catches outgoing-only tasks that
    // `predecessorCount`, an incoming-only count, would miss); fall back to
    // `predecessorCount` when the cache isn't threaded (ADR-0605).
    isPopulated: (ctx) => {
      const t = ctxTask(ctx);
      const links = asDrawerCtx(ctx).links as TaskLink[] | undefined;
      if (links) return links.some((l) => l.sourceId === t.id || l.targetId === t.id);
      return (t.predecessorCount ?? 0) > 0;
    },
  });

  // Related links (#2068) — relative, non-scheduling cross-references
  // (relates-to / blocks / duplicates). Sits just after Dependencies in the
  // Details tab: dependencies drive the schedule, relations only cross-reference.
  registry.register('task_detail.section', {
    id: 'related-links',
    title: 'Related tasks',
    component: RelatedLinksSection,
    priority: 225,
    tab: 'details',
  });

  registry.register('task_detail.section', {
    id: 'attachments',
    title: 'Attachments',
    component: AttachmentSection,
    priority: 400,
    tab: 'files',
  });

  registry.register('task_detail.section', {
    id: 'external-links',
    title: 'External links',
    component: ExternalLinksSection,
    priority: 450,
    tab: 'files',
  });

  // Blocker (ADR-0124) — the human "I'm stuck" flag. Sits just under the
  // Overview/Sprint header, above Dependencies. Summary tasks are rollups, not
  // hand-flagged work, so they don't get the section.
  registry.register('task_detail.section', {
    id: 'blocker',
    title: 'Blocker',
    component: BlockerSection,
    priority: 175,
    tab: 'details',
    canRender: (ctx) => !(ctx as { task: Task }).task.isSummary,
    // Populated when the task is flagged blocked. Use `blockedAgeSeconds` (the
    // team-visible "is flagged" signal), NOT `blockedReason` — the reason is
    // privacy-gated to undefined for some viewers even on a flagged task, which
    // would under-report and wrongly collapse the section (ADR-0605).
    isPopulated: (ctx) => ctxTask(ctx).blockedAgeSeconds != null,
  });

  // Notes (ADR-0143, issue 740) — the task's why/decision log. Sits above Comments
  // on the activity tab: a flat, pinned-first, immutable record distinct from
  // the threaded discussion below it.
  registry.register('task_detail.section', {
    id: 'notes',
    title: 'Notes',
    component: NotesSection,
    priority: 480,
    tab: 'activity',
  });

  registry.register('task_detail.section', {
    id: 'comments',
    title: 'Comments',
    component: CommentSection,
    priority: 500,
    tab: 'activity',
  });

  // Activity (issue 307, unified per ADR-0096 Part 2 / issue 869) — one
  // chronological timeline merging task history + comments, with field-group +
  // per-person filters. Replaces the former split Activity (issue 307) +
  // History (issue 874) sections.
  registry.register('task_detail.section', {
    id: 'activity',
    title: 'Activity',
    component: ActivityTimeline,
    priority: 600,
    tab: 'activity',
  });

  registry.register('task_detail.section', {
    id: 'recurring',
    title: 'Recurrence',
    component: RecurrenceSection,
    priority: 700,
    tab: 'details',
    // Recurrence is meaningless for summary tasks (WBS rollups) and milestones
    // (zero-duration markers) — both mirror SprintSection's gate (ADR-0090).
    canRender: (ctx) => {
      const t = (ctx as { task: Task }).task;
      return !t.isSummary && !t.isMilestone;
    },
  });

  registry.register('task_detail.section', {
    id: 'estimates',
    title: 'Estimates',
    component: EstimatesSection,
    priority: 800,
    tab: 'details',
    // Milestones have no PERT estimates — duration is always 0 and
    // the three-point fields are meaningless (ADR-0058).
    canRender: (ctx) => !(ctx as { task: Task }).task.isMilestone,
    // Populated when a leaf carries a PERT triple, or (summary) any descendant
    // does — mirroring EstimatesSection's own render gate (ADR-0605).
    isPopulated: (ctx) => {
      const t = ctxTask(ctx);
      const tasks = (asDrawerCtx(ctx).tasks ?? []) as Task[];
      return t.isSummary ? hasDescendantPert(tasks, t.id) : hasOwnPert(t);
    },
  });

  registry.register('task_detail.section', {
    id: 'baseline',
    title: 'Baseline',
    component: BaselineSection,
    priority: 1000,
    tab: 'activity',
  });
}
