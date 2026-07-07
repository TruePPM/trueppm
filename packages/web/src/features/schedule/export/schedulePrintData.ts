/**
 * Pure schedule → print-model transform for the PDF export (ADR-0188, issue 1436).
 *
 * Mirrors `boardPrintData.ts`: kept entirely free of React so WBS row ordering,
 * the 3-level indent cap, critical-path chain ordering, KPI-cell derivation, and
 * link hard/soft classification are unit-testable in isolation
 * (`schedulePrintData.test.ts`). `SchedulePrintLayout` renders the result;
 * `exportSchedulePdf` rasterizes the rendered node.
 *
 * All inputs are already in memory on the live Schedule view — the schedule
 * `Task[]`, the `TaskLink[]`, and the existing forecast/Monte-Carlo result. The
 * transform performs NO new compute and reads NO new endpoint (ADR-0188:
 * "no API/migration/permission surface").
 */
import type { Task, TaskLink, LinkType, MonteCarloResult } from '@/types';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { initialsOf } from '@/lib/initials';

const MS_PER_DAY = 86_400_000;

/** Bar coloring band for a print row — drives the risk-derived bar fill. */
export type SchedulePrintRiskBand = 'on-track' | 'at-risk' | 'critical';

/** What a print row depicts. */
export type SchedulePrintRowKind = 'phase' | 'task' | 'milestone';

export interface SchedulePrintRow {
  id: string;
  /** Full dotted WBS path. The stable join key — never clipped, even when the
   *  visual indent is capped. */
  wbsCode: string;
  /** True 1-based WBS depth (`'1.2.3'` → 3). */
  depth: number;
  /** Visual indent level, capped at {@link MAX_INDENT_LEVELS} (issue 1440). */
  indentLevel: number;
  kind: SchedulePrintRowKind;
  name: string;
  owner: string | null;
  ownerInitials: string | null;
  /** ISO start date, or null. The layout formats it. */
  start: string | null;
  /** ISO finish date (inclusive), or null. */
  finish: string | null;
  /** 0–100. */
  pctComplete: number;
  isCritical: boolean;
  /**
   * True when the task is behind schedule (negative float, a 'behind'/'at_risk' SPI
   * band, or a positive schedule variance) — the same signal that drives an at-risk
   * band, but kept as its own flag because a CRITICAL task's `riskBand` is 'critical'
   * (precedence), which would otherwise hide that it is also slipping. The print
   * surface textures a behind bar with a diagonal hatch on top of ANY border color,
   * so a critical-and-slipping bar reads as "red frame + hatch" (ADR-0277).
   */
  isBehind: boolean;
  /** Total float in working days from CPM; null until CPM runs. */
  totalFloat: number | null;
  riskBand: SchedulePrintRiskBand;
  isMilestone: boolean;
  /** Met/pending for milestone rows; null for non-milestones. */
  milestoneMet: boolean | null;
}

export interface SchedulePrintLink {
  id: string;
  fromId: string;
  toId: string;
  type: LinkType;
  /** Hard (mandatory FS spine) vs soft (discretionary) — see {@link classifyLinkHardness}. */
  hard: boolean;
}

/** One KPI strip cell (Layout A) / register row (Layout B). */
export interface SchedulePrintKpi {
  label: string;
  value: string;
  sub: string | null;
}

export interface SchedulePrintKpis {
  window: SchedulePrintKpi;
  criticalPath: SchedulePrintKpi;
  forecastP80: SchedulePrintKpi;
  progress: SchedulePrintKpi;
  milestones: SchedulePrintKpi;
}

/** One task in the ordered critical-path driving chain (CP summary box). */
export interface SchedulePrintCpTask {
  id: string;
  /** 1-based position in the driving chain. */
  seq: number;
  wbsCode: string;
  name: string;
  start: string | null;
  finish: string | null;
  totalFloat: number | null;
}

export interface SchedulePrintMasthead {
  projectName: string;
  methodSubtitle: string;
  orgName: string | null;
  baselineLabel: string | null;
  exportDateLabel: string;
  projectKey: string | null;
  workspaceUrl: string | null;
}

export interface SchedulePrintFooter {
  generatedAtLabel: string;
  userName: string | null;
  signOff: string;
  /** Content hash for the sign-off line; issue 1437 fills it, foundation passes through. */
  contentSha: string | null;
}

