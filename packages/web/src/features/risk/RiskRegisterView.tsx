import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Risk } from '@/api/types';
import { useProjectId } from '@/hooks/useProjectId';
import { RiskImportModal } from './RiskImportModal';
import { PencilIcon } from '@/components/Icons';
import { RiskChip } from './RiskChip';
import { RiskMatrix } from './RiskMatrix';
import { RiskDrawer } from './RiskDrawer';
import { type RiskFilter, isUnmitigated } from './riskFilters';
import { localTodayIso } from '@/lib/localDate';
import { useRiskRegister } from './register/useRiskRegister';
import { RiskCountPills, RiskRegisterHeader } from './register/RiskRegisterHeader';
import { RiskTablePanel } from './register/RiskTablePanel';

const FILTER_EMPTY_COPY: Record<Exclude<RiskFilter, 'all'>, string> = {
  high: 'No high-severity risks.',
  unmitigated: 'No unmitigated risks — every risk is resolved, accepted, or closed.',
  mine: 'None of the risks are assigned to you.',
};

const STATUS_LABELS: Record<Risk['status'], string> = {
  OPEN: 'Open',
  MITIGATING: 'Mitigating',
  RESOLVED: 'Resolved',
  ACCEPTED: 'Accepted',
  CLOSED: 'Closed',
};

/**
 * One risk row in the register table. Extracted so the register component stays
 * flat — the per-row overdue/unmitigated/owner branching is the table's deepest
 * nesting and belongs with the row it renders. Renders identical markup to the
 * inline row it replaced (DOM, ARIA, and handlers unchanged).
 */
function RiskTableRow({
  risk,
  todayIso,
  onOpen,
  onEdit,
}: {
  risk: Risk;
  todayIso: string;
  onOpen: (risk: Risk) => void;
  onEdit: (risk: Risk) => void;
}) {
  const isOverdue =
    risk.status === 'MITIGATING' &&
    !!risk.mitigation_due_date &&
    risk.mitigation_due_date < todayIso;
  // Always-on signal for live threats. Overdue is a strict subset of
  // unmitigated, so an overdue row layers the louder bg fill over this left
  // accent border.
  const unmitigated = isUnmitigated(risk);

  return (
    <tr
      onClick={() => onOpen(risk)}
      className={[
        'group h-14 border-b border-neutral-border last:border-b-0 cursor-pointer',
        unmitigated ? 'border-l-2 border-l-semantic-at-risk/40' : '',
        isOverdue
          ? 'bg-semantic-at-risk-bg hover:bg-semantic-at-risk/10'
          : 'hover:bg-neutral-surface-raised',
        // Row acts as a button: focus: (not focus-visible:) so the
        // ring shows on pointer-initiated focus in Firefox/Safari
        // (rule 214, WCAG 2.4.7). ring-inset — row lives in a scroll area.
        'focus:outline-none focus:ring-2 focus:ring-brand-primary',
        'focus:ring-inset',
      ].join(' ')}
      tabIndex={0}
      role="button"
      aria-label={`Open risk: ${risk.title}${isOverdue ? ' (overdue mitigation)' : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(risk);
        }
      }}
    >
      {/* ID — server-formatted (#929); the client no longer
        derives it from the raw short_id. */}
      <td className="px-4 text-xs text-neutral-text-secondary tppm-mono">
        {risk.short_id_display}
      </td>

      {/* Risk — title + status sub-label + overdue badge */}
      <td className="px-4">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium text-neutral-text-primary leading-snug truncate">
            {risk.title}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-neutral-text-secondary leading-none">
            {STATUS_LABELS[risk.status]}
            {isOverdue && (
              <span
                className="inline-flex items-center rounded-chip px-1.5 py-0.5 text-xs font-medium
                                bg-semantic-at-risk-bg text-semantic-at-risk border border-semantic-at-risk/30"
              >
                Overdue
              </span>
            )}
          </span>
        </div>
      </td>

      {/* P */}
      <td className="px-3 text-center text-xs text-neutral-text-secondary tabular-nums">
        {risk.probability}
      </td>

      {/* I */}
      <td className="px-3 text-center text-xs text-neutral-text-secondary tabular-nums">
        {risk.impact}
      </td>

      {/* Severity chip */}
      <td className="px-4">
        <RiskChip severity={risk.severity} showScore />
      </td>

      {/* Owner — initials avatar + display name (design conformance) */}
      <td className="px-4">
        {risk.owner ? (
          <span className="flex items-center gap-2 min-w-0">
            <span
              className="inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0
                                bg-neutral-surface-sunken border border-neutral-border
                                text-xs font-semibold text-neutral-text-primary tppm-mono"
              aria-hidden="true"
            >
              {risk.owner_initials ?? '?'}
            </span>
            <span className="text-xs text-neutral-text-secondary truncate">
              {risk.owner_name ?? 'Assigned'}
            </span>
          </span>
        ) : (
          <span className="text-xs text-neutral-text-disabled" aria-label="Unassigned">
            —
          </span>
        )}
      </td>

      {/* Quick-edit affordance — visible on hover/focus-within (ADR-0044) on
          desktop; always visible and a 44px target below `md` (touch has no
          hover — rule 247). */}
      <td className="px-2 text-center">
        <button
          type="button"
          aria-label={`Edit risk: ${risk.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onEdit(risk);
          }}
          className="opacity-0 max-md:opacity-100 group-hover:opacity-100 focus:opacity-100
                            h-11 w-11 md:h-8 md:w-8 flex items-center justify-center rounded-control
                            text-neutral-text-secondary hover:text-neutral-text-primary
                            focus:outline-none focus:ring-2
                            focus:ring-brand-primary focus:ring-offset-1"
        >
          <PencilIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

/**
 * Closes an open menu on an outside pointer-down or Escape. Extracted from the
 * register so its listener wiring lives in one focused hook; behavior is
 * unchanged (mousedown + keydown listeners attached only while `open`).
 */
function useDismissOnOutside<T extends HTMLElement>(
  open: boolean,
  ref: RefObject<T | null>,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onDismiss]);
}

