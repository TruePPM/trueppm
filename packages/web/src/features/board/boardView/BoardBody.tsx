import type { CSSProperties, ReactNode } from 'react';
import type { Task, TaskStatus } from '@/types';
import type { BoardDensity, EvmMode, BoardCardScopeActions } from '../BoardCard';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import type { BacklogDensity, BoardLayoutVariant } from '@/hooks/useBoardToolbarPrefs';
import { BacklogBand } from '../BacklogBand';
import type { BoardCadence } from '@/types';
import { BacklogDrawer } from '../BacklogDrawer';
import { QueueLayout } from '../QueueLayout';
import { MobileBoard } from './MobileBoard';
import { SprintPanel } from '../SprintPanel';
import { FlowAnalyticsPanel } from '../FlowAnalyticsPanel';
import { BoardColumnHeaderRow, type HeaderColumn } from './BoardColumnHeaderRow';
import { BoardPhaseLanes, type LaneShape } from './BoardPhaseLanes';

interface BoardBodyProps {
  projectId: string;
  /** Facets are active but nothing matched — the zero-match state supersedes the body. */
  facetZeroMatch: boolean;
  effectiveLayout: BoardLayoutVariant;
  isMobile: boolean;
  columns: (HeaderColumn & { color: string | null; slaDays?: number })[];
  methodology: 'WATERFALL' | 'AGILE' | 'HYBRID' | undefined;
  boardCadence: BoardCadence | undefined;

  // Queue layout
  queueTasks: Task[];
  phaseNameFor: (parentId: string | null) => string;
  phaseColorFor: (parentId: string | null) => string;
  canReorder: boolean;
  onReorderGroup: (entries: { id: string; serverVersion: number }[]) => void;

  // Backlog rail / drawer
  backlogTasks: Task[];
  isDragActive: boolean;
  isBacklogOver: boolean;
  backlogDensity: BacklogDensity;
  onSchedule?: (task: Task, trigger: HTMLElement) => void;
  onQuickCapture?: (name: string, opts?: { onError?: () => void }) => void;
  isQuickCapturePending: boolean;
  onCaptureIdea: () => void;
  onOpenCommandPalette: () => void;

  // Mobile snap board
  mobileTasksByStatus: Record<TaskStatus, Task[]>;
  onActiveStatusChange: (status: TaskStatus) => void;

  // Shared card wiring
  density: BoardDensity;
  onMenuMove: (task: Task, newStatus: TaskStatus) => void;
  focusedCardId: string | null;
  onCardFocus: (taskId: string, status: TaskStatus, phaseId: string) => void;
  onShowDeps: (task: Task) => void;
  onShowRisks: (task: Task) => void;
  onCardClick: (task: Task, anchor: HTMLElement) => void;
  showEvm: EvmMode;
  showCost: boolean;
  cardCustomFieldDefs: ProjectCustomField[];
  /** Board-wide readiness-chip gate (#2430). */
  showReadiness: boolean;
  scopeActions: BoardCardScopeActions;
  readOnly: boolean;
  facetMatchIds: Set<string> | null;

  // Desktop grid chrome
  setBoardScrollEl: (el: HTMLDivElement | null) => void;
  isBoardPanArmed: boolean;
  isBoardPanning: boolean;
  zoomVars: CSSProperties;
  hasScrollBelow: boolean;
  hasScrollRight: boolean;
  collapsedColumns: Set<TaskStatus>;
  columnWidths: Record<string, number>;
  totalByStatus: Record<TaskStatus, number>;
  myCountByStatus: Record<TaskStatus, number>;
  showWip: boolean;
  wipTrendSeriesByStatus: Partial<Record<TaskStatus, number[]>>;
  onToggleColumn: (status: TaskStatus) => void;
  onResizeColumn: (status: TaskStatus, px: number) => void;

  // Lanes
  lanes: LaneShape[];
  renderLane: (lane: LaneShape) => ReactNode;
  workshopMode: boolean;
  onAddPhase: () => void;
  isAddingPhase: boolean;
  mineActive: boolean;
  onShowAllTasks: () => void;
  onAddTask: () => void;
}

/**
 * The board body: the backlog surface (rail | drawer | queue) plus the scrolling
 * phase grid. The rail sits left of the grid (flex-row); the drawer sits above
 * it (flex-col, full width); the queue replaces both. Layout is persisted via
 * `useBoardToolbarPrefs` (ADR-0057 / epic #361).
 */
