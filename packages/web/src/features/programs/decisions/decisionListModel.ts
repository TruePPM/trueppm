/**
 * Pure display model for the program decision log (ADR-1310, #4772).
 *
 * The one rule this file exists to hold: `impact_note` is the OWNER'S ESTIMATE,
 * free text the server stores and never computes. It is always rendered with its
 * provenance ("Owner's estimate · as of <date>") and never as a forecast figure —
 * a decision row that read "recovers 2 days" in the type the P80 uses would be
 * asserting the engine said so. A computed impact is a separate, future fact.
 */

export type ProgramDecisionStatus = 'awaiting' | 'made' | 'withdrawn';

interface ProgramDecisionLink {
  id: string;
  kind: 'task' | 'risk';
  /** `null` when the reader is not a member of the linked item's project. */
  short_id: string | null;
  /** `null` when the reader is not a member of the linked item's project. */
  title: string | null;
  project_id: string;
}

/** `GET /api/v1/programs/{id}/decisions/` row. */
export interface ProgramDecision {
  id: string;
  server_version: number;
  program: string;
  title: string;
  owner: number | null;
  owner_detail: { id: number; username: string; display_name: string } | null;
  /** Calendar date, `YYYY-MM-DD`. */
  due_date: string | null;
  status: ProgramDecisionStatus;
  /** Server-stamped on the move to `made`; cleared on reopen. */
  decided_at: string | null;
  linked_task: string | null;
  linked_risk: string | null;
  link: ProgramDecisionLink | null;
  impact_note: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

type FormatDate = (iso: string) => string;

/** The owner's name, or an explicit "No owner" — never a blank slot. */
export function ownerName(decision: ProgramDecision): string {
  return decision.owner_detail?.display_name ?? 'No owner';
}

/**
 * Due-date phrase for an awaiting decision. `todayIso` is the viewer's local
 * calendar date (`localTodayIso()`), compared as strings because both sides are
 * `YYYY-MM-DD` — no Date parsing, so no timezone can move the day.
 */
export function dueLabel(
  decision: ProgramDecision,
  todayIso: string,
  formatDate: FormatDate,
): { text: string; overdue: boolean } | null {
  const due = decision.due_date;
  if (!due || decision.status !== 'awaiting') return null;
  if (due === todayIso) return { text: 'Due today', overdue: false };
  if (due < todayIso) return { text: `Overdue · due ${formatDate(due)}`, overdue: true };
  return { text: `Due ${formatDate(due)}`, overdue: false };
}

/**
 * The provenance line under an impact note, or `null` when there is no note.
 * Dated by `updated_at` (the issue's contract): it is when the row last changed,
 * which is the latest moment the owner's estimate is known to have stood.
 */
export function impactProvenance(
  decision: ProgramDecision,
  formatInstantDate: FormatDate,
): string | null {
  if (!decision.impact_note.trim()) return null;
  return `Owner's estimate · as of ${formatInstantDate(decision.updated_at)}`;
}

/** "Decided Oct 30" for a made decision; `null` otherwise. */
export function decidedLabel(
  decision: ProgramDecision,
  formatInstantDate: FormatDate,
): string | null {
  if (decision.status !== 'made' || !decision.decided_at) return null;
  return `Decided ${formatInstantDate(decision.decided_at)}`;
}

/**
 * What the linked task or risk reads as. A link the viewer cannot read is still
 * disclosed — hiding it would misstate the decision — but by kind only.
 */
export function linkLabel(decision: ProgramDecision): string | null {
  const link = decision.link;
  if (!link) return null;
  const noun = link.kind === 'task' ? 'Task' : 'Risk';
  if (link.title === null) return `${noun} in a project you're not a member of`;
  return link.short_id ? `${noun} ${link.short_id} · ${link.title}` : `${noun} · ${link.title}`;
}
