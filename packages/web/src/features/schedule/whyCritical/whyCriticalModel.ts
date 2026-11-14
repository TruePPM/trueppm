/**
 * Payload → view model for the "Why critical" drawer section (#4892).
 *
 * Everything here is a pure function of the server's driving-chain payload
 * (`GET /projects/{id}/schedule/driving-chain/`, ADR-1381). The client never
 * walks the dependency graph (web rule: server-explanation surfaces render the
 * payload only): ordering is a sort by the payload's own `hops`, and each edge
 * is paired with its node by the ids the payload states. Units are spelled on
 * every number — float in working days ("wd"), lag in calendar days ("cal d") —
 * and the two are never summed or shown in the same phrase.
 */
import type { DrivingChainEdge, DrivingChainNode, ScheduleDrivingChain } from '@/api/types';

/** Known float bands; anything else the server sends renders neutral (open enum). */
export type BandKind = 'critical' | 'near_critical' | 'ample' | 'unknown';

export function bandKind(band: string | null | undefined): BandKind {
  if (band === 'critical' || band === 'near_critical' || band === 'ample') return band;
  return 'unknown';
}

/** Band word; `null` for an unknown band, which gets no word at all. */
export function bandWord(kind: BandKind): string | null {
  switch (kind) {
    case 'critical':
      return 'Critical';
    case 'near_critical':
      return 'Near-critical';
    case 'ample':
      return 'Not critical';
    default:
      return null;
  }
}

/** Tailwind text color per band; unknown bands render neutral and wordless. */
export const BAND_TEXT: Record<BandKind, string> = {
  critical: 'text-semantic-critical',
  near_critical: 'text-semantic-at-risk',
  ample: 'text-neutral-text-secondary',
  unknown: 'text-neutral-text-secondary',
};