export function BoardBody(props: BoardBodyProps) {
  const {
    projectId,
    facetZeroMatch,
    effectiveLayout,
    isMobile,
    columns: COLUMNS,
    methodology,
    boardCadence,
    queueTasks,
    phaseNameFor,
    phaseColorFor,
    canReorder,
    onReorderGroup,
    backlogTasks,
    isDragActive,
    isBacklogOver,
    backlogDensity,
    onSchedule,
    onQuickCapture,
    isQuickCapturePending,
    onCaptureIdea,
    onOpenCommandPalette,
    mobileTasksByStatus,
    onActiveStatusChange,
    density,
    onMenuMove,
    focusedCardId,
    onCardFocus,
    onShowDeps,
    onShowRisks,
    onCardClick,
    showEvm,
    showCost,
    cardCustomFieldDefs,
    showReadiness,
    scopeActions,
    readOnly,
    facetMatchIds,
    setBoardScrollEl,
    isBoardPanArmed,
    isBoardPanning,
    zoomVars,
    hasScrollBelow,
    hasScrollRight,
    collapsedColumns,
    columnWidths,
    totalByStatus,
    myCountByStatus,
    showWip,
    wipTrendSeriesByStatus,
    onToggleColumn,
    onResizeColumn,
    lanes,
    renderLane,
    workshopMode,
    onAddPhase,
    isAddingPhase,
    mineActive,
    onShowAllTasks,
    onAddTask,
  } = props;
  return (
    <>
      {/* Body — backlog surface (rail | drawer | queue) + scrolling phase
          grid. The rail sits left of the grid (flex-row); the drawer sits
          above it (flex-col, full width); the queue replaces both.
          Layout is persisted via `useBoardToolbarPrefs` (ADR-0057 / epic #361). */}
      {!facetZeroMatch && effectiveLayout === 'queue' && (
        <QueueLayout
          tasks={queueTasks}
          phaseNameFor={phaseNameFor}
          phaseColorFor={phaseColorFor}
          focusedCardId={focusedCardId}
          onCardFocus={onCardFocus}
          onCardClick={onCardClick}
          canReorder={canReorder}
          onReorderGroup={onReorderGroup}
          header={
            projectId ? (
              <SprintPanel
                projectId={projectId}
                methodology={methodology}
                boardCadence={boardCadence}
              />
            ) : null
          }
        />
      )}
      {effectiveLayout === 'drawer' && (
        <BacklogDrawer
          tasks={backlogTasks}
          isDragActive={isDragActive}
          isOver={isBacklogOver}
          density={backlogDensity}
          phaseColorFor={phaseColorFor}
          focusedCardId={focusedCardId}
          onCardFocus={onCardFocus}
          onCardClick={onCardClick}
          readOnly={readOnly}
        />
      )}
      {/* Mobile snap-scroll board (v3 case 8). On phones the phase ×
          status grid is unreadable, so each status column becomes a
          full-width snap page with a dot-strip nav. Gated behind `isMobile`
          so the desktop layout below is unchanged. The backlog band/drawer
          is suppressed here — the FAB + card menus cover capture/move on a
          phone, and the strip owns the horizontal axis. Queue layout keeps
          its own (already mobile-friendly) flat list above. */}
      {!facetZeroMatch && effectiveLayout !== 'queue' && isMobile && (
        <MobileBoard
          columns={COLUMNS}
          tasksByStatus={mobileTasksByStatus}
          density={density}
          onMenuMove={onMenuMove}
          focusedCardId={focusedCardId}
          onCardFocus={onCardFocus}
          onShowDeps={onShowDeps}
          onShowRisks={onShowRisks}
          onCardClick={onCardClick}
          showEvm={showEvm}
          showCost={showCost}
          customFieldDefs={cardCustomFieldDefs}
          showReadiness={showReadiness}
          scopeActions={scopeActions}
          readOnly={readOnly}
          wipTrendSeriesByStatus={wipTrendSeriesByStatus}
          onActiveStatusChange={onActiveStatusChange}
          facetMatchIds={facetMatchIds}
        />
      )}
      {!facetZeroMatch && effectiveLayout !== 'queue' && !isMobile && (
        <BoardDesktopGrid
          showBacklogRail={effectiveLayout === 'rail'}
          backlogTasks={backlogTasks}
          isDragActive={isDragActive}
          isBacklogOver={isBacklogOver}
          backlogDensity={backlogDensity}
          phaseColorFor={phaseColorFor}
          focusedCardId={focusedCardId}
          onCardFocus={onCardFocus}
          onCardClick={onCardClick}
          onSchedule={projectId ? onSchedule : undefined}
          onQuickCapture={projectId && !readOnly ? onQuickCapture : undefined}
          isQuickCapturePending={isQuickCapturePending}
          onCaptureIdea={onCaptureIdea}
          onOpenCommandPalette={onOpenCommandPalette}
          readOnly={readOnly}
          projectId={projectId}
          methodology={methodology}
          boardCadence={boardCadence}
          setBoardScrollEl={setBoardScrollEl}
          isBoardPanArmed={isBoardPanArmed}
          isBoardPanning={isBoardPanning}
          zoomVars={zoomVars}
          hasScrollBelow={hasScrollBelow}
          hasScrollRight={hasScrollRight}
          columns={COLUMNS}
          collapsedColumns={collapsedColumns}
          columnWidths={columnWidths}
          totalByStatus={totalByStatus}
          myCountByStatus={myCountByStatus}
          showWip={showWip}
          wipTrendSeriesByStatus={wipTrendSeriesByStatus}
          onToggleColumn={onToggleColumn}
          onResizeColumn={onResizeColumn}
          lanes={lanes}
          renderLane={renderLane}
          workshopMode={workshopMode}
          onAddPhase={onAddPhase}
          isAddingPhase={isAddingPhase}
          mineActive={mineActive}
          onShowAllTasks={onShowAllTasks}
          onAddTask={onAddTask}
        />
      )}
    </>
  );
}

