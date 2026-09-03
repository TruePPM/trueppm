import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Risk } from '@/api/types';
import { useRisks } from '@/hooks/useRisks';
import { useProjects } from '@/hooks/useProjects';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { canEditRisk } from '@/lib/roles';
import {
  HIGH_SEVERITY_THRESHOLD,
  matchesRiskFilter,
  riskFilterCounts,
  sortRisksByNewest,
  sortRisksBySeverity,
  type RiskFilter,
  type SeveritySort,
} from '../riskFilters';
import type { SelectedCell } from '../RiskMatrix';
import { useRiskDeepLink } from './useRiskDeepLink';
import {
  HIDDEN_SEVERITIES_KEY,
  isInBand,
  readHiddenSeverities,
  type SeverityBand,
} from './hiddenSeverities';

/**
 * Slug for the CSV filename. Derived from the project name because the Project
 * type carries no slug field; falls back to the id when the name slugifies to
 * nothing.
 */
function toProjectSlug(name: string | null, projectId: string): string {
  return (
    (name ?? projectId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || projectId
  );
}

/**
 * Two orthogonal facets compose with AND: the segment filter, then the matrix
 * cell coordinate, then the ordering applied last. The heatmap matrix and the
 * count chips always reflect the *full* set — only the table consumes the
 * facets (dimming the matrix to its own selection would be circular).
 *
 * One ordering wins at a time: Newest (created_at desc) overrides the severity
 * column sort when active; otherwise the severity sort applies.
 */
function narrowRisks(opts: {
  risks: Risk[];
  filter: RiskFilter;
  currentUserId: string | null;
  hiddenSeverities: Set<SeverityBand>;
  selectedCell: SelectedCell | null;
  newestSort: boolean;
  severitySort: SeveritySort;
}): Risk[] {
  const { risks, filter, currentUserId, hiddenSeverities, selectedCell } = opts;
  const hidden = [...hiddenSeverities];
  const segmentRisks = risks
    .filter((r) => matchesRiskFilter(r, filter, currentUserId))
    // Severity-band visibility: drop rows in any hidden band (client-side,
    // persisted). Applied alongside the segment facet so both narrow the table.
    .filter((r) => !hidden.some((band) => isInBand(r, band)));
  const cellRisks = selectedCell
    ? segmentRisks.filter(
        (r) => r.probability === selectedCell.probability && r.impact === selectedCell.impact,
      )
    : segmentRisks;
  return opts.newestSort
    ? sortRisksByNewest(cellRisks)
    : sortRisksBySeverity(cellRisks, opts.severitySort);
}

/**
 * Every value the risk register renders: the loaded risks, the facet/sort state,
 * the derived counts, the narrowed table rows, and the drawer controls.
 * Extracted from `RiskRegisterView` for #2081 — no behavior change.
 */
export function useRiskRegister(projectId: string) {
  const { risks, isLoading, error } = useRisks(projectId || null);
  const { data: projects } = useProjects();
  const { user } = useCurrentUser();
  // Risk write gate (Member+) — drives the Import CSV affordance, mirroring the
  // server's IsProjectMemberWrite on the import action (issue 223).
  const { role } = useCurrentUserRole(projectId || undefined);

  const [searchParams] = useSearchParams();
  // Seeded once from `?severity=high` so the Overview "Open risks" card drills
  // straight into the High segment (#1691).
  const [filter, setFilter] = useState<RiskFilter>(
    searchParams.get('severity') === 'high' ? 'high' : 'all',
  );
  const [severitySort, setSeveritySort] = useState<SeveritySort>('none');
  // "Newest" sort (issue 1230) — mutually exclusive with the severity column
  // sort, so the table is never governed by two competing orderings.
  const [newestSort, setNewestSort] = useState(false);
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null);
  // Client-side severity-band visibility — seeded from localStorage so the
  // preference survives a remount, persisted on every change.
  const [hiddenSeverities, setHiddenSeverities] = useState<Set<SeverityBand>>(readHiddenSeverities);
  // null = drawer closed, undefined = create mode, Risk = edit mode
  const [selectedRisk, setSelectedRisk] = useState<Risk | null | undefined>(null);
  // When true the drawer opens directly in edit mode (the row's edit button)
  const [editMode, setEditMode] = useState(false);

  // `?risk=<id>` deep-link ⇄ open-drawer round-trip (issue #2046).
  useRiskDeepLink(risks, selectedRisk, setSelectedRisk);

  const toggleSeverityBand = useCallback((band: SeverityBand) => {
    setHiddenSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(band)) next.delete(band);
      else next.add(band);
      localStorage.setItem(HIDDEN_SEVERITIES_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const currentUserId = user?.id ?? null;
  const projectName = projects?.find((p) => p.id === projectId)?.name ?? null;
  const filterCounts = riskFilterCounts(risks, currentUserId);

  return {
    risks,
    isLoading,
    error,
    canImport: canEditRisk(role),
    projectName,
    projectSlug: toProjectSlug(projectName, projectId),

    filter,
    setFilter,
    severitySort,
    setSeveritySort,
    newestSort,
    setNewestSort,
    selectedCell,
    setSelectedCell,
    hiddenSeverities,
    toggleSeverityBand,
    isLowHidden: hiddenSeverities.has('low'),

    // Counts derive over the full loaded register, not the narrowed table.
    // "High" here is high-and-above (>= threshold), matching the High segment.
    criticalCount: risks.filter((r) => r.severity >= 20).length,
    highCount: risks.filter((r) => r.severity >= 12 && r.severity < 20).length,
    highAndAboveCount: risks.filter((r) => r.severity >= HIGH_SEVERITY_THRESHOLD).length,
    unmitigatedCount: filterCounts.unmitigated,
    filterCounts,

    displayRisks: narrowRisks({
      risks,
      filter,
      currentUserId,
      hiddenSeverities,
      selectedCell,
      newestSort,
      severitySort,
    }),
    isFiltered: filter !== 'all' || selectedCell !== null,
    clearAllFilters: () => {
      setFilter('all');
      setSelectedCell(null);
    },

    selectedRisk,
    editMode,
    isDrawerOpen: selectedRisk !== null,
    openCreate: () => {
      setEditMode(false);
      setSelectedRisk(undefined);
    },
    openRisk: (risk: Risk) => {
      setEditMode(false);
      setSelectedRisk(risk);
    },
    openRiskEdit: (risk: Risk) => {
      setEditMode(true);
      setSelectedRisk(risk);
    },
    closeDrawer: () => {
      setEditMode(false);
      setSelectedRisk(null);
    },
  };
}