export interface SchedulePrintData {
  rows: SchedulePrintRow[];
  links: SchedulePrintLink[];
  kpis: SchedulePrintKpis;
  cpChain: SchedulePrintCpTask[];
  masthead: SchedulePrintMasthead;
  footer: SchedulePrintFooter;
}

/** Visual indent levels before the WBS indent flattens (full path is retained). */
export const MAX_INDENT_LEVELS = 3;

/** Base left padding (px) of a label row, and the per-level indent step. */
export const LABEL_INDENT_BASE_PX = 8;
export const LABEL_INDENT_STEP_PX = 12;

/**
 * Left padding (px) for a print label at a given indent level. Re-clamps to
 * {@link MAX_INDENT_LEVELS} so a deep WBS (`'1.2.3.4.5'`) stops indenting at
 * level 3 even if an uncapped level slips through — the full dotted code is still
 * shown, it just stops walking right so the name keeps its width (issue 1440).
 */
export function labelIndentPx(indentLevel: number): number {
  const lvl = Math.min(Math.max(indentLevel, 1), MAX_INDENT_LEVELS);
  return LABEL_INDENT_BASE_PX + (lvl - 1) * LABEL_INDENT_STEP_PX;
}

/** WBS depth from the dotted path (`'1.2.3'` → 3, `''` → 0). */
function wbsDepth(wbs: string): number {
  if (!wbs) return 0;
  return wbs.split('.').length;
}

/**
 * Compare two dotted WBS paths numerically, segment by segment, so `'1.10'`
 * sorts after `'1.2'` (a lexical sort would invert them). Shorter prefixes sort
 * first (`'1'` before `'1.1'`).
 */
