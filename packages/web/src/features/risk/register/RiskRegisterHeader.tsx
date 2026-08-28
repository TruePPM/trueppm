import { type RefObject } from 'react';
import type { Risk } from '@/api/types';
import { exportRisksToCSV } from '../riskExport';
import { useDownloadAnnouncer } from '@/hooks/useDownloadAnnouncer';
import type { SeveritySort } from '../riskFilters';

/**
 * At-a-glance register summary (issue 1230): total logged, high-and-above, and
 * unmitigated. Suppressed while loading / on error / empty.
 */
function RegisterSummaryLine({
  ready,
  total,
  highAndAboveCount,
  unmitigatedCount,
}: {
  ready: boolean;
  total: number;
  highAndAboveCount: number;
  unmitigatedCount: number;
}) {
  if (!ready) return null;
  return (
    <p className="text-xs text-neutral-text-secondary">
      {total} in register
      <span aria-hidden="true"> · </span>
      {highAndAboveCount} high
      <span aria-hidden="true"> · </span>
      {unmitigatedCount} unmitigated
    </p>
  );
}

/** Critical / high count chips. Each hides at zero — a chip reading "0" is noise. */
function SeverityCountChips({
  ready,
  criticalCount,
  highCount,
}: {
  ready: boolean;
  criticalCount: number;
  highCount: number;
}) {
  if (!ready) return null;
  return (
    <>
      {criticalCount > 0 && (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-semantic-critical text-white"
          aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
        >
          {criticalCount} critical
        </span>
      )}
      {highCount > 0 && (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium
                bg-brand-accent-dark text-white"
          aria-label={`${highCount} high risk${highCount !== 1 ? 's' : ''}`}
        >
          {highCount} high
        </span>
      )}
    </>
  );
}

interface RiskRegisterHeaderProps {
  projectName: string | null;
  risks: Risk[];
  isLoading: boolean;
  error: Error | null;
  canImport: boolean;
  criticalCount: number;
  highCount: number;
  highAndAboveCount: number;
  unmitigatedCount: number;
  projectSlug: string;
  displayRisks: Risk[];
  isLowHidden: boolean;
  onToggleLowSeverity: () => void;
  newestSort: boolean;
  onNewestSortChange: (next: boolean) => void;
  onSeveritySortChange: (next: SeveritySort) => void;
  showHeatmap: boolean;
  onToggleHeatmap: () => void;
  onOpenImport: () => void;
  onCreate: () => void;
  isOverflowOpen: boolean;
  onToggleOverflow: () => void;
  onCloseOverflow: () => void;
  overflowRef: RefObject<HTMLDivElement | null>;
}

/**
 * The register's page header: breadcrumb, heading, the at-a-glance summary line,
 * the desktop toolbar (count chips, display toggles, heatmap, import, new risk)
 * and the < md overflow menu that carries import/export below the breakpoint.
 */
export function RiskRegisterHeader({
  projectName,
  risks,
  isLoading,
  error,
  canImport,
  criticalCount,
  highCount,
  highAndAboveCount,
  unmitigatedCount,
  projectSlug,
  displayRisks,
  isLowHidden,
  onToggleLowSeverity,
  newestSort,
  onNewestSortChange,
  onSeveritySortChange,
  showHeatmap,
  onToggleHeatmap,
  onOpenImport,
  onCreate,
  isOverflowOpen,
  onToggleOverflow,
  onCloseOverflow,
  overflowRef,
}: RiskRegisterHeaderProps) {
  // Rule 297. Both export buttons below (toolbar + overflow menu) hand off to
  // exportRisksToCSV, which owns its own local-day filename — so this announces
  // beside the helper rather than wrapping it (#2943).
  const { announce: announceDownload, region: downloadRegion } = useDownloadAnnouncer();
  return (
    <>
      {downloadRegion}
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
        {/* Breadcrumb + heading */}
        <div className="min-w-0 flex flex-col gap-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary"
          >
            <span className="truncate">{projectName ?? 'Project'}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">
              /
            </span>
            <span>Risks</span>
          </nav>
          <h1 className="text-2xl font-semibold text-neutral-text-primary leading-tight">
            Risk register
          </h1>
          {/* At-a-glance register summary (issue 1230): total logged, high-and-above,
              and unmitigated. Suppressed while loading / on error / empty. */}
          <RegisterSummaryLine
            ready={!isLoading && !error && risks.length > 0}
            total={risks.length}
            highAndAboveCount={highAndAboveCount}
            unmitigatedCount={unmitigatedCount}
          />
        </div>

        {/* Desktop toolbar — count chips + heatmap toggle + new risk */}
        <div className="hidden md:flex items-center gap-2 shrink-0 pt-1">
          <SeverityCountChips
            ready={!isLoading && !error}
            criticalCount={criticalCount}
            highCount={highCount}
          />

          {/* Display — client-side severity-band visibility toggle (persisted).
              Hides low-severity rows from the table to declutter the register. */}
          <label
            className="inline-flex items-center gap-2 h-8 px-3 rounded-control text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised cursor-pointer
              focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1"
          >
            <input
              type="checkbox"
              checked={isLowHidden}
              onChange={onToggleLowSeverity}
              className="h-3.5 w-3.5 rounded-chip border-neutral-border accent-brand-primary
                focus-visible:outline-none"
            />
            Hide low severity
          </label>

          {/* Newest sort (issue 1230) — created_at descending. A toggle, not a
              cycle: turning it on resets the severity column sort so only one
              ordering governs the table. */}
          <button
            type="button"
            onClick={() => {
              const next = !newestSort;
              onNewestSortChange(next);
              // Turning Newest on resets the severity column sort so only one
              // ordering ever governs the table.
              if (next) onSeveritySortChange('none');
            }}
            aria-pressed={newestSort}
            className={[
              'inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium',
              // Standalone toggle/trigger buttons in this toolbar use focus: (not
              // focus-visible:) so the ring shows on pointer-initiated focus in
              // Firefox/Safari (rule 214, WCAG 2.4.7).
              'border focus:outline-none focus:ring-2 focus:ring-brand-primary',
              'focus:ring-offset-1',
              newestSort
                ? 'border-brand-primary/40 bg-brand-primary/10 text-brand-primary'
                : 'border-neutral-border text-neutral-text-primary bg-neutral-surface hover:bg-neutral-surface-raised',
            ].join(' ')}
          >
            Newest
          </button>

          <button
            type="button"
            onClick={onToggleHeatmap}
            aria-pressed={showHeatmap}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            Heatmap
            <span
              aria-hidden="true"
              className="text-neutral-text-disabled text-xs leading-none mt-px"
            >
              ▾
            </span>
          </button>

          {/* Import CSV (issue 223) — write-gated (Member+); not gated on risks.length
              so an empty register can be seeded from a file. */}
          {canImport && (
            <button
              type="button"
              onClick={onOpenImport}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
                border border-neutral-border text-neutral-text-secondary bg-neutral-surface
                hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
            >
              Import CSV
            </button>
          )}

          {risks.length > 0 && (
            <button
              type="button"
              onClick={() => {
              exportRisksToCSV(displayRisks, projectSlug);
              announceDownload(`${displayRisks.length} risks downloaded as CSV.`);
            }}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-xs font-medium
                border border-neutral-border text-neutral-text-secondary bg-neutral-surface
                hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
            >
              Export CSV
            </button>
          )}

          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-1 h-8 px-3 rounded-control text-sm font-medium
              text-neutral-text-inverse bg-brand-primary border border-brand-primary-dark
              hover:bg-brand-primary-dark
              focus:outline-none focus:ring-2 focus:ring-brand-primary
              focus:ring-offset-1"
          >
            + New risk
          </button>
        </div>

        <RiskOverflowMenu
          risks={risks}
          canImport={canImport}
          displayRisks={displayRisks}
          projectSlug={projectSlug}
          isOverflowOpen={isOverflowOpen}
          onToggleOverflow={onToggleOverflow}
          onCloseOverflow={onCloseOverflow}
          onOpenImport={onOpenImport}
          overflowRef={overflowRef}
        />
      </header>
    </>
  );
}