export const DEP_TYPE_LABEL: Record<DrivingChainEdge['dep_type'], string> = {
  FS: 'Finish-to-start',
  SS: 'Start-to-start',
  FF: 'Finish-to-finish',
  SF: 'Start-to-finish',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDay(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}

/** "Mar 14", with ", 2028" appended when the year differs from `today`'s. */
export function formatShortDate(iso: string | null | undefined, today: Date): string {
  const p = parseDay(iso);
  if (!p) return 'an unscheduled date';
  const base = `${MONTHS[p.m]} ${p.d}`;
  return p.y === today.getFullYear() ? base : `${base}, ${p.y}`;
}

/** "Mar 14, 2027" — the copy-as-text form always carries the year. */
export function formatLongDate(iso: string | null | undefined): string {
  const p = parseDay(iso);
  if (!p) return 'unscheduled';
  return `${MONTHS[p.m]} ${p.d}, ${p.y}`;
}

/** "14:02 UTC" from an ISO timestamp. */
export function formatUtcTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** "2027-03-02 14:02 UTC" from an ISO timestamp. */
export function formatUtcStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${formatUtcTime(iso)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function floatLabel(value: number): string {
  return `${value} wd float`;
}

export function lagLabel(value: number): string {
  if (value === 0) return 'lag 0 cal d';
  return `lag ${value > 0 ? '+' : '-'}${Math.abs(value)} cal d`;
}

/** One segment of the default sentence; a segment with `taskId` renders as a link. */
export interface SentenceSegment {
  text: string;
  taskId?: string;
}

function findSelf(chain: ScheduleDrivingChain): DrivingChainNode | undefined {
  return chain.nodes.find((n) => n.direction === 'self');
}

/**
 * Compose the plain-language default sentence (no "float", "FS" or "CPM").
 *
 * Drivers are the driving edges into this task, in payload order. The verb
 * comes from the first driver's link type; drivers of another type are not
 * named here (they appear in the technical detail).
 */
export function composeSentence(chain: ScheduleDrivingChain, today: Date): SentenceSegment[] {
  const self = findSelf(chain);
  if (!self) return [{ text: "No earlier task holds up this task's dates." }];
  const byId = new Map(chain.nodes.map((n) => [n.task_id, n]));
  const drivers = chain.edges.filter((e) => e.successor_id === self.task_id && e.is_driving);
  const segments: SentenceSegment[] = [];
  if (drivers.length === 0) {
    segments.push({ text: "No earlier task holds up this task's dates." });
  } else {
    const first = drivers[0];
    const sameType = drivers.filter((e) => e.dep_type === first.dep_type);
    const finishSide = first.dep_type === 'FF' || first.dep_type === 'SF';
    const predUsesStart = first.dep_type === 'SS' || first.dep_type === 'SF';
    const pred = byId.get(first.predecessor_id);
    const date = formatShortDate(predUsesStart ? pred?.early_start : pred?.early_finish, today);
    const lag = first.lag.value;
    const lagPhrase =
      lag === 0
        ? ''
        : `${Math.abs(lag)} ${plural(Math.abs(lag), 'calendar day', 'calendar days')} ${
            lag > 0 ? 'after' : 'before'
          } `;
    segments.push({ text: `Can't ${finishSide ? 'finish' : 'start'} until ${lagPhrase}` });
    if (pred?.sprint) {
      // TODO(#4980): the payload carries no sprint name, so the subject is "the
      // sprint" rather than "Sprint N" — never invent a number client-side.
      const sprintDate = formatShortDate(pred.sprint.finish_date, today);
      segments.push({ text: `the sprint ends on ${sprintDate}.` });
    } else {
      const verbOne = predUsesStart ? 'starts' : 'finishes';
      const verbMany = predUsesStart ? 'start' : 'finish';
      const names = sameType.map((e) => byId.get(e.predecessor_id)).filter(Boolean);
      const firstName = names[0] ?? pred;
      segments.push({ text: firstName?.name ?? 'an earlier task', taskId: firstName?.task_id });
      if (names.length === 2 && names[1]) {
        segments.push({ text: ' and ' });
        segments.push({ text: names[1].name, taskId: names[1].task_id });
        segments.push({ text: ` ${verbMany} on ${date}.` });
      } else if (names.length > 2) {
        const others = names.length - 1;
        segments.push({
          text: ` and ${others} ${plural(others, 'other task', 'other tasks')} ${verbMany} on ${date}.`,
        });
      } else {
        segments.push({ text: ` ${verbOne} on ${date}.` });
      }
    }
  }
  const kind = bandKind(self.band);
  if (kind === 'critical') {
    segments.push({ text: ' A delay to any step in this chain moves it.' });
  } else if (kind === 'near_critical') {
    const f = self.total_float.value;
    segments.push({
      text: ` It can slip ${f} ${plural(f, 'working day', 'working days')} before it becomes critical.`,
    });
  }
  return segments;
}

export function sentenceText(segments: SentenceSegment[]): string {
  return segments.map((s) => s.text).join('');
}

/** Label for one edge, shared by the UI and the copied text so the two cannot diverge. */
export function edgeLabel(edge: DrivingChainEdge, successorName: string): string {
  const via =
    edge.via_summary && edge.via_summary.length > 0
      ? ` · via ${edge.via_summary.map((v) => v.name ?? 'a summary task').join(' › ')}`
      : '';
  return `${edge.is_driving ? '' : 'Not driving · '}${DEP_TYPE_LABEL[edge.dep_type]} into ${successorName} · ${lagLabel(edge.lag.value)}${via}`;
}

/** One rendered card in the technical-detail chain. */
export interface ChainCard {
  key: string;
  kind: 'finish' | 'self' | 'task' | 'sprint';
  /** Navigable task id; `null` for a collapsed sprint card (no name link). */
  taskId: string | null;
  title: string;
  subtitle: string;
  float: number;
  band: BandKind;
  /** No edge out of this card drives a date: rendered indented with a dashed link. */
  nonDriving: boolean;
  /** Edges out of this card (into a nearer node), rendered on the connector above it. */
  outEdges: { label: string; driving: boolean; successorBand: BandKind }[];
  /** Ids of every payload node this card stands for. */
  memberIds: string[];
}

export interface WhyCriticalView {
  self: DrivingChainNode;
  band: BandKind;
  sentence: SentenceSegment[];
  cards: ChainCard[];
  /** "N steps not listed (downstream)" when a project-finish node is present. */
  downstreamGap: string | null;
  truncationLines: string[];
  thresholdLine: string;
  unitsLine: string;
  provenanceShort: string;
  provenanceLong: string;
  partial: boolean;
}

function stepsBack(n: number): string {
  return `${n} ${plural(n, 'step', 'steps')} back`;
}

export function truncationLines(chain: ScheduleDrivingChain): string[] {
  const lines: string[] = [];
  if (chain.truncated) {
    const cut =
      chain.truncated_reason === 'node_cap'
        ? `Chain cut at the ${chain.node_cap}-task limit.`
        : `Chain cut at ${stepsBack(chain.depth)}.`;
    lines.push(`${cut} ${chain.edges.length} of ${chain.total_links} links shown.`);
  }
  const omitted = chain.omitted_non_driving_count;
  if (omitted > 0) {
    lines.push(
      omitted === 1
        ? "1 more link doesn't drive any dates and isn't listed."
        : `${omitted} more links don't drive any dates and aren't listed.`,
    );
  }
  return lines;
}

/**
 * Build the full view for a computable payload, or `null` when the payload has
 * no `self` node (a malformed or non-computable response).
 */
export function buildWhyCriticalView(
  chain: ScheduleDrivingChain,
  today: Date,
): WhyCriticalView | null {
  const self = findSelf(chain);
  if (!chain.computable || !self) return null;
  const byId = new Map(chain.nodes.map((n) => [n.task_id, n]));
  const nameOf = (id: string) => byId.get(id)?.name ?? 'a task';
  const bandOf = (id: string) => bandKind(byId.get(id)?.band);

  const finish = chain.nodes.find((n) => n.direction === 'downstream' && n.is_project_finish);
  // Upstream nodes sorted by hops; Array.prototype.sort is stable, so ties keep
  // payload order.
  const upstream = chain.nodes
    .filter((n) => n.direction === 'upstream')
    .slice()
    .sort((a, b) => a.hops - b.hops);

  // Collapse consecutive sprint-bound nodes sharing a sprint id into one card.
  const groups: DrivingChainNode[][] = [];
  for (const n of upstream) {
    const last = groups[groups.length - 1];
    if (n.sprint && last && last[0].sprint && last[0].sprint.id === n.sprint.id) last.push(n);
    else groups.push([n]);
  }

  const cards: ChainCard[] = [];
  if (finish) {
    cards.push({
      key: `finish-${finish.task_id}`,
      kind: 'finish',
      taskId: finish.task_id,
      title: finish.name,
      subtitle: `Finishes ${formatShortDate(finish.early_finish, today)} · ${finish.hops} ${plural(finish.hops, 'step', 'steps')} after this task`,
      float: finish.total_float.value,
      band: bandKind(finish.band),
      nonDriving: false,
      outEdges: [],
      memberIds: [finish.task_id],
    });
  }
  cards.push({
    key: `self-${self.task_id}`,
    kind: 'self',
    taskId: self.task_id,
    title: self.name,
    subtitle: `Finishes ${formatShortDate(self.early_finish, today)}`,
    float: self.total_float.value,
    band: bandKind(self.band),
    nonDriving: false,
    outEdges: [],
    memberIds: [self.task_id],
  });
  for (const group of groups) {
    const ids = new Set(group.map((n) => n.task_id));
    const out = chain.edges.filter((e) => ids.has(e.predecessor_id) && !ids.has(e.successor_id));
    const outEdges = out.map((e) => ({
      label: edgeLabel(e, nameOf(e.successor_id)),
      driving: e.is_driving,
      successorBand: bandOf(e.successor_id),
    }));
    const nonDriving = out.length > 0 && out.every((e) => !e.is_driving);
    const head = group[0];
    if (head.sprint) {
      const minFloat = group.reduce((m, n) => Math.min(m, n.total_float.value), Infinity);
      const minNode = group.find((n) => n.total_float.value === minFloat) ?? head;
      const minHops = group.reduce((m, n) => Math.min(m, n.hops), Infinity);
      cards.push({
        key: `sprint-${head.sprint.id}-${head.task_id}`,
        kind: 'sprint',
        taskId: null,
        // TODO(#4980): "Sprint N" once the payload carries the sprint name.
        title: `Sprint · team-owned · ends ${formatShortDate(head.sprint.finish_date, today)}`,
        subtitle: `${stepsBack(minHops)} · work inside the sprint is planned by the team`,
        float: minFloat,
        band: bandKind(minNode.band),
        nonDriving,
        outEdges,
        memberIds: group.map((n) => n.task_id),
      });
    } else {
      cards.push({
        key: `task-${head.task_id}`,
        kind: 'task',
        taskId: head.task_id,
        title: head.name,
        subtitle: `Finishes ${formatShortDate(head.early_finish, today)} · ${stepsBack(head.hops)}`,
        float: head.total_float.value,
        band: bandKind(head.band),
        nonDriving,
        outEdges,
        memberIds: [head.task_id],
      });
    }
  }

  const trunc = truncationLines(chain);
  const prov = chain._provenance;
  return {
    self,
    band: bandKind(self.band),
    sentence: composeSentence(chain, today),
    cards,
    downstreamGap: finish
      ? `${finish.hops} ${plural(finish.hops, 'step', 'steps')} not listed (downstream)`
      : null,
    truncationLines: trunc,
    thresholdLine: `Near-critical: ≤ ${chain.near_critical_threshold.value} wd float`,
    unitsLine: 'wd = working days (float) · cal d = calendar days (lag)',
    // The payload carries no schedule version number, so provenance is the
    // compute timestamp and engine version it does state.
    provenanceShort: `Schedule computed ${formatUtcTime(prov.computed_at)}`,
    provenanceLong: `Schedule computed ${formatUtcStamp(prov.computed_at)} · engine ${prov.engine_version}`,
    partial: chain.truncated,
  };
}

/** Greedy word wrap at `width` characters; continuation lines take `indent`. */
export function wrapText(line: string, width = 60, indent = ''): string[] {
  const words = line.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > width && cur) {
      out.push(cur);
      cur = `${indent}${w}`;
    } else {
      cur = candidate;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Plain-text export for the governance pack. A superset of the screen: every
 * card, every edge label the UI renders (non-driving ones included), the
 * truncation and omission lines, the threshold, the unit key and provenance.
 * Band colors are printed as words.
 */
export function buildCopyText(chain: ScheduleDrivingChain, view: WhyCriticalView): string {
  const lines: string[] = [];
  const self = view.self;
  lines.push(`WHY CRITICAL: ${self.name}`);
  const word = bandWord(view.band);
  lines.push(
    [word, floatLabel(self.total_float.value), `finishes ${formatLongDate(self.early_finish)}`]
      .filter(Boolean)
      .join(' · '),
  );
  // The year form throughout: a pasted pack is read long after "this year".
  const farFuture = new Date(Date.UTC(9999, 0, 1));
  lines.push(...wrapText(sentenceText(composeSentence(chain, farFuture))));
  const finishCard = view.cards.find((c) => c.kind === 'finish');
  if (finishCard) {
    const finish = chain.nodes.find((n) => n.task_id === finishCard.taskId);
    lines.push(
      ...wrapText(
        `Project finish: ${finishCard.title}, ${formatLongDate(finish?.early_finish)}${finish ? ` · ${finish.hops} ${plural(finish.hops, 'step', 'steps')} after this task` : ''} (${view.downstreamGap ?? ''})`,
        60,
        ' ',
      ),
    );
  }
  lines.push('Driving chain, nearest first');
  // Card titles and subtitles in the year form too: the same view built against a
  // far-future "today" renders every date with its year, keyed onto the screen's cards.
  const yearCards = new Map(
    (buildWhyCriticalView(chain, farFuture)?.cards ?? []).map((c) => [c.key, c]),
  );
  let index = 1;
  for (const card of view.cards) {
    if (card.kind === 'finish') continue;
    const bw = bandWord(card.band);
    const prefix = card.nonDriving ? '   ' : `${index++}. `;
    const yearCard = yearCards.get(card.key) ?? card;
    const title = card.kind === 'self' ? `${yearCard.title} (this task)` : yearCard.title;
    const subtitle = yearCard.subtitle;
    lines.push(...wrapText(`${prefix}${title} · ${subtitle}`, 60, '   '));
    lines.push(`   · ${floatLabel(card.float)}${bw ? ` · ${bw}` : ''}`);
    for (const e of card.outEdges) {
      lines.push(...wrapText(`   ← ${e.label}${e.driving ? ' · driving' : ''}`, 60, '     '));
    }
  }
  lines.push(...view.truncationLines.flatMap((l) => wrapText(l)));
  lines.push(`${view.thresholdLine}.`);
  lines.push('Units: wd = working days (float);');
  lines.push('cal d = calendar days (lag). Not addable.');
  lines.push(...wrapText(view.provenanceLong));
  return lines.join('\n');
}

/** Not-computable copy, keyed on the payload's `reason` and the drawer task's sprint. */
export function notComputableText(reason: string | null, taskHasSprint: boolean): string {
  switch (reason) {
    case 'backlog':
      return "Backlog items aren't on the schedule yet, so nothing drives their dates.";
    case 'not_committed':
      return "This task isn't committed to the schedule yet, so it has no chain to show.";
    case 'summary':
      return 'Summary tasks take their dates from their subtasks. Open a subtask to see what drives it.';
    case 'not_in_network':
      return taskHasSprint
        ? "Sprint-only items have no dependency links, so they aren't shown here."
        : 'This task has no dependency links, so nothing in the schedule drives its dates.';
    default:
      return "Why this task is critical can't be shown right now.";
  }
}

/** Runtime guard: the catch-all e2e mock and a misbehaving proxy both return other shapes. */
export function isDrivingChain(value: unknown): value is ScheduleDrivingChain {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.computable === 'boolean' &&
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges) &&
    typeof v._provenance === 'object' &&
    v._provenance !== null
  );
}
