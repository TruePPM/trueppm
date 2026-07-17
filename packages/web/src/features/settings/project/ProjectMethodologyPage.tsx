import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_SCHEDULER } from '@/lib/roles';
import type { Methodology } from '@/types';
import type { EstimationMode } from '@/api/types';

// Estimate-governance modes (ADR-0041, #2018). Ordered least → most restrictive.
const ESTIMATION_MODE_OPTIONS: Array<{ id: EstimationMode; label: string; hint: string }> = [
  { id: 'open', label: 'Open', hint: 'Any member can write task estimates.' },
  {
    id: 'suggest_approve',
    label: 'Suggest & Approve',
    hint: 'Members propose estimates; a Scheduler approves them.',
  },
  { id: 'pm_only', label: 'PM Only', hint: 'Only Schedulers can write estimates.' },
];

/**
 * Project > Methodology settings page (ADR-0107, issue 955 / issue 1169).
 *
 * Methodology cascades Workspace → Program → Project but is NOT-NULL at every
 * scope — there is no null "inherit" sentinel. Inheritance is therefore
 * POLICY-driven, not override-presence driven: the workspace's
 * `methodologyOverridePolicy` decides whether this picker is editable.
 *
 *  - SUGGEST (or OSS ENFORCE with no enterprise provider) → editable. The
 *    project's own `methodology` wins; "Inherited from workspace (X)" is shown
 *    as informational context.
 *  - INHERIT (or active Enterprise ENFORCE) → read-only. The effective
 *    methodology is the workspace default; the picker is locked and explains
 *    why. The server is the source of truth — a PATCH under lock is rejected
 *    403 — so this is a render-gate that spares the user a doomed save, not the
 *    enforcement itself.
 *
 * The page reads the policy from the workspace settings (a global GET) rather
 * than re-deriving it, so the picker's editability and the server's enforcement
 * share one signal.
 */

const METHODS: Array<{
  id: Methodology;
  label: string;
  tagline: string;
  accent: string;
  accentBg: string;
  features: string[];
}> = [
  {
    id: 'AGILE',
    label: 'Agile',
    tagline: 'Sprints, story points, velocity. No baselines, no critical path.',
    accent: '#7C3AED',
    accentBg: 'rgba(124,58,237,.10)',
    features: ['Sprint planning & retros', 'Story points (Fibonacci)', 'Burndown & velocity'],
  },
  {
    id: 'WATERFALL',
    label: 'Waterfall',
    tagline: 'Phases, gates, baselines, CPM. No sprints.',
    accent: '#3E8C6D',
    accentBg: '#D3ECE0',
    features: [
      'WBS → Schedule → Baseline',
      'CPM with all 4 dependency types',
      'Earned value metrics',
    ],
  },
  {
    id: 'HYBRID',
    label: 'Hybrid',
    tagline: 'Phases & gates at top; sprints inside delivery phases.',
    accent: '#C17A10',
    accentBg: '#FFF3CD',
    features: [
      'Phase gates at program level',
      '2-week sprints in delivery',
      'Gantt outer · Board inner',
    ],
  },
];

const METHOD_LABEL: Record<Methodology, string> = {
  AGILE: 'Agile',
  WATERFALL: 'Waterfall',
  HYBRID: 'Hybrid',
};

