/**
 * OSS section registrations for `task_detail.section` (ADR-0050).
 *
 * Imported once at app init via TaskDetailDrawer.tsx so the registry is
 * populated before the drawer first renders. Enterprise sections register
 * themselves in their own init module — OSS does not import from
 * `trueppm_enterprise`.
 *
 * Priority allocation (multiples of 100 reserved for OSS):
 *   100 Overview · 200 Dependencies · 300 Subtasks (#308)
 *   400 Attachments (#310) · 450 External links (#637) · 500 Comments (#311)
 *   600 Activity (#307) · 700 Recurring (#312) · 800 Estimates · 900 History
 *   1000 Baseline
 *
 * Subtasks / Attachments / Comments / Activity / Recurring are added in
 * their own MRs as each feature ships; their absence in this index leaves
 * those slots empty until then.
 */

import { registry } from '@/lib/widget-registry';
import type { Task } from '@/types';
import { OverviewSection } from './OverviewSection';
import { SprintSection } from './SprintSection';
import { SubtasksSection } from './SubtasksSection';
import { DependenciesSection } from './DependenciesSection';
import { AttachmentSection } from './AttachmentSection';
import { ExternalLinksSection } from './ExternalLinksSection';
import { CommentSection } from './CommentSection';
import { ActivitySection } from './ActivitySection';
import { RecurrenceSection } from './RecurrenceSection';
import { EstimatesSection } from './EstimatesSection';
import { HistorySection } from './HistorySection';
import { BaselineSection } from './BaselineSection';

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
  });

  registry.register('task_detail.section', {
    id: 'sprint',
    title: 'Sprint',
    component: SprintSection,
    priority: 150,
    // Sprint assignment is not meaningful for summary or milestone tasks.
    canRender: (ctx) => {
      const t = (ctx as { task: Task }).task;
      return !t.isSummary && !t.isMilestone;
    },
  });

  registry.register('task_detail.section', {
    id: 'subtasks',
    title: 'Subtasks',
    component: SubtasksSection,
    priority: 300,
    // Milestones have no subtasks — duration is 0 and breaking them down is meaningless.
    canRender: (ctx) => !(ctx as { task: Task }).task.isMilestone,
  });

  registry.register('task_detail.section', {
    id: 'dependencies',
    title: 'Dependencies',
    component: DependenciesSection,
    priority: 200,
  });

  registry.register('task_detail.section', {
    id: 'attachments',
    title: 'Attachments',
    component: AttachmentSection,
    priority: 400,
  });

  registry.register('task_detail.section', {
    id: 'external-links',
    title: 'External links',
    component: ExternalLinksSection,
    priority: 450,
  });

  registry.register('task_detail.section', {
    id: 'comments',
    title: 'Comments',
    component: CommentSection,
    priority: 500,
  });

  registry.register('task_detail.section', {
    id: 'activity',
    title: 'Activity',
    component: ActivitySection,
    priority: 600,
  });

  registry.register('task_detail.section', {
    id: 'recurring',
    title: 'Recurrence',
    component: RecurrenceSection,
    priority: 700,
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
    // Milestones have no PERT estimates — duration is always 0 and
    // the three-point fields are meaningless (ADR-0058).
    canRender: (ctx) => !((ctx as { task: Task }).task.isMilestone),
  });

  registry.register('task_detail.section', {
    id: 'history',
    title: 'History',
    component: HistorySection,
    priority: 900,
  });

  registry.register('task_detail.section', {
    id: 'baseline',
    title: 'Baseline',
    component: BaselineSection,
    priority: 1000,
  });
}