interface RiskCountPillsProps {
  isLoading: boolean;
  error: unknown;
  criticalCount: number;
  highCount: number;
}

/** Mobile-only count pill row — the desktop toolbar is hidden < md. */
export function RiskCountPills({
  isLoading,
  error,
  criticalCount,
  highCount,
}: RiskCountPillsProps) {
  if (isLoading || error || (criticalCount === 0 && highCount === 0)) return null;
  return (
    <div className="md:hidden flex items-center gap-2 px-6 pb-3 shrink-0">
      <SeverityCountChips ready criticalCount={criticalCount} highCount={highCount} />
    </div>
  );
}

type RiskOverflowMenuProps = Pick<
  RiskRegisterHeaderProps,
  | 'risks'
  | 'canImport'
  | 'displayRisks'
  | 'projectSlug'
  | 'isOverflowOpen'
  | 'onToggleOverflow'
  | 'onCloseOverflow'
  | 'onOpenImport'
  | 'overflowRef'
>;

/**
 * The < md overflow menu. Below the breakpoint the desktop toolbar is hidden,
 * so import (Member+) and export live here instead (ADR-0043).
 */
function RiskOverflowMenu({
  risks,
  canImport,
  displayRisks,
  projectSlug,
  isOverflowOpen,
  onToggleOverflow,
  onCloseOverflow,
  onOpenImport,
  overflowRef,
}: RiskOverflowMenuProps) {
  // Rule 297, again — this menu is the second export button in the file, and "a
  // second download button added to the same file without one" is the exact case the
  // rule was written down for. Its own component, so its own region (#2943).
  const { announce: announceDownload, region: downloadRegion } = useDownloadAnnouncer();
  return (
    <>
      {downloadRegion}
      {/* Mobile overflow menu (< md) — exposes Import (issue 223, Member+) and
            Export CSV (ADR-0043) and other low-frequency actions. Rendered when
            either action is available so import is reachable on an empty register. */}
      {(risks.length > 0 || canImport) && (
        <div ref={overflowRef} className="md:hidden relative shrink-0 pt-1">
          <button
            type="button"
            onClick={onToggleOverflow}
            aria-haspopup="menu"
            aria-expanded={isOverflowOpen}
            aria-label="More actions"
            className="inline-flex items-center justify-center w-10 h-10 rounded-control
                text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:ring-2 focus:ring-brand-primary
                focus:ring-offset-1"
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ⋯
            </span>
          </button>
          {isOverflowOpen && (
            <div
              role="menu" // dropdown-scroll-ok: 2 fixed items (Import/Export CSV)
              className="absolute right-0 top-11 min-w-[180px] z-30 rounded-card
                  bg-neutral-surface border border-neutral-border py-1"
            >
              {canImport && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onOpenImport();
                    onCloseOverflow();
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:bg-neutral-surface-raised"
                >
                  Import CSV
                </button>
              )}
              {risks.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    exportRisksToCSV(displayRisks, projectSlug);
                    announceDownload(`${displayRisks.length} risks downloaded as CSV.`);
                    onCloseOverflow();
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-neutral-text-primary
                      hover:bg-neutral-surface-raised
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset focus:bg-neutral-surface-raised"
                >
                  Export CSV
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
