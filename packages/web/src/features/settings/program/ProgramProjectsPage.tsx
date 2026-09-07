import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useBulkProjectFields } from '@/hooks/useBulkProjectFields';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import {
  BULK_FIELDS_MAX_ROWS,
  BulkFieldsMatrix,
  type FieldDescriptor,
} from '../components/BulkFieldsMatrix';
import {
  DEVIATES,
  METHODOLOGY_LABEL,
  MethodologyFilter,
  type MethodologyDeviationFilterValue,
} from '@/features/programs/MethodologyFilter';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { AddProjectToProgramModal } from '@/features/programs/AddProjectToProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { EmptyState } from '@/components/EmptyState';
import { SlidersIcon } from '@/components/Icons';
import { ROLE_ADMIN } from '@/lib/roles';
import type { Methodology, Project } from '@/types';

/** Program > Projects settings page — lists projects assigned to this program. */
export function ProgramProjectsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: projects, isLoading, error } = useProgramProjects(programId);
  const { data: ws, isPending: wsPending, isError: wsError } = useWorkspaceSettings();
  const bulkFields = useBulkProjectFields(programId);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const isNarrow = useBreakpoint() === 'sm';
  const navigate = useNavigate();
  const location = useLocation();

  const [methodologyFilter, setMethodologyFilter] =
    useState<MethodologyDeviationFilterValue>('ALL');

  /**
   * Deep-link arrival contract (#3293, D41). The canonical link is
   * `/programs/{id}/settings?bulk=methodology&only=deviating#projects`, emitted by the
   * post-save align offer on the General section.
   *
   * It is an **effect on the params, not a mount-time read**, and that is not a style
   * choice: program settings is one consolidated scrolling page (ADR-0146), so this
   * section is ALREADY MOUNTED when the offer's link is clicked. A `useState`
   * initializer would run exactly once, before the admin ever saved, and the link would
   * arm nothing — green in a standalone unit test and dead in the product.
   *
   * "Once per arrival" is enforced by the strip: the params are removed with
   * `replace: true` in the same commit that arms, so a refresh or a Back lands on the
   * plain page rather than silently re-checking rows the admin has since changed. Note
   * what that does NOT cover — a URL copied or hand-built *before* the strip arms on a
   * cold load, which is deliberate and harmless: the contract seeds a filter and a
   * selection, never a staged value, so the worst a shared link can do is pre-check
   * rows. Apply still needs a value the recipient chose.
   *
   * **It scrolls itself, and must.** `SettingsShell`'s hash effect is guarded
   * once-per-hash-*value* (`lastHandledHashRef`), and this link's hash is always
   * `#projects`. Nothing rewrites the hash on scroll, so on a second use — link, wheel
   * back up to General, save, link again — the shell's effect early-returns and the
   * viewport never moves while this section silently filters and pre-checks rows
   * off-screen. See web-rule 399.
   */
  const [searchParams] = useSearchParams();
  const [arrival, setArrival] = useState<number | null>(null);
  const arrivals = useRef(0);
  useEffect(() => {
    const hasParams = searchParams.has('bulk') || searchParams.has('only');
    if (!hasParams) return;
    // A half-formed link is not the contract — a stray `bulk` alone must not preselect
    // a cohort nobody named. Either way the params are cleaned up.
    if (searchParams.get('bulk') === 'methodology' && searchParams.get('only') === 'deviating') {
      arrivals.current += 1;
      setArrival(arrivals.current);
      setMethodologyFilter(DEVIATES);
      // Deferred so the narrowed rows are laid out before we measure. `scroll-mt-6` on
      // `SettingsSection` clears the sticky header, which is why the section element is
      // the target rather than the matrix. Guarded for jsdom, which has no
      // `scrollIntoView`, and for the standalone-route mount, which has no section.
      requestAnimationFrame(() => {
        const section = document.querySelector('[data-settings-section="projects"]');
        if (section instanceof HTMLElement && typeof section.scrollIntoView === 'function') {
          section.scrollIntoView({
            block: 'start',
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
              ? 'auto'
              : 'smooth',
          });
        }
      });
    }
    const next = new URLSearchParams(searchParams);
    next.delete('bulk');
    next.delete('only');
    void navigate(
      {
        pathname: location.pathname,
        search: next.toString() ? `?${next.toString()}` : '',
        // Carried forward so the shell's own hash handling still works on a COLD load,
        // where it is the thing that scrolls. The explicit scroll above is what covers
        // the in-page case the shell's once-per-hash guard cannot.
        hash: location.hash,
      },
      { replace: true },
    );
  }, [searchParams, navigate, location.pathname, location.hash]);

  // Admin/Owner can manage program membership (ADR-0072 role ordinals). Gates
  // "+ Add project" / "Import" — assigning a project to a program is a project-
  // level write (`PATCH /projects/:id/`) with no server-side check on the
  // *target* program's closed state, so this affordance is unaffected by #2549.
  const isAdmin = (program?.my_role ?? -1) >= ROLE_ADMIN;
  // The bulk-fields matrix below writes through `bulk_project_fields`, which
  // IS gated by IsProgramNotClosed (program_views.py) — fold that in separately
  // per #2549 rather than widening `isAdmin`, which also gates Add/Import above.
  const canEditBulkFields = isAdmin && !program?.is_closed;

  // The two inherited fields the bulk-project-fields endpoint accepts. Methodology is
  // NOT a null-sentinel field (web-rule 196): it has no "reset to inherit" and is
  // dropped from the picker (display-only) under a workspace `inherit` lock.
  const methodologyLocked = ws?.methodologyOverridePolicy === 'inherit';
  // Which scope the deviation is measured against. `resolve_inherited_methodology`
  // re-parents to the workspace under an `inherit` lock, so labelling every marker
  // "program" would be false in exactly the state where this column matters most:
  // the field is read-only there, no preview can open, and this page is the only
  // surface that can name the projects a locked policy has not reconciled.
  const deviationScope = methodologyLocked ? 'workspace' : 'program';
  // Until the workspace policy resolves we cannot name the scope the server compared
  // against: `resolve_inherited_methodology` re-parents to the workspace under a lock,
  // so defaulting to "program" would print a false claim in exactly the state where
  // this column matters most. Show nothing rather than something wrong — the same
  // "absent, not zeroed" degradation a missing inherited value already gets.
  const scopeKnown = !wsPending && !wsError;
  const fields = useMemo<FieldDescriptor<Project>[]>(
    () => [
      {
        key: 'methodology',
        label: 'Methodology',
        kind: 'enum',
        options: [
          { value: 'AGILE', label: 'Agile' },
          { value: 'WATERFALL', label: 'Waterfall' },
          { value: 'HYBRID', label: 'Hybrid' },
        ],
        read: (p) => ({
          effective: p.effectiveMethodology ?? p.methodology,
          overridden: p.inheritedMethodology != null && p.methodology !== p.inheritedMethodology,
          // Absent, not false, when the row carries no inherited value: a stale
          // client can hold rows without one, and "no marker" degrades to today's
          // product while a rendered zero would claim a check that never ran.
          deviation:
            !scopeKnown || p.inheritedMethodology == null
              ? undefined
              : {
                  differs: p.methodology !== p.inheritedMethodology,
                  scope: deviationScope,
                  inherited: p.inheritedMethodology,
                  own: p.methodology,
                },
        }),
        resettable: false,
        locked: methodologyLocked,
        // "Waterfall ≠ program (Hybrid)" does not fit the 140px default (#3295, D39).
        minWidth: '220px',
      },
      {
        key: 'iteration_label',
        label: 'Iteration label',
        kind: 'string',
        maxLength: 32,
        read: (p) => ({
          effective: p.effectiveIterationLabel ?? null,
          overridden: p.iterationLabel != null,
        }),
        resettable: true,
      },
    ],
    [methodologyLocked, deviationScope, scopeKnown],
  );

  // Deviation cohort (#3295). The comparison is the project's OWN stored methodology
  // against what the server says it inherits — not `effective`, which equals the
  // inherited value on every row under a lock and would report nothing there.
  const deviates = useCallback(
    (p: Project) => p.inheritedMethodology != null && p.methodology !== p.inheritedMethodology,
    [],
  );

  /**
   * The value the methodology cell actually prints for this row — which is the row's
   * OWN value whenever there is an inherited value to compare it against, and the
   * effective value only when there is not.
   *
   * The facet counts and the filter predicate both run through here so that a facet
   * can never describe a set the column is not showing. Normally the two are the same
   * value; under a workspace `inherit` lock `effectiveMethodology` is the workspace's
   * on every row, so bucketing on it would collapse every row into one facet and put
   * `Waterfall 0` above twelve visible cells reading "Waterfall ≠ workspace (Hybrid)".
   */
  const displayed = useCallback(
    (p: Project): Methodology =>
      p.inheritedMethodology != null ? p.methodology : (p.effectiveMethodology ?? p.methodology),
    [],
  );

  const facetCounts = useMemo(() => {
    // Seeded at zero, not built up from what is present: a facet matching nothing has
    // to render its zero and go `aria-disabled` (the filter's own §C rule), and an
    // absent key would silently render a bare label that looks clickable instead.
    const out: Partial<Record<'ALL' | Methodology, number>> = {
      ALL: projects?.length ?? 0,
      WATERFALL: 0,
      AGILE: 0,
      HYBRID: 0,
    };
    for (const p of projects ?? []) {
      const key = displayed(p);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  }, [projects, displayed]);

  // No row can be compared → the fifth option, the markers and the header count are
  // all absent rather than zeroed, which is exactly what the matrix rendered before
  // this change. The diff is purely additive over that state.
  const anyComparable = useMemo(
    () => scopeKnown && (projects ?? []).some((p) => p.inheritedMethodology != null),
    [projects, scopeKnown],
  );
  const deviatingCount = useMemo(
    () => (projects ?? []).filter(deviates).length,
    [projects, deviates],
  );

  const visibleProjects = useMemo(() => {
    const all = projects ?? [];
    if (methodologyFilter === 'ALL') return all;
    if (methodologyFilter === DEVIATES) return all.filter(deviates);
    return all.filter((p) => displayed(p) === methodologyFilter);
  }, [projects, methodologyFilter, deviates, displayed]);

  // A selection that is no longer offered leaves the radiogroup with nothing checked
  // while the rows stay narrowed — reachable by rotating a tablet across 768px (the
  // facets collapse) or by a refetch that drops the inherited value (the fifth option
  // goes). Fall back to the unnarrowed cohort so the control and the rows agree.
  const facetOffered =
    methodologyFilter === 'ALL' ||
    (methodologyFilter === DEVIATES ? anyComparable : !isNarrow);
  useEffect(() => {
    if (!facetOffered) setMethodologyFilter('ALL');
  }, [facetOffered]);

  if (!programId) return null;

  const projectCount = projects?.length ?? 0;

  /**
   * What the arrival says on the matrix's live region (#3293, D41).
   *
   * A full sentence, matching the register the same region already uses ("Selection
   * cleared. Showing 3 projects.") rather than a comma-spliced fragment ending on a bare
   * field name — and it names the **next act**, because D19 stages nothing on purpose, so
   * Apply is disabled on arrival and "choose a value, then Apply" is the one thing a
   * screen-reader user cannot infer from the value control the way a sighted one can.
   *
   * Below `md` the matrix drops every write affordance (`narrowReadOnly`), so there is no
   * selection to speak of and no Apply to reach: claiming "N selected" there would be a
   * live region describing controls that are not on the page.
   */
  const armedCount = Math.min(visibleProjects.length, BULK_FIELDS_MAX_ROWS);
  const arrivalNote = isNarrow
    ? `Showing the ${visibleProjects.length} of ${projectCount} projects that differ from the program methodology. Bulk edits need a wider screen.`
    : `Methodology selected for ${armedCount} of ${projectCount} projects. Choose a methodology, then Apply.`;

  const deviationLabel = methodologyLocked
    ? 'Deviates from workspace'
    : 'Deviates from default';
  // Stable identity — the filter memoizes its option list on this prop.
  const deviationOption = anyComparable
    ? { label: deviationLabel, count: deviatingCount }
    : undefined;
  const activeFilterLabel =
    methodologyFilter === DEVIATES
      ? deviationLabel
      : methodologyFilter === 'ALL'
        ? null
        : METHODOLOGY_LABEL[methodologyFilter];

  return (
    <div>
      <SettingsPageTitle
        title="Projects"
        count={!isLoading && !error ? `${projectCount} projects` : undefined}
        /* "Inherits unless overridden" was false here: methodology is NOT-NULL at
           every scope, so `resolve_effective_methodology` short-circuits on the
           project's own value and a program's methodology never flows down to an
           EXISTING project at read time. It seeds at create, or you set it in the
           matrix below (#3293's vocabulary, D23). */
        subtitle="Projects assigned to this program. New projects created here start with the program methodology; existing projects keep their own — change those in the matrix below."
        action={
          isAdmin ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="px-3 py-1.5 rounded-control border border-neutral-border text-neutral-text-secondary text-[13px] font-medium hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 rounded-control bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                + Add project
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {isLoading && (
          <div aria-label="Loading projects" className="space-y-2 mt-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className="h-12 motion-safe:animate-pulse rounded-card border border-neutral-border bg-neutral-surface-raised"
              />
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-semantic-critical">
            Failed to load projects.
          </p>
        )}

        {!isLoading && !error && projects && projects.length === 0 && (
          <div className="mt-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-sm text-neutral-text-secondary">
              No projects in this program yet.
              {isAdmin ? ' Use + Add project to assign one.' : ''}
            </p>
          </div>
        )}

        {!isLoading && !error && projects && projects.length > 0 && (
          <div className="mt-4">
            {/* The filter is a toolbar row inside the matrix column, NOT the title
                band's action slot: that slot is admin-gated and reading the matrix is
                not, so a filter placed there would vanish for exactly the non-admin
                readers whose only affordance is scanning. Keeping it in the same
                920px measure also lines the option counts up with the column they
                describe. It does not stick — program settings is one scrolling page
                with `#slug` anchors (ADR-0146), and a second sticky element would
                cover the anchor target a deep link lands on. */}
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <MethodologyFilter<MethodologyDeviationFilterValue>
                value={methodologyFilter}
                onChange={setMethodologyFilter}
                counts={facetCounts}
                collapseFacets={isNarrow}
                deviationOption={deviationOption}
              />
            </div>

            {isAdmin && program?.is_closed && (
              <p className="mb-2 text-xs text-neutral-text-secondary italic">
                This program is closed — bulk field edits are read-only until it&apos;s reopened.
              </p>
            )}

            {visibleProjects.length === 0 ? (
              // `EmptyState` announces its own title through the shell's single
              // persistent polite region (ADR-0989), so the transition INTO the empty
              // cohort is spoken — a `role="status"` node that mounts with its text
              // already in it announces nothing.
              <EmptyState
                icon={SlidersIcon}
                title="No projects match this filter"
                description="Nothing in this program matches the methodology filter above. Choose All to see every project again."
              />
            ) : (
              <BulkFieldsMatrix
                /* An arrival re-seeds the matrix, so it remounts (#3293, D41). The
                   arrival props are mount-time seeds by design — re-applying them on
                   every render would fight the admin's own clicks — and this section is
                   already mounted when the deep link fires, so the key is what makes
                   the seed reachable. Remounting also guarantees the arrival stages
                   nothing: any value the admin had staged before is discarded, which is
                   the state D41 requires. */
                key={arrival ?? 'plain'}
                rows={visibleProjects}
                rowKey={(p) => p.id}
                rowLabel={(p) => p.name}
                rowNoun="Project"
                fields={fields}
                canEdit={canEditBulkFields}
                apply={(ids, field, value) => bulkFields.mutateAsync({ ids, field, value })}
                isApplying={bulkFields.isPending}
                entityNoun="projects"
                selectionResetKey={methodologyFilter}
                tallyRows={projects}
                narrowReadOnly
                {...(arrival != null
                  ? {
                      initialFieldKey: 'methodology',
                      // The rows the deep link named: whatever the DEVIATES filter is
                      // showing at the moment the matrix first mounts. The matrix
                      // clamps to its own cap, so the sentence on the offer
                      // ("Align the first 200") and what arrives here agree.
                      initialSelection: visibleProjects.map((p) => p.id),
                      arrivalNote: arrivalNote,
                    }
                  : {})}
                scopeNote={
                  activeFilterLabel ? (
                    <>
                      <span className="tppm-mono">{visibleProjects.length}</span> of{' '}
                      <span className="tppm-mono">{projectCount}</span> shown ·{' '}
                      {activeFilterLabel}
                    </>
                  ) : undefined
                }
              />
            )}
          </div>
        )}
      </div>

      {showAddModal && (
        <AddProjectToProgramModal
          programId={programId}
          programName={program?.name ?? ''}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Import-a-project entry (#797) — the new project lands already assigned
          to this program, gated by program Admin both client- and server-side. */}
      {showImport && (
        <ImportProjectModal
          programId={programId}
          programName={program?.name}
          programMethodology={program?.effective_methodology}
          onClose={() => setShowImport(false)}
          onCreated={(projectId) => {
            setShowImport(false);
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
    </div>
  );
}