type BoardDesktopGridProps = Omit<
  BoardBodyProps,
  | 'facetZeroMatch'
  | 'effectiveLayout'
  | 'isMobile'
  | 'queueTasks'
  | 'phaseNameFor'
  | 'canReorder'
  | 'onReorderGroup'
  | 'mobileTasksByStatus'
  | 'onActiveStatusChange'
  | 'density'
  | 'onMenuMove'
  | 'onShowDeps'
  | 'onShowRisks'
  | 'showEvm'
  | 'showCost'
  | 'cardCustomFieldDefs'
  | 'showReadiness'
  | 'scopeActions'
  | 'facetMatchIds'
> & { showBacklogRail: boolean };

/**
 * The desktop phase grid: the optional backlog rail beside a scrollable
 * phase × status matrix. `setBoardScrollEl` plus the grab/grabbing cursor
 * classes wire Space-held drag-panning (issue 1265); `select-none` while panning
 * stops text selection mid-drag. The `relative` wrapper hosts the edge-fade
 * overflow cues (#1962 / #1972).
 */
function BoardDesktopGrid({
  showBacklogRail,
  backlogTasks,
  isDragActive,
  isBacklogOver,
  backlogDensity,
  phaseColorFor,
  focusedCardId,
  onCardFocus,
  onCardClick,
  onSchedule,
  onQuickCapture,
  isQuickCapturePending,
  onCaptureIdea,
  onOpenCommandPalette,
  readOnly,
  projectId,
  methodology,
  boardCadence,
  setBoardScrollEl,
  isBoardPanArmed,
  isBoardPanning,
  zoomVars,
  hasScrollBelow,
  hasScrollRight,
  columns: COLUMNS,
  collapsedColumns,
  columnWidths,
  totalByStatus,
  myCountByStatus,
  showWip,
  wipTrendSeriesByStatus,
  onToggleColumn,
  onResizeColumn,
  lanes,
  renderLane,
  workshopMode,
  onAddPhase,
  isAddingPhase,
  mineActive,
  onShowAllTasks,
  onAddTask,
}: BoardDesktopGridProps) {
  return (
    <div className="flex-1 flex flex-row min-h-0">
      {showBacklogRail && (
        <BacklogBand
          tasks={backlogTasks}
          isDragActive={isDragActive}
          isOver={isBacklogOver}
          density={backlogDensity}
          phaseColorFor={phaseColorFor}
          focusedCardId={focusedCardId}
          onCardFocus={onCardFocus}
          onCardClick={onCardClick}
          onSchedule={projectId ? onSchedule : undefined}
          onQuickCapture={projectId && !readOnly ? onQuickCapture : undefined}
          isQuickCapturePending={isQuickCapturePending}
          onCaptureIdea={onCaptureIdea}
          isCaptureIdeaPending={false}
          onOpenCommandPalette={onOpenCommandPalette}
          readOnly={readOnly}
        />
      )}

      {/* Board grid — scrollable. `setBoardScrollEl` + the grab/grabbing
          cursor classes wire Space-held drag-panning (issue 1265);
          `select-none` while panning stops text selection mid-drag. The
          `relative` wrapper hosts the bottom edge-fade overflow cue
          (#1962) — the vertical analog of ShellNavScroller (rule 174). */}
      <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
        <div
          ref={setBoardScrollEl}
          data-testid="board-scroll"
          data-space-panning={isBoardPanning ? 'true' : undefined}
          // pb-6 / pr-6 keep the final lane's tallest card and the
          // rightmost (DONE) column off the scroll fold (#1963 / #1972):
          // a card sheared flush at the viewport edge reads as truncated,
          // not scrollable. The trailing gutters — paired with the #1962
          // bottom edge-fade and the #1972 right edge-fade — are the "keep
          // scrolling" signal on both axes. The fixed-track grid overflows
          // horizontally by design (boardGrid.ts), so the right gutter is
          // the horizontal analog of the vertical breathing room.
          className={`flex-1 overflow-auto min-h-0 pb-6 pr-6 bg-neutral-surface-sunken${
            isBoardPanArmed
              ? isBoardPanning
                ? ' cursor-grabbing select-none'
                : ' cursor-grab'
              : ''
          }`}
          // Board zoom CSS vars (issue 379) — cascade to the column-header / lane /
          // phase-rail grids and the column card-stacks below.
          style={zoomVars}
        >
          {/* Active-sprint summary (ADR-0073) — rendered inside the scroll
        container so the burndown / velocity charts scroll away with
        the board instead of permanently consuming vertical space.
        Hidden entirely on WATERFALL projects and on projects with
        no active sprint. */}
          {projectId && (
            <SprintPanel
              projectId={projectId}
              methodology={methodology}
              boardCadence={boardCadence}
            />
          )}
          {/* Flow analytics (ADR-0137, issue 1188) — collapsed by default;
        team-private behind the ADR-0104 flow_metrics signal. */}
          {projectId && <FlowAnalyticsPanel projectId={projectId} boardCadence={boardCadence} />}
          <BoardColumnHeaderRow
            columns={COLUMNS}
            collapsedColumns={collapsedColumns}
            columnWidths={columnWidths}
            totalByStatus={totalByStatus}
            myCountByStatus={myCountByStatus}
            laneCount={lanes.length}
            showWip={showWip}
            trendSeriesByStatus={wipTrendSeriesByStatus}
            onToggleColumn={onToggleColumn}
            onResizeColumn={onResizeColumn}
          />

          <BoardPhaseLanes
            lanes={lanes}
            renderLane={renderLane}
            workshopMode={workshopMode}
            onAddPhase={onAddPhase}
            isAddingPhase={isAddingPhase}
            mineActive={mineActive}
            onShowAllTasks={onShowAllTasks}
            canCreate={Boolean(projectId)}
            onAddTask={onAddTask}
          />
        </div>
        {/* Bottom edge-fade — the "more below" cue for vertical overflow
          (#1962). Decorative (rule 6): the column-header aria-label counts
          (rule 101) already announce the true totals to screen readers.
          Rendered only while content sits below the fold. */}
        {hasScrollBelow && (
          <span
            aria-hidden="true"
            data-testid="board-scroll-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-neutral-surface-sunken to-transparent"
          />
        )}
        {/* Right edge-fade — the "more to the right" cue for horizontal
          overflow (#1972), the horizontal analog of the bottom fade
          above. The fixed-track grid overflows its scroll container by
          design (boardGrid.ts), so the rightmost DONE column shears
          flush at the viewport edge with no scroll affordance on
          auto-hiding-scrollbar platforms (macOS/touch). Decorative (rule
          6): the column-header aria-labels (rule 101) already announce
          the true per-column totals. Rendered only while content sits to
          the right of the current scroll position. */}
        {hasScrollRight && (
          <span
            aria-hidden="true"
            data-testid="board-scroll-fade-right"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-neutral-surface-sunken to-transparent"
          />
        )}
      </div>
    </div>
  );
}
