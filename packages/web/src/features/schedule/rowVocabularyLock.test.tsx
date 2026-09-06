import { cleanup } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ColumnWidths } from '@/hooks/useColumnWidths';
import { TaskListHeader } from './TaskListHeader';
import { ScheduleAppendTaskFooter } from './ScheduleAppendTaskFooter';
import { BlankOutlineDraftRow } from './buildMode/BlankOutlineDraftRow';
import { TaskListPanel } from './TaskListPanel';
import { ScheduleSummaryChip } from './ScheduleSummaryChip';
import { useSchedulerStore } from '@/stores/schedulerStore';
import { ROW_VOCABULARY } from './rowVocabulary';

/**
 * The rendered-DOM half of the vocabulary lock (#3031).
 *
 * The type system stops a literal reaching a governed *prop*, and
 * `scripts/check-row-vocabulary.sh` stops a governed string being *copied*
 * anywhere in the outline's tree. Neither reads what the surface actually says,
 * so neither can see a component that renders freshly-worded copy of its own.
 *
 * This does. It renders the outline's governed surfaces, sweeps every string a
 * user or a screen reader can reach — visible text, accessible name, tooltip,
 * placeholder — and fails if any of them names a row TYPE on a surface that
 * exists before the type does.
 *
 * ## The two ways this could pass while being broken, and what stops each
 *
 * 1. **The sweep finds nothing.** A changed role, a renamed testid, a component
 *    that stopped rendering — any of these turn "no offenders" into "no
 *    strings", and the suite goes green while checking nothing. That is the
 *    failure that made the sub-12px lint gate useless through six sweeps, so
 *    there is a floor on the number of strings collected AND a per-component
 *    assertion that each one contributed at least one.
 * 2. **The roster goes stale.** The three components below are an enumeration,
 *    and the issue that asked for this mechanism was right that an enumeration
 *    is the weak point. It is bounded here: a component that stops rendering
 *    governed copy fails (1), and a governed string *copied* into a new
 *    component is caught by the shell gate. What neither catches — a brand-new
 *    component with brand-new wrong wording, never added here — is the residual,
 *    and it is recorded in the module docstring rather than papered over.
 */

const WIDTHS: ColumnWidths['widths'] = {
  wbs: 48,
  task: 220,
  links: 76,
  dur: 52,
  start: 74,
  finish: 74,
  progress: 60,
  owner: 72,
  totalFloat: 64,
  freeFloat: 64,
};

const ALL_VISIBLE: ColumnWidths['visible'] = {
  wbs: true,
  task: true,
  links: true,
  dur: true,
  start: true,
  finish: true,
  progress: true,
  owner: true,
  totalFloat: true,
  freeFloat: true,
};

/**
 * Every string the rendered tree exposes to a reader, by any route.
 *
 * `title` and `placeholder` are swept as well as text and accessible name
 * because #3027's instances hid in exactly those attributes — a sweep that
 * looks only at what is painted misses the tooltip on the affordance and the
 * ghost text in the field.
 */
function readableStrings(root: HTMLElement): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    if (t) out.push(t);
  };
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    push(el.getAttribute('aria-label'));
    push(el.getAttribute('title'));
    push(el.getAttribute('placeholder'));
    // Text belonging to THIS element, not to its descendants — otherwise every
    // ancestor re-reports the whole subtree and the floor below passes on
    // duplicates rather than on coverage.
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) push(node.textContent);
    }
  }
  return out;
}