export function ProjectMethodologyPage() {
  const projectId = useProjectId();
  const { data: project, isLoading: projectLoading } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const { role } = useCurrentUserRole(projectId);
  const { data: ws } = useWorkspaceSettings();

  const [methodology, setMethodology] = useState<Methodology>('HYBRID');
  const [estimationMode, setEstimationMode] = useState<EstimationMode>('open');
  const seededProjectIdRef = useRef<string | null>(null);
  const [initial, setInitial] = useState<Methodology>('HYBRID');
  const [initialEstimationMode, setInitialEstimationMode] = useState<EstimationMode>('open');

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    setMethodology(project.methodology);
    setInitial(project.methodology);
    setEstimationMode(project.estimation_mode as EstimationMode);
    setInitialEstimationMode(project.estimation_mode as EstimationMode);
  }, [project]);

  const handleSave = useCallback(async () => {
    // Send only what actually changed. `methodology` is 403'd under a workspace
    // override lock, so bundling an unchanged methodology with an estimation_mode
    // change would sink the whole PATCH — estimation is independent of that lock.
    const payload: Parameters<typeof updateProject.mutateAsync>[0] = {};
    if (methodology !== initial) payload.methodology = methodology;
    if (estimationMode !== initialEstimationMode) payload.estimation_mode = estimationMode;
    await updateProject.mutateAsync(payload);
    setInitial(methodology);
    setInitialEstimationMode(estimationMode);
  }, [updateProject, methodology, initial, estimationMode, initialEstimationMode]);

  const handleReset = useCallback(() => {
    setMethodology(initial);
    setEstimationMode(initialEstimationMode);
  }, [initial, initialEstimationMode]);

  // The workspace locks overrides under INHERIT (always) or active Enterprise
  // ENFORCE. OSS never has an active ENFORCE provider, so ENFORCE behaves like
  // SUGGEST here and the picker stays editable. The effective methodology then
  // equals the workspace default regardless of the project's own value.
  const lockedByPolicy = ws?.methodologyOverridePolicy === 'inherit';
  // Below Scheduler the picker is read-only (writes are gated server-side); gate
  // pessimistically while the role query loads. `methodology` is in the
  // serializer's `_SCHEDULER_WRITABLE_FIELDS`, so Scheduler+ may change it under
  // the ADR-0041 role model — the UI must not be stricter than the API (#2019).
  const canEdit = !lockedByPolicy && role !== null && role >= ROLE_SCHEDULER;
  // Estimate governance is Scheduler+ but is NOT subject to the methodology
  // override lock (that policy governs methodology inheritance only, #2018).
  const canEditEstimation = role !== null && role >= ROLE_SCHEDULER;

  useDirtyForm({
    values: { methodology, estimation_mode: estimationMode },
    initialValues: { methodology: initial, estimation_mode: initialEstimationMode },
    onSave: handleSave,
    onReset: handleReset,
    // Arm the save bar when EITHER control is editable — estimation stays editable
    // even when methodology is locked by the workspace policy.
    apiReady: !!project && (canEdit || canEditEstimation),
  });

  // Gate on BOTH the project and the workspace settings: until both resolve,
  // `effective`/`inherited` and `lockedByPolicy` would fall back to defaults
  // (HYBRID selected, unlocked) and momentarily render a wrong, concrete-looking
  // selection — the opposite of an INHERIT lock. The skeleton avoids that flash.
  if (projectLoading || !project || ws === undefined) {
    return (
      <div className="px-6 py-8 space-y-3">
        <div className="h-16 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
        <div className="grid grid-cols-3 gap-3.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const effective = project.effective_methodology;
  const inherited = project.inherited_methodology;

  return (
    <div>
      <SettingsPageTitle
        title="Methodology"
        subtitle="The planning methodology (delivery model) for this project. It drives which planning surfaces — Board, Schedule, Sprints — appear."
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-6">
        {/* Inheritance context banner */}
        <div className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-3">
          {lockedByPolicy ? (
            <p className="text-[13px] text-neutral-text-primary">
              This workspace requires every project to use its default methodology —{' '}
              <span className="font-semibold">{METHOD_LABEL[effective]}</span>. The picker below is
              read-only. A workspace admin can relax this on the workspace Methodology page.
            </p>
          ) : (
            <p className="text-[13px] text-neutral-text-secondary">
              Inherited from the workspace default:{' '}
              <span className="font-semibold text-neutral-text-primary">
                {METHOD_LABEL[inherited]}
              </span>
              . Choose a method below to override it for this project only.
            </p>
          )}
        </div>

        {/* Method cards */}
        <section aria-labelledby="method-heading">
          <h2
            id="method-heading"
            className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3"
          >
            {lockedByPolicy ? 'Workspace methodology' : 'Methodology for this project'}
          </h2>
          <div
            className="grid grid-cols-3 gap-3.5"
            role="radiogroup"
            aria-labelledby="method-heading"
          >
            {METHODS.map((m) => {
              const isSelected = (lockedByPolicy ? effective : methodology) === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    if (canEdit) setMethodology(m.id);
                  }}
                  disabled={!canEdit}
                  role="radio"
                  aria-checked={isSelected}
                  className={[
                    'text-left rounded-card border p-4 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    !canEdit ? 'cursor-not-allowed' : '',
                    isSelected
                      ? 'border-2'
                      : 'border border-neutral-border bg-neutral-surface-raised hover:bg-neutral-surface-sunken',
                    !canEdit && !isSelected ? 'opacity-60' : '',
                  ].join(' ')}
                  style={
                    isSelected
                      ? { borderColor: m.accent, background: m.accentBg, color: m.accent }
                      : {}
                  }
                >
                  <div className="flex items-center justify-between mb-2">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-chip text-[11px] font-semibold"
                      style={{ background: m.accentBg, color: m.accent }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-current opacity-60"
                        aria-hidden="true"
                      />
                      {m.label}
                    </span>
                    {isSelected && (
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                        style={{ background: m.accent, color: '#fff' }}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path
                            d="M3 8l4 4 6-7"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary mb-3 leading-snug">
                    {m.tagline}
                  </p>
                  <ul className="space-y-1">
                    {m.features.map((f) => (
                      <li
                        key={f}
                        className="text-[11px] text-neutral-text-secondary flex items-start gap-1.5"
                      >
                        <span
                          className="w-1 h-1 rounded-full bg-neutral-text-disabled mt-[5px] shrink-0"
                          aria-hidden="true"
                        />
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </section>

        {/* Estimate governance (ADR-0041, #2018). Scheduler+-writable, independent of
            the methodology override lock. Disabled below Scheduler to match this page's
            methodology picker; #2057 migrates both to the ADR-0133 read-only pattern. */}
        <section aria-labelledby="estimation-heading">
          <h2
            id="estimation-heading"
            className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3"
          >
            Estimate governance
          </h2>
          <div className="relative inline-block w-[240px]">
            <select
              value={estimationMode}
              onChange={(e) => setEstimationMode(e.target.value as EstimationMode)}
              disabled={!canEditEstimation}
              aria-label="Estimate governance"
              className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:cursor-not-allowed disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary"
            >
              {ESTIMATION_MODE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <svg
              className="pointer-events-none absolute right-2.5 top-2.5 text-neutral-text-secondary"
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p className="mt-1.5 text-[12px] text-neutral-text-secondary max-w-[440px]">
            {ESTIMATION_MODE_OPTIONS.find((o) => o.id === estimationMode)?.hint}{' '}
            Consumed by the estimate-approval flow on tasks.
          </p>
        </section>
      </div>
    </div>
  );
}
