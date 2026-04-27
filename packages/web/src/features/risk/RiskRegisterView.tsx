import { useState } from 'react';
import type { Risk } from '@/api/types';
import { useRisks } from '@/hooks/useRisks';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';
import { RiskChip } from './RiskChip';
import { RiskMatrix } from './RiskMatrix';
import { RiskDrawer } from './RiskDrawer';

const STATUS_LABELS: Record<Risk['status'], string> = {
  OPEN:       'Open',
  MITIGATING: 'Mitigating',
  RESOLVED:   'Resolved',
  ACCEPTED:   'Accepted',
  CLOSED:     'Closed',
};

/** Format a Risk's short_id for display: "00000007" → "R-007", "a3f1" → "R-A3F1". */
function formatRiskId(shortId: string): string {
  if (!shortId) return 'R-???';
  if (/^\d+$/.test(shortId)) {
    return `R-${String(parseInt(shortId, 10)).padStart(3, '0')}`;
  }
  return `R-${shortId.slice(0, 4).toUpperCase()}`;
}

export function RiskRegisterView() {
  const projectId = useProjectId() ?? '';
  const { risks, isLoading, error } = useRisks(projectId || null);
  const { data: projects } = useProjects();
  const [showHeatmap, setShowHeatmap] = useState(true);

  // null = drawer closed, undefined = create mode, Risk = edit mode
  const [selectedRisk, setSelectedRisk] = useState<Risk | null | undefined>(null);

  const projectName = projects?.find((p) => p.id === projectId)?.name ?? null;

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-neutral-text-secondary">Select a project to view risks.</p>
      </div>
    );
  }

  const isDrawerOpen = selectedRisk !== null;
  const criticalCount = risks.filter((r) => r.severity >= 20).length;
  const highCount     = risks.filter((r) => r.severity >= 12 && r.severity < 20).length;

  function openCreate() { setSelectedRisk(undefined); }
  function openRisk(risk: Risk) { setSelectedRisk(risk); }
  function closeDrawer() { setSelectedRisk(null); }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-neutral-surface">

      {/* ── Page header ──────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 shrink-0">
        {/* Breadcrumb + heading */}
        <div className="min-w-0 flex flex-col gap-1">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
            <span className="truncate">{projectName ?? 'Project'}</span>
            <span aria-hidden="true" className="text-neutral-text-disabled">/</span>
            <span>Risks</span>
          </nav>
          <h1 className="text-2xl font-semibold text-neutral-text-primary leading-tight">
            Risk register
          </h1>
        </div>

        {/* Desktop toolbar — count chips + heatmap toggle + new risk */}
        <div className="hidden md:flex items-center gap-2 shrink-0 pt-1">
          {!isLoading && !error && criticalCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                bg-transparent border border-semantic-critical/40 text-semantic-critical"
              aria-label={`${criticalCount} critical risk${criticalCount !== 1 ? 's' : ''}`}
            >
              {criticalCount} critical
            </span>
          )}
          {!isLoading && !error && highCount > 0 && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                bg-transparent border border-brand-accent-dark/40 dark:border-brand-accent/40
                text-brand-accent-dark dark:text-brand-accent"
              aria-label={`${highCount} high risk${highCount !== 1 ? 's' : ''}`}
            >
              {highCount} high
            </span>
          )}

          <button
            type="button"
            onClick={() => setShowHeatmap((v) => !v)}
            aria-pressed={showHeatmap}
            className="inline-flex items-center gap-1 h-8 px-3 rounded text-xs font-medium
              border border-neutral-border text-neutral-text-primary bg-neutral-surface
              hover:bg-neutral-surface-raised
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
          >
            Heatmap
            <span aria-hidden="true" className="text-neutral-text-disabled text-[10px] leading-none mt-px">▾</span>
          </button>

          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1 h-8 px-3 rounded text-sm font-medium
              text-neutral-text-inverse bg-brand-primary border border-brand-primary-dark
              hover:bg-brand-primary-dark
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
          >
            + New risk
          </button>
        </div>
      </header>

      {/* ── Two-column content ───────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 flex gap-4 px-6 pb-6 overflow-hidden">

        {/* Left — heatmap card (lg+, togglable) */}
        {showHeatmap && (
          <aside
            className="hidden lg:flex flex-col shrink-0 w-[420px]
              border border-neutral-border rounded-lg p-5
              bg-neutral-surface-raised overflow-auto"
            aria-label="Risk heatmap"
          >
            {isLoading && (
              <div className="flex-1 rounded animate-pulse bg-neutral-border/30" aria-hidden="true" />
            )}
            {!isLoading && !error && <RiskMatrix risks={risks} />}
          </aside>
        )}

        {/* Right — risk table */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

          {/* Loading */}
          {isLoading && (
            <div className="flex flex-col gap-1" aria-label="Loading risks" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 rounded bg-neutral-surface-raised animate-pulse border border-neutral-border"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {/* Error */}
          {!isLoading && error && (
            <div
              role="alert"
              className="flex flex-col items-center justify-center gap-3 py-16 text-center"
            >
              <p className="text-sm text-semantic-critical">Failed to load risks.</p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="h-8 px-3 rounded text-sm font-medium border border-neutral-border
                  text-neutral-text-secondary hover:text-neutral-text-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          )}

          {/* Empty */}
          {!isLoading && !error && risks.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16">
              <p className="text-sm text-neutral-text-secondary">No risks recorded yet.</p>
              <button
                type="button"
                onClick={openCreate}
                className="text-sm text-brand-primary hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-1 rounded"
              >
                + Add your first risk
              </button>
            </div>
          )}

          {/* Table */}
          {!isLoading && !error && risks.length > 0 && (
            <div className="flex-1 overflow-auto rounded-lg border border-neutral-border">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-neutral-surface-raised border-b border-neutral-border">
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[88px]">
                      ID
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide">
                      Risk
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10">
                      P
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-10">
                      I
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[148px]">
                      Severity
                    </th>
                    <th scope="col" className="text-center px-3 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[72px]">
                      Trend
                    </th>
                    <th scope="col" className="text-left px-4 py-3 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide w-[80px]">
                      Owner
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {risks.map((risk) => (
                    <tr
                      key={risk.id}
                      onClick={() => openRisk(risk)}
                      className="h-14 border-b border-neutral-border last:border-b-0
                        hover:bg-neutral-surface-raised cursor-pointer
                        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                        dark:focus-visible:ring-semantic-on-track focus-visible:ring-inset"
                      tabIndex={0}
                      role="button"
                      aria-label={`Open risk: ${risk.title}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openRisk(risk);
                        }
                      }}
                    >
                      {/* ID */}
                      <td className="px-4 font-mono text-xs text-neutral-text-secondary tabular-nums">
                        {formatRiskId(risk.short_id)}
                      </td>

                      {/* Risk — title + status sub-label */}
                      <td className="px-4">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <span className="text-sm font-medium text-neutral-text-primary leading-snug truncate">
                            {risk.title}
                          </span>
                          <span className="text-xs text-neutral-text-secondary leading-none">
                            {STATUS_LABELS[risk.status]}
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

                      {/* Trend — placeholder arrow (no trend data in API) */}
                      <td className="px-3 text-center" aria-label="No trend data available">
                        <span className="text-base text-neutral-text-disabled" aria-hidden="true">→</span>
                      </td>

                      {/* Owner */}
                      <td className="px-4">
                        {risk.owner ? (
                          <span
                            className="inline-flex items-center justify-center w-7 h-7 rounded-full
                              bg-neutral-surface-sunken border border-neutral-border
                              text-xs font-semibold text-neutral-text-secondary"
                            aria-label="Owner assigned"
                          >
                            ?
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-text-disabled" aria-label="Unassigned">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Mobile FAB (rule 90) */}
      <button
        type="button"
        onClick={openCreate}
        className="md:hidden fixed bottom-16 right-4 w-14 h-14 rounded-full
          bg-brand-primary border border-brand-primary-dark
          flex items-center justify-center
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
          dark:focus-visible:ring-semantic-on-track focus-visible:ring-offset-2
          z-20"
        aria-label="Add risk"
      >
        <span className="text-neutral-text-inverse text-2xl leading-none" aria-hidden="true">+</span>
      </button>

      {/* Drawer */}
      {isDrawerOpen && (
        <RiskDrawer
          projectId={projectId}
          risk={selectedRisk ?? null}
          isOpen={isDrawerOpen}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}
