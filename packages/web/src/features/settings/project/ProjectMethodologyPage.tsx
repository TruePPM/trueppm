import { useCallback, useEffect, useRef, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import type { Methodology } from '@/types';

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
  const seededProjectIdRef = useRef<string | null>(null);
  const [initial, setInitial] = useState<Methodology>('HYBRID');

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    setMethodology(project.methodology);
    setInitial(project.methodology);
  }, [project]);

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync({ methodology });
    setInitial(methodology);
  }, [updateProject, methodology]);

  const handleReset = useCallback(() => {
    setMethodology(initial);
  }, [initial]);

  // The workspace locks overrides under INHERIT (always) or active Enterprise
  // ENFORCE. OSS never has an active ENFORCE provider, so ENFORCE behaves like
  // SUGGEST here and the picker stays editable. The effective methodology then
  // equals the workspace default regardless of the project's own value.
  const lockedByPolicy = ws?.methodologyOverridePolicy === 'inherit';
  // Below Admin the picker is read-only too (writes are gated server-side); gate
  // pessimistically while the role query loads.
  const canEdit = !lockedByPolicy && role !== null && role >= ROLE_ADMIN;

  useDirtyForm({
    values: { methodology },
    initialValues: { methodology: initial },
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project && canEdit,
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
      </div>
    </div>
  );
}
