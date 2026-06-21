/**
 * Pure board → print-model transform for the PDF export (ADR-0159, issue 326).
 *
 * Kept free of React so the mapping (which cards land in which lane/column, the
 * footer context string, assignee-initials fallback) is unit-testable in
 * isolation. `BoardPrintLayout` renders the result; `exportBoardPdf` rasterizes
 * the rendered node. The transform consumes the *already-filtered* card set the
 * live board renders from, so the export honors the current saved view, sprint
 * scope, and quiet-toggle filters without re-deriving any of that logic.
 */
import type { Task, TaskStatus } from '@/types';

export interface BoardPrintCard {
  id: string;
  shortId: string | null;
  name: string;
  status: TaskStatus;
  /** First assignee's display name, or null when unassigned. */
  assignee: string | null;
  /** Up-to-two-letter initials for the assignee, or null. Avatars are never
   *  rasterized — cross-origin images can silently drop from html-to-image. */
  assigneeInitials: string | null;
  /** ISO finish date, or null. The layout formats it. */
  due: string | null;
  storyPoints: number | null;
  isCritical: boolean;
  isBlocked: boolean;
  isMilestone: boolean;
}

export interface BoardPrintColumn {
  status: TaskStatus;
  label: string;
}

export interface BoardPrintLane {
  id: string;
  name: string;
  /** Cards in this lane, in board order, across all columns. The layout buckets
   *  them per column by `status`. */
  cards: BoardPrintCard[];
}

export interface BoardPrintFooter {
  generatedAtLabel: string;
  userName: string | null;
  /** Human description of the active filter / saved-view context. */
  contextLabel: string;
}

export interface BoardPrintData {
  projectName: string;
  sprintName: string | null;
  columns: BoardPrintColumn[];
  lanes: BoardPrintLane[];
  footer: BoardPrintFooter;
}

export interface BoardPrintFilters {
  myTasks: boolean;
  atRisk: boolean;
  techDebt: boolean;
  showCost: boolean;
  searchQuery: string;
  savedViewName: string | null;
}

/** Two-letter initials from a display name ("Ada Lovelace" → "AL", "Cher" → "CH"). */
export function initialsOf(name: string): string | null {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function toPrintCard(task: Task): BoardPrintCard {
  const assignee = task.assignees[0]?.name ?? null;
  return {
    id: task.id,
    shortId: task.shortId ?? null,
    name: task.name,
    status: task.status,
    assignee,
    assigneeInitials: assignee ? initialsOf(assignee) : null,
    due: task.finish || null,
    storyPoints: task.storyPoints ?? null,
    isCritical: task.isCritical,
    isBlocked: Boolean(task.isBlocked),
    isMilestone: task.isMilestone,
  };
}

/** Compose the footer's filter-context line from the active board controls. */
export function buildContextLabel(filters: BoardPrintFilters): string {
  const parts: string[] = [];
  if (filters.savedViewName) parts.push(`View: ${filters.savedViewName}`);
  if (filters.myTasks) parts.push('My tasks');
  if (filters.atRisk) parts.push('At-risk');
  if (filters.techDebt) parts.push('Tech debt');
  if (filters.searchQuery.trim()) parts.push(`Search: "${filters.searchQuery.trim()}"`);
  return parts.length > 0 ? `Filtered — ${parts.join(' · ')}` : 'All cards';
}

export interface BuildBoardPrintArgs {
  projectName: string;
  sprintName: string | null;
  columns: BoardPrintColumn[];
  lanes: { id: string; name: string; tasks: Task[] }[];
  userName: string | null;
  /** Pre-formatted "generated at" label (caller stamps the wall clock). */
  generatedAtLabel: string;
  filters: BoardPrintFilters;
}

/**
 * Project the live board state into the immutable print model. Lanes whose cards
 * are entirely absent from the visible columns still render (empty swimlane), so
 * the artifact mirrors the on-screen structure rather than silently dropping
 * lanes — the footer's count, not a missing row, communicates emptiness.
 */
export function buildBoardPrintData(args: BuildBoardPrintArgs): BoardPrintData {
  const visibleStatuses = new Set(args.columns.map((c) => c.status));
  return {
    projectName: args.projectName,
    sprintName: args.sprintName,
    columns: args.columns,
    lanes: args.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      cards: lane.tasks.filter((t) => visibleStatuses.has(t.status)).map(toPrintCard),
    })),
    footer: {
      generatedAtLabel: args.generatedAtLabel,
      userName: args.userName,
      contextLabel: buildContextLabel(args.filters),
    },
  };
}