/** The surfaces that exist before a row's type does. */
const GOVERNED_SURFACES: { name: string; render: () => void }[] = [
  {
    name: 'TaskListHeader',
    render: () =>
      void render(
        <TaskListHeader
          widths={WIDTHS}
          visible={ALL_VISIBLE}
          setWidth={vi.fn()}
          gripReserve={0}
          nudgeReserve={0}
        />,
      ),
  },
  {
    name: 'ScheduleAppendTaskFooter',
    render: () =>
      void render(
        <ScheduleAppendTaskFooter
          onAppend={vi.fn()}
          ariaRowIndex={8}
          label={ROW_VOCABULARY.create.appendAtEnd}
        />,
      ),
  },
  {
    name: 'BlankOutlineDraftRow',
    render: () => void render(<BlankOutlineDraftRow onCommit={vi.fn()} nameWidth={220} />),
  },
  ...(['ok', 'error'] as const).map((cpm) => ({
    // The Schedule toolbar's summary chip (#3259). It counts `visibleTasks` —
    // every row regardless of structure_role — and called all of them "tasks",
    // which typed every phase and milestone it counted.
    //
    // This is the lock's FIRST real miss, and the reason it is worth adding
    // rather than fixing by hand: two sweeps (#3027, #2952) and then the
    // mechanism built to replace them (#3031) all passed over this file, purely
    // because the roster above never rendered it. Fixing the string and not the
    // roster would leave the next chip exactly as unprotected.
    //
    // Both noun-bearing aria branches are rendered. The third, `loading`,
    // announces "Project status: recalculating" and carries no noun — so it is
    // excluded deliberately, not overlooked.
    name: `ScheduleSummaryChip (CPM ${cpm})`,
    render: () => {
      useSchedulerStore.setState({
        isRecalculating: false,
        cpmError: cpm === 'error' ? { error: 'cyclic_dependency', cycle: ['a', 'b'] } : null,
        recalculatedAt: null,
      });
      render(
        <ScheduleSummaryChip
          visibleTasks={[
            { id: 'a', wbs: '1', name: 'a', start: '2026-04-05', finish: '2026-04-09',
              duration: 5, progress: 0, parentId: null, isCritical: true, isComplete: false,
              isSummary: false, isMilestone: false, status: 'NOT_STARTED', assignees: [],
              notes: '', sprintId: 's1' },
          ] as never}
        />,
      );
    },
  })),
  {
    // The outline SHELL — its own accessible name is a claim about everything
    // inside it, and a treegrid called "Task list" typed every row it held for
    // as long as the surface existed (#3052). Rendered with no tasks on
    // purpose: the shell, its header and its footer are what carry governed
    // copy, and an empty outline needs no `TaskListRow` mock to reach them.
    name: 'TaskListPanel (shell)',
    render: () =>
      void render(
        <TaskListPanel
          tasks={[]}
          scrollRef={{ current: null }}
          widths={WIDTHS}
          visible={ALL_VISIBLE}
          setWidth={vi.fn()}
          totalWidth={640}
          summaryIds={new Set()}
          expandedIds={new Set()}
          onToggle={vi.fn()}
          onAppendTaskAtEnd={vi.fn()}
        />,
      ),
  },
];

/**
 * A row type named where the type is not yet known.
 *
 * "Phase" is absent on purpose: the outline legitimately says it on affordances
 * attached to a row already known to be a container, and `rowVocabulary.test.ts`
 * is where those exceptions are enumerated and kept honest. The words below have
 * no such legitimate use on these three surfaces.
 */
const TYPE_CLAIM = /\b(tasks?|milestones?|subtasks?)\b/i;

describe('the vocabulary lock, as rendered (#3031)', () => {
  afterEach(cleanup);

  it('names no row type on any surface that exists before the type does', () => {
    const seen: { surface: string; strings: string[] }[] = [];
    for (const surface of GOVERNED_SURFACES) {
      surface.render();
      seen.push({ surface: surface.name, strings: readableStrings(document.body) });
      cleanup();
    }

    // (1) The sweep found something on EVERY surface. A component that renders
    // nothing readable contributes no offenders and would otherwise read as
    // compliant.
    for (const { surface, strings } of seen) {
      expect(strings.length, `${surface} exposed no readable string`).toBeGreaterThan(0);
    }
    // And enough in total that the assertion below is doing real work.
    expect(seen.flatMap((s) => s.strings).length).toBeGreaterThanOrEqual(8);

    // (2) No type claim anywhere in what was collected.
    const offenders = seen.flatMap(({ surface, strings }) =>
      strings.filter((s) => TYPE_CLAIM.test(s)).map((s) => `${surface}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it('fails when a surface DOES name a type — the guard is not just an empty query', () => {
    // The sweep is the load-bearing part, so prove it can see a violation
    // rather than trusting that it would. Without this, a `querySelectorAll`
    // that silently stopped matching would leave the test above green forever.
    const { container } = render(
      <div>
        <button type="button" aria-label="Add task">
          + Task
        </button>
      </div>,
    );
    const strings = readableStrings(container);
    expect(strings.some((s) => TYPE_CLAIM.test(s))).toBe(true);
  });
});