export function compareWbs(a: string, b: string): number {
  const pa = a ? a.split('.') : [];
  const pb = b ? b.split('.') : [];
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Classify a dependency link as hard (mandatory) or soft (discretionary).
 *
 * Hard = a strict Finish-to-Start link with no positive lag — the mandatory CPM
 * spine that the artifact draws as a solid critical-colored connector. Soft =
 * any lateral link type (SS/FF/SF) or an FS link carrying a positive lag (a
 * discretionary buffer the PM inserted), drawn dashed/gray. This is the only
 * heuristic the transform applies that is not a direct field read; it is
 * isolated and unit-tested so the rule is explicit and stable.
 */
export function classifyLinkHardness(link: TaskLink): boolean {
  return link.type === 'FS' && link.lag <= 0;
}

/**
 * Order links for painting so soft (gray, dashed) connectors draw first and hard
 * (critical, solid) connectors draw last — SVG paints in document order, so the
 * driving chain lands on top and stays legible where arrows cross (issue 1440).
 * A partition (not a comparator sort) preserves each group's incoming order, so
 * the stagger channel a link is assigned stays stable across re-renders.
 */
export function orderLinksForPaint(links: SchedulePrintLink[]): SchedulePrintLink[] {
  const soft = links.filter((l) => !l.hard);
  const hard = links.filter((l) => l.hard);
  return [...soft, ...hard];
}

/**
 * Whether the task is behind schedule, independent of critical-path membership:
 * negative float, a 'behind'/'at_risk' SPI band, or a positive schedule variance.
 * Drives both the at-risk band and the diagonal-hatch texture (ADR-0277) — the
 * hatch is what conveys "slipping" on a bar whose border already carries a
 * different band (a critical-and-behind bar is red-framed AND hatched).
 */
function isTaskBehind(task: Task): boolean {
  const negativeFloat = task.totalFloat != null && task.totalFloat < 0;
  const behind = task.spiBand === 'behind' || task.spiBand === 'at_risk';
  const slipping = task.scheduleVarianceDays != null && task.scheduleVarianceDays > 0;
  return negativeFloat || behind || slipping;
}

/**
 * Derive the bar coloring band from CPM/baseline signals already on the task.
 *
 * Precedence (highest wins): critical-path membership → at-risk (behind schedule) →
 * on-track. On the print surface this band drives the bar BORDER color (never the
 * fill, which is progress), so a completed critical task keeps its red frame instead
 * of being masked by the green progress fill (ADR-0277).
 */
function riskBandFor(task: Task): SchedulePrintRiskBand {
  if (task.isCritical) return 'critical';
  if (isTaskBehind(task)) return 'at-risk';
  return 'on-track';
}

/**
 * Whether a row is overdue: past its finish and not complete. Overdue is a shape
 * signal (a past-due flag + a dashed overrun tail to the data date), not a fourth
 * color, because red already means critical (ADR-0277). Dates compare as
 * YYYY-MM-DD strings (a stored time component can't drift a same-day boundary).
 *
 * - Task: `finish < dataDate` AND `pctComplete < 100`.
 * - Milestone: pending (not met) AND its date has passed.
 *
 * Returns false when there is no data date (no "now" to be past), so an export
 * without a data-date line never marks anything overdue.
 */
export function isRowOverdue(row: SchedulePrintRow, dataDate: string | null | undefined): boolean {
  if (!dataDate) return false;
  const dd = dataDate.slice(0, 10);
  if (row.isMilestone) {
    const on = (row.finish ?? row.start)?.slice(0, 10);
    return !row.milestoneMet && on != null && on < dd;
  }
  return row.finish != null && row.pctComplete < 100 && row.finish.slice(0, 10) < dd;
}

function toPrintRow(task: Task): SchedulePrintRow {
  const owner = task.assignees[0]?.name ?? null;
  const depth = wbsDepth(task.wbs);
  const kind: SchedulePrintRowKind = task.isMilestone
    ? 'milestone'
    : task.isSummary
      ? 'phase'
      : 'task';
  return {
    id: task.id,
    wbsCode: task.wbs,
    depth,
    indentLevel: Math.min(depth, MAX_INDENT_LEVELS),
    kind,
    name: task.name,
    owner,
    ownerInitials: owner ? initialsOf(owner) : null,
    start: task.start || null,
    finish: task.finish || null,
    pctComplete: task.progress,
    isCritical: task.isCritical,
    isBehind: isTaskBehind(task),
    totalFloat: task.totalFloat ?? null,
    riskBand: riskBandFor(task),
    isMilestone: task.isMilestone,
    milestoneMet: task.isMilestone ? task.isComplete || task.progress >= 100 : null,
  };
}

/** Whole calendar days between two ISO dates (UTC), inclusive of the finish day. */
function inclusiveDurationDays(startIso: string, finishIso: string): number {
  const start = new Date(startIso.length === 10 ? `${startIso}T00:00:00Z` : startIso).getTime();
  const finish = new Date(finishIso.length === 10 ? `${finishIso}T00:00:00Z` : finishIso).getTime();
  return Math.max(1, Math.round((finish - start) / MS_PER_DAY) + 1);
}

function buildKpis(
  rows: SchedulePrintRow[],
  forecast: MonteCarloResult | null | undefined,
): SchedulePrintKpis {
  const dated = rows.filter((r) => r.start && r.finish);
  const starts = dated.map((r) => r.start as string).sort();
  const finishes = dated.map((r) => r.finish as string).sort();
  const projectStart = starts[0] ?? null;
  const projectFinish = finishes[finishes.length - 1] ?? null;
  const durationDays =
    projectStart && projectFinish ? inclusiveDurationDays(projectStart, projectFinish) : 0;

  // Critical path.
  const cp = rows.filter((r) => r.isCritical);
  const cpFloats = cp.map((r) => r.totalFloat ?? 0);
  const cpFloat = cpFloats.length ? Math.min(...cpFloats) : 0;

  // Progress over leaf rows (phases roll up from their children, so excluding
  // them avoids double-counting).
  const leaves = rows.filter((r) => r.kind !== 'phase');
  const total = leaves.length;
  const done = leaves.filter((r) => r.pctComplete >= 100).length;
  const meanPct = total ? Math.round(leaves.reduce((s, r) => s + r.pctComplete, 0) / total) : 0;

  // Milestones.
  const milestones = rows.filter((r) => r.isMilestone);
  const metCount = milestones.filter((r) => r.milestoneMet).length;
  const nextMilestone = milestones
    .filter((r) => !r.milestoneMet && r.finish)
    .map((r) => r.finish as string)
    .sort()[0];

  // Forecast P80 + slip vs CPM (signed days).
  let forecastValue = '—';
  let forecastSub: string | null = null;
  if (forecast) {
    forecastValue = fmtUtcShort(forecast.p80);
    const slip = forecast.deltaVsCpm?.p80;
    if (slip != null) {
      forecastSub = slip > 0 ? `+${slip}d vs CPM` : slip < 0 ? `${slip}d vs CPM` : 'on CPM finish';
    }
  }

  return {
    window: {
      label: 'Window',
      value:
        projectStart && projectFinish
          ? `${fmtUtcShort(projectStart)} – ${fmtUtcShort(projectFinish)}`
          : '—',
      sub: durationDays ? `${durationDays}d` : null,
    },
    criticalPath: {
      label: 'Critical path',
      value: `${cp.length} ${cp.length === 1 ? 'task' : 'tasks'}`,
      sub: `${cpFloat}d float`,
    },
    forecastP80: {
      label: 'P80 forecast',
      value: forecastValue,
      sub: forecastSub,
    },
    progress: {
      label: 'Progress',
      value: `${meanPct}%`,
      sub: `${done} / ${total} done`,
    },
    milestones: {
      label: 'Milestones',
      value: `${metCount} / ${milestones.length} met`,
      sub: nextMilestone ? `next ${fmtUtcShort(nextMilestone)}` : null,
    },
  };
}

/**
 * Ordered critical-path driving chain for the CP summary box.
 *
 * The foundation orders CP-member rows by start (then finish, then WBS) — a
 * deterministic spine ordering. Strict predecessor-link topological ordering is a
 * issues 1437/1440 refinement; the data contract (the ordered list with dates + float)
 * is stable regardless.
 */
function buildCpChain(rows: SchedulePrintRow[]): SchedulePrintCpTask[] {
  return rows
    .filter((r) => r.isCritical)
    .slice()
    .sort((a, b) => {
      const sa = a.start ?? '';
      const sb = b.start ?? '';
      if (sa !== sb) return sa < sb ? -1 : 1;
      const fa = a.finish ?? '';
      const fb = b.finish ?? '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      return compareWbs(a.wbsCode, b.wbsCode);
    })
    .map((r, i) => ({
      id: r.id,
      seq: i + 1,
      wbsCode: r.wbsCode,
      name: r.name,
      start: r.start,
      finish: r.finish,
      totalFloat: r.totalFloat,
    }));
}

/**
 * 32-bit FNV-1a hash of a string, as zero-padded 8-char lowercase hex.
 *
 * `Math.imul` performs the FNV-prime multiply in 32-bit space (a plain `*` would
 * lose precision past 2^53); `>>> 0` coerces the result to unsigned before the
 * hex render. Deterministic and dependency-free.
 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Content fingerprint for the export's integrity stamp (issue 1437).
 *
 * NOT a cryptographic digest — a deterministic fingerprint of the rendered
 * schedule state (row dates/progress/critical flags, link topology + hardness,
 * the KPI cells) so two PDFs printed from the same schedule carry the *same*
 * stamp, and any schedule change shifts it. It lets a reader confirm a printed
 * artifact matches a live schedule at a glance; it is not a tamper-proof seal.
 * Stable field order in, stable hex out — pinned by `schedulePrintData.test.ts`.
 */
export function scheduleContentSha(
  rows: SchedulePrintRow[],
  links: SchedulePrintLink[],
  kpis: SchedulePrintKpis,
): string {
  const rowPart = rows
    .map(
      (r) =>
        `${r.id}|${r.wbsCode}|${r.start ?? ''}|${r.finish ?? ''}|${r.pctComplete}|` +
        `${r.isCritical ? 1 : 0}|${r.isMilestone ? 1 : 0}`,
    )
    .join(';');
  const linkPart = links.map((l) => `${l.id}>${l.fromId}>${l.toId}>${l.hard ? 1 : 0}`).join(';');
  const kpiPart = [kpis.window, kpis.criticalPath, kpis.forecastP80, kpis.progress, kpis.milestones]
    .map((k) => `${k.value}/${k.sub ?? ''}`)
    .join(';');
  return fnv1aHex(`${rowPart}#${linkPart}#${kpiPart}`);
}

export interface BuildSchedulePrintArgs {
  projectName: string;
  /** Method subtitle under the project name (defaults to the CPM line). */
  methodSubtitle?: string;
  orgName?: string | null;
  projectKey?: string | null;
  workspaceUrl?: string | null;
  baselineLabel?: string | null;
  tasks: Task[];
  links: TaskLink[];
  /** Existing forecast/Monte-Carlo result the live view already reads; null when none. */
  forecast?: MonteCarloResult | null;
  userName: string | null;
  /** Pre-formatted "generated at" label (caller stamps the wall clock). */
  generatedAtLabel: string;
  /** Masthead export-date label; defaults to {@link BuildSchedulePrintArgs.generatedAtLabel}. */
  exportDateLabel?: string;
  /**
   * Explicit content fingerprint for the footer integrity stamp. Omit to let
   * {@link buildSchedulePrintData} derive it from the assembled content via
   * {@link scheduleContentSha} (issue 1437); pass a value only to pin it in a test.
   */
  contentSha?: string | null;
  /**
   * Inclusive ISO date bounds for the "Visible window" timeline range (issue 1438).
   * When both are set, only rows whose [start, finish] overlaps the window are
   * charted; dangling links prune automatically. Rows with no dates are dropped
   * from a windowed export. KPIs and the CP chain still describe the whole project.
   */
  windowStart?: string | null;
  windowEnd?: string | null;
  /**
   * When true, chart only critical-path rows (issue 1438 "Non-critical tasks" off ⇒
   * the driving chain only). KPIs and the CP-chain summary are unaffected.
   */
  criticalOnly?: boolean;
}

const DEFAULT_METHOD_SUBTITLE = 'Critical Path Method schedule';

/**
 * Project the live schedule into the immutable print model. WBS-ordered rows,
 * hard/soft-classified links, the 5 KPI cells, the ordered CP chain, and the
 * masthead/footer context — all derived from already-loaded data.
 */
export function buildSchedulePrintData(args: BuildSchedulePrintArgs): SchedulePrintData {
  const allRows = args.tasks
    .slice()
    .sort((a, b) => compareWbs(a.wbs, b.wbs))
    .map(toPrintRow);

  // KPIs and the critical-path chain describe the WHOLE project — they are the
  // report's "project facts" and must not shift when the chart is decluttered
  // ("Non-critical tasks" off) or clipped to a viewport window (issue 1438). Only
  // the charted rows below honor the options.
  const kpis = buildKpis(allRows, args.forecast);
  const cpChain = buildCpChain(allRows);

  let rows = allRows;
  if (args.windowStart && args.windowEnd) {
    // ISO YYYY-MM-DD strings compare lexicographically; overlap = start ≤ windowEnd
    // AND finish ≥ windowStart. Slice to the date so a stored time component can't
    // push a same-day boundary row out of the window. Undated rows have no
    // placement, so drop them from a windowed export.
    const ws = args.windowStart.slice(0, 10);
    const we = args.windowEnd.slice(0, 10);
    rows = rows.filter(
      (r) =>
        r.start != null &&
        r.finish != null &&
        r.start.slice(0, 10) <= we &&
        r.finish.slice(0, 10) >= ws,
    );
  }
  if (args.criticalOnly) {
    rows = rows.filter((r) => r.isCritical);
  }

  const rowIds = new Set(rows.map((r) => r.id));
  // Drop dangling links (an endpoint filtered out of the visible set) so the
  // arrow overlay never references a row it cannot place.
  const links: SchedulePrintLink[] = args.links
    .filter((l) => rowIds.has(l.sourceId) && rowIds.has(l.targetId))
    .map((l) => ({
      id: l.id,
      fromId: l.sourceId,
      toId: l.targetId,
      type: l.type,
      hard: classifyLinkHardness(l),
    }));

  return {
    rows,
    links,
    kpis,
    cpChain,
    masthead: {
      projectName: args.projectName,
      methodSubtitle: args.methodSubtitle ?? DEFAULT_METHOD_SUBTITLE,
      orgName: args.orgName ?? null,
      baselineLabel: args.baselineLabel ?? null,
      exportDateLabel: args.exportDateLabel ?? args.generatedAtLabel,
      projectKey: args.projectKey ?? null,
      workspaceUrl: args.workspaceUrl ?? null,
    },
    footer: {
      generatedAtLabel: args.generatedAtLabel,
      userName: args.userName,
      signOff: 'Critical path computed by the CPM engine · float = 0 on highlighted tasks.',
      contentSha: args.contentSha ?? scheduleContentSha(rows, links, kpis),
    },
  };
}
