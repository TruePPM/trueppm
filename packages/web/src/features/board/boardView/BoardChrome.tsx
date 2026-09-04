/**
 * The band of board chrome that sits between the toolbar and the phase grid:
 * the off-screen export surface, every banner, and the zero-match notice.
 *
 * Lifted out of `BoardView` for #2378. Each element is individually trivial —
 * a single `&&` guard over a self-contained banner — but there are a dozen of
 * them, and in the shell they summed to roughly a fifth of `BoardView`'s
 * cognitive-complexity score. Grouping them here is also honest about what they
 * are: one horizontal band whose members self-hide, rendered in a fixed order.
 *
 * No behavior change — the guards and their order are reproduced exactly.
 */
import type { ComponentProps, RefObject } from 'react';
import { BoardScopeInjectionBanner } from '../BoardScopeInjectionBanner';
import { BoardSprintHeader } from '../BoardSprintHeader';
import { ClosedSprintBanner } from '../ClosedSprintBanner';
import { BoardPrintLayout } from '../export/BoardPrintLayout';
import { BoardLensBanners, BoardZeroMatch, FocusLaneBanner } from './BoardLensBanners';
import { CollapsedColumnsBanner } from './CollapsedColumnsBanner';
import { COLUMN_DOT_CLASS } from './columnTokens';
import type { ApiSprint, Task, TaskStatus } from '@/types';

// Derived from the components themselves so this shell cannot drift from the
// shapes it forwards — the props are pass-through, not a second declaration.
type BoardPrintData = ComponentProps<typeof BoardPrintLayout>['data'];
type ChromeColumns = ComponentProps<typeof CollapsedColumnsBanner>['columns'];

export interface BoardChromeProps {
  projectId: string;
  tasks: Task[];

  /** Off-screen print surface — mounted only while an export is in flight. */
  exportRequested: boolean;
  boardPrintRef: RefObject<HTMLDivElement | null>;
  boardPrintData: BoardPrintData;

  scopePendingCount: number;
  canManageScope: boolean;
  onReviewScope: () => void;

  mineActive: boolean;
  onClearMine: () => void;
  debtOnly: boolean;
  onClearDebt: () => void;

  selectedSprint: ApiSprint | null;
  /** `'continuous'` suppresses all sprint chrome (ADR-0164, issue 410). */
  boardCadence: string | undefined;
  onOpenStandup: () => void;
  sprintClosed: boolean;

  focusedLanePhaseName: string | null;
  onExitFocusLane: () => void;

  columns: ChromeColumns;
  collapsedColumns: Set<TaskStatus>;
  totalByStatus: Record<TaskStatus, number>;
  myCountByStatus: Record<TaskStatus, number>;
  onExpandColumn: (status: TaskStatus) => void;
  onToggleColumn: (status: TaskStatus) => void;
  onExpandAllColumns: () => void;

  facetZeroMatch: boolean;
  onClearAllFacets: () => void;
}

export function BoardChrome({
  projectId,
  tasks,
  exportRequested,
  boardPrintRef,
  boardPrintData,
  scopePendingCount,
  canManageScope,
  onReviewScope,
  mineActive,
  onClearMine,
  debtOnly,
  onClearDebt,
  selectedSprint,
  boardCadence,
  onOpenStandup,
  sprintClosed,
  focusedLanePhaseName,
  onExitFocusLane,
  columns,
  collapsedColumns,
  totalByStatus,
  myCountByStatus,
  onExpandColumn,
  onToggleColumn,
  onExpandAllColumns,
  facetZeroMatch,
  onClearAllFacets,
}: BoardChromeProps) {
  return (
    <>
      {/* Off-screen board-export print surface (issue 326). Mounted only
          while an export is in flight so its duplicate projection of the
          board's text never lingers in the DOM. Positioned out of view
          (never display:none — html-to-image must render it) and aria-hidden
          so it's invisible to assistive tech and pointer input. */}
      {exportRequested && (
        <div aria-hidden="true" className="pointer-events-none absolute -left-[99999px] top-0">
          <BoardPrintLayout ref={boardPrintRef} data={boardPrintData} />
        </div>
      )}
      {/* Mid-sprint scope-injection banner (ADR-0101 §5) — team-visible
          record that tasks were added to the active sprint after it
          started. Self-hides when there's nothing to report. */}
      <BoardScopeInjectionBanner
        tasks={tasks}
        pendingCount={scopePendingCount}
        canManageScope={canManageScope}
        onReview={onReviewScope}
      />

      <BoardLensBanners
        mineActive={mineActive}
        onClearMine={onClearMine}
        debtOnly={debtOnly}
        onClearDebt={onClearDebt}
      />

      {/* Sprint header bar (#1138) — name + date range + Day N of M timebox
          + goal + compact burndown. Only when a sprint is selected, and never on a
          continuous-flow Kanban board (ADR-0164, issue 410) — that's sprint chrome. */}
      {selectedSprint && projectId && boardCadence !== 'continuous' && (
        <BoardSprintHeader
          sprint={selectedSprint}
          projectId={projectId}
          onOpenStandup={onOpenStandup}
        />
      )}
      {/* Closed-sprint read-only banner (#1141) — below the header, above the
          grid; drag-to-assign is disabled board-wide (see `readOnly`). */}
      {sprintClosed && projectId && <ClosedSprintBanner projectId={projectId} />}

      <FocusLaneBanner phaseName={focusedLanePhaseName} onExit={onExitFocusLane} />

      <CollapsedColumnsBanner
        columns={columns}
        collapsedColumns={collapsedColumns}
        totalByStatus={totalByStatus}
        myCountByStatus={myCountByStatus}
        dotClassFor={(status) => COLUMN_DOT_CLASS[status] ?? 'bg-neutral-text-disabled'}
        onExpandColumn={onExpandColumn}
        onToggleColumn={onToggleColumn}
        onExpandAllColumns={onExpandAllColumns}
      />

      {facetZeroMatch && <BoardZeroMatch onClearAll={onClearAllFacets} />}
    </>
  );
}