export function RiskRegisterView() {
  const projectId = useProjectId() ?? '';
  const {
    risks,
    isLoading,
    error,
    canImport,
    projectName,
    projectSlug,
    filter,
    setFilter,
    severitySort,
    setSeveritySort,
    newestSort,
    setNewestSort,
    selectedCell,
    setSelectedCell,
    toggleSeverityBand,
    isLowHidden,
    criticalCount,
    highCount,
    highAndAboveCount,
    unmitigatedCount,
    filterCounts,
    displayRisks,
    isFiltered,
    clearAllFilters,
    selectedRisk,
    editMode,
    isDrawerOpen,
    openCreate,
    openRisk,
    openRiskEdit,
    closeDrawer,
  } = useRiskRegister(projectId);

  const [isImportOpen, setIsImportOpen] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);

  // Mobile overflow menu (… button) — exposes Export CSV on viewports < md (ADR-0043)
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const closeOverflow = useCallback(() => setIsOverflowOpen(false), []);
  useDismissOnOutside(isOverflowOpen, overflowRef, closeOverflow);

  // Overdue: MITIGATING status + mitigation_due_date in the past (client-side, ADR-0043)
  const todayIso = localTodayIso();

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-app-canvas">
        <p className="text-sm text-neutral-text-secondary">Select a project to view risks.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-app-canvas">
      <RiskRegisterHeader
        projectName={projectName}
        risks={risks}
        isLoading={isLoading}
        error={error}
        canImport={canImport}
        criticalCount={criticalCount}
        highCount={highCount}
        highAndAboveCount={highAndAboveCount}
        unmitigatedCount={unmitigatedCount}
        projectSlug={projectSlug}
        displayRisks={displayRisks}
        isLowHidden={isLowHidden}
        onToggleLowSeverity={() => toggleSeverityBand('low')}
        newestSort={newestSort}
        onNewestSortChange={setNewestSort}
        onSeveritySortChange={setSeveritySort}
        showHeatmap={showHeatmap}
        onToggleHeatmap={() => setShowHeatmap((v) => !v)}
        onOpenImport={() => setIsImportOpen(true)}
        onCreate={openCreate}
        isOverflowOpen={isOverflowOpen}
        onToggleOverflow={() => setIsOverflowOpen((v) => !v)}
        onCloseOverflow={closeOverflow}
        overflowRef={overflowRef}
      />

      <RiskCountPills
        isLoading={isLoading}
        error={error}
        criticalCount={criticalCount}
        highCount={highCount}
      />

      {/* ── Two-column content ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex gap-4 px-6 pb-6 overflow-hidden">
        {/* Left — heatmap card (lg+, togglable) */}
        {showHeatmap && (
          <aside
            className="hidden lg:flex flex-col shrink-0 w-[440px]
              border border-neutral-border rounded-card p-5
              bg-neutral-surface overflow-auto"
            aria-label="Risk heatmap"
          >
            {isLoading && (
              <div
                className="flex-1 rounded-card motion-safe:animate-pulse bg-neutral-border/30"
                aria-hidden="true"
              />
            )}
            {!isLoading && !error && (
              <RiskMatrix
                risks={risks}
                selectedCell={selectedCell}
                onCellSelect={setSelectedCell}
              />
            )}
          </aside>
        )}

        <RiskTablePanel
          risks={risks}
          displayRisks={displayRisks}
          isLoading={isLoading}
          error={error}
          canImport={canImport}
          onOpenImport={() => setIsImportOpen(true)}
          onCreate={openCreate}
          filter={filter}
          onFilterChange={setFilter}
          filterCounts={filterCounts}
          filterEmptyCopy={FILTER_EMPTY_COPY}
          selectedCell={selectedCell}
          onClearCell={() => setSelectedCell(null)}
          isFiltered={isFiltered}
          onClearAllFilters={clearAllFilters}
          severitySort={severitySort}
          onSeveritySortChange={setSeveritySort}
          newestSort={newestSort}
          onNewestSortChange={setNewestSort}
          renderRow={(risk) => (
            <RiskTableRow
              key={risk.id}
              risk={risk}
              todayIso={todayIso}
              onOpen={openRisk}
              onEdit={openRiskEdit}
            />
          )}
        />

        {/* Drawer — rendered as a flex sibling so the desktop variant
            (`flex w-[480px]`, RiskDrawer.tsx) lays out alongside the table
            column instead of stacking below the page (rule 89). RiskDrawer
            renders one shell per breakpoint; the mobile bottom sheet uses
            `fixed` positioning so it is unaffected by this flex row. */}
        {isDrawerOpen && (
          <RiskDrawer
            projectId={projectId}
            risk={selectedRisk ?? null}
            isOpen={isDrawerOpen}
            onClose={closeDrawer}
            initialEditing={editMode}
          />
        )}
      </div>

      {/* Mobile FAB (rule 90) */}
      <button
        type="button"
        onClick={openCreate}
        className="md:hidden fixed bottom-16 right-4 w-14 h-14 rounded-full
          bg-brand-primary border border-brand-primary-dark
          flex items-center justify-center
          focus:outline-none focus:ring-2 focus:ring-brand-primary
          focus:ring-offset-2
          z-20"
        aria-label="Add risk"
      >
        <span className="text-neutral-text-inverse text-2xl leading-none" aria-hidden="true">
          +
        </span>
      </button>

      {/* Import-from-CSV modal (issue 223) — write-gated open trigger; the modal
          itself owns the upload → result state machine. */}
      {isImportOpen && (
        <RiskImportModal projectId={projectId} onClose={() => setIsImportOpen(false)} />
      )}
    </div>
  );
}
