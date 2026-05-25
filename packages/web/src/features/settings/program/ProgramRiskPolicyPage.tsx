import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN } from '@/lib/roles';
import {
  useProgramRiskPolicy,
  useSaveProgramRiskPolicy,
  type SlipPropagation,
} from './useProgramRiskPolicy';

type Threshold = 'low' | 'medium' | 'high' | 'critical';

const THRESHOLD_LABELS: Record<Threshold, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const THRESHOLD_STYLE: Record<Threshold, string> = {
  low:      'bg-neutral-surface-sunken text-neutral-text-secondary border-neutral-border',
  medium:   'bg-brand-accent-light text-brand-accent-dark border-brand-accent/40',
  high:     'bg-brand-accent-light text-brand-accent-dark border-brand-accent/40',
  critical: 'bg-semantic-critical/10 text-semantic-critical border-semantic-critical/40',
};

interface SlipOption {
  id: SlipPropagation;
  label: string;
  hint: string;
}

const SLIP_OPTIONS: SlipOption[] = [
  { id: 'none',  label: 'No action',         hint: 'Slip is visible in the schedule but no notification or gate fires.' },
  { id: 'warn',  label: 'Warn only',         hint: 'Notify the successor PM and the program manager via in-app alert.' },
  { id: 'block', label: 'Block & escalate',  hint: 'Lock the successor task from starting and open an escalation ticket.' },
];

/** 5×5 risk matrix cell. */
function MatrixCell({ probability, impact }: { probability: number; impact: number }) {
  const score = probability * impact;
  const threshold: Threshold =
    score >= 20 ? 'critical' :
    score >= 12 ? 'high' :
    score >= 6  ? 'medium' : 'low';

  return (
    <div
      className={`flex items-center justify-center rounded text-[10px] font-bold tppm-mono border ${THRESHOLD_STYLE[threshold]}`}
      style={{ height: 36 }}
      title={`P${probability} × I${impact} = ${score} (${THRESHOLD_LABELS[threshold]})`}
      aria-label={`Probability ${probability}, Impact ${impact}, score ${score}, ${THRESHOLD_LABELS[threshold]}`}
    >
      {score}
    </div>
  );
}

/**
 * Program > Risk & deps policy settings page (#529).
 *
 * Wires the existing settings surface to ``/api/v1/programs/:id/risk-policy/``.
 * The 5×5 risk matrix is intentionally read-only — thresholds are workspace-
 * wide. Only the slip-propagation radio and the escalation-days input are
 * editable. Both submit together via the shell's save bar
 * (``useDirtyForm`` contract, rule 115 / #536).
 */
export function ProgramRiskPolicyPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: policy, isLoading, isError, refetch } = useProgramRiskPolicy(programId);
  const savePolicy = useSaveProgramRiskPolicy(programId ?? '');

  const canEdit = (program?.my_role ?? 0) >= ROLE_ADMIN;

  const [slip, setSlip] = useState<SlipPropagation>('warn');
  const [days, setDays] = useState<number>(3);

  // Re-seed whenever the program in the route changes. React Router reuses this
  // component across `:programId` changes (no `key` → no remount), so a one-shot
  // boolean guard would strand the form on the first program's policy when the
  // user switches programs in Settings (#750). The policy has no own id, so key
  // on programId. A same-program refetch (e.g. a sibling page invalidating the
  // cache) keeps the same id, so in-progress edits are still preserved — the
  // original guard's intent. Initial-* doubles as the discard snapshot and the
  // useDirtyForm dirty-compare source.
  const seededProgramIdRef = useRef<string | undefined>(undefined);
  const [initialSlip, setInitialSlip] = useState<SlipPropagation>('warn');
  const [initialDays, setInitialDays] = useState<number>(3);

  useEffect(() => {
    if (!policy || seededProgramIdRef.current === programId) return;
    seededProgramIdRef.current = programId;
    setSlip(policy.slip_propagation);
    setDays(policy.escalation_days);
    setInitialSlip(policy.slip_propagation);
    setInitialDays(policy.escalation_days);
  }, [policy, programId]);

  const values = useMemo(() => ({ slip, days }), [slip, days]);
  const initialValues = useMemo(
    () => ({ slip: initialSlip, days: initialDays }),
    [initialSlip, initialDays],
  );

  // Range validity mirrors the server-side 1–30 — surfaced inline so the
  // user gets immediate feedback rather than a round-trip 400 on save.
  const daysValid = Number.isInteger(days) && days >= 1 && days <= 30;

  const handleSave = useCallback(async () => {
    if (!programId || !daysValid) return;
    const updated = await savePolicy.mutateAsync({
      slip_propagation: slip,
      escalation_days: days,
    });
    // Bump the snapshot so useDirtyForm derives dirty=false against the
    // freshly-saved values (matches the ProgramGeneralPage pattern).
    setInitialSlip(updated.slip_propagation);
    setInitialDays(updated.escalation_days);
  }, [programId, slip, days, daysValid, savePolicy]);

  const handleReset = useCallback(() => {
    setSlip(initialSlip);
    setDays(initialDays);
  }, [initialSlip, initialDays]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!programId && canEdit && daysValid,
  });

  if (!programId) return null;

  return (
    <div>
      <SettingsPageTitle
        title="Risk & deps policy"
        subtitle="Risk matrix thresholds, cross-project dependency slip propagation rules, and escalation paths."
        action={
          !canEdit ? (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-neutral-surface-sunken text-neutral-text-secondary"
              title="Only program admins can edit risk policy"
            >
              Read-only
            </span>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* 5×5 matrix — read-only at the program level (workspace-scoped) */}
        <section aria-labelledby="matrix-heading">
          <h2 id="matrix-heading" className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3">
            Risk matrix (read-only — thresholds are org-wide)
          </h2>
          <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg p-4 overflow-x-auto">
            <div className="grid gap-1" style={{ gridTemplateColumns: 'auto repeat(5, 1fr)', minWidth: 320 }}>
              <div />
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="text-center text-[10px] font-semibold text-neutral-text-secondary pb-1">
                  I{i}
                </div>
              ))}
              {[5, 4, 3, 2, 1].map((p) => (
                <Fragment key={p}>
                  <div className="text-[10px] font-semibold text-neutral-text-secondary flex items-center pr-2">
                    P{p}
                  </div>
                  {[1, 2, 3, 4, 5].map((impact) => (
                    <MatrixCell key={impact} probability={p} impact={impact} />
                  ))}
                </Fragment>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-3 pt-3 border-t border-neutral-border/55">
              {(['low', 'medium', 'high', 'critical'] as Threshold[]).map((t) => (
                <span key={t} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${THRESHOLD_STYLE[t]}`}>
                  {THRESHOLD_LABELS[t]}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* Slip propagation */}
        <section
          aria-labelledby="slip-heading"
          className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 id="slip-heading" className="text-[13px] font-semibold text-neutral-text-primary">Cross-project dependency slip</h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              What happens when a predecessor task in one project slips and blocks a successor in another.
            </p>
          </div>

          {isLoading && (
            <div role="status" aria-label="Loading risk policy" className="px-4 py-6 text-xs text-neutral-text-secondary">
              Loading…
            </div>
          )}

          {isError && (
            <div role="alert" className="px-4 py-6 flex items-center gap-3 text-xs">
              <span className="text-semantic-critical">Couldn&apos;t load risk policy.</span>
              <button
                type="button"
                onClick={() => void refetch()}
                className="h-7 px-2 rounded border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !isError && policy && (
            <fieldset className="px-4 py-3 space-y-2" disabled={!canEdit}>
              <legend className="sr-only">Slip propagation policy</legend>
              {SLIP_OPTIONS.map((opt) => (
                <label
                  key={opt.id}
                  className={[
                    'flex items-start gap-2.5 rounded p-2',
                    canEdit ? 'cursor-pointer hover:bg-neutral-surface-sunken' : 'opacity-80',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                      slip === opt.id
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-neutral-border bg-neutral-surface',
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    {slip === opt.id && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </span>
                  <input
                    type="radio"
                    name="slip-policy"
                    value={opt.id}
                    checked={slip === opt.id}
                    onChange={() => setSlip(opt.id)}
                    className="sr-only"
                  />
                  <span className="flex flex-col">
                    <span className="text-[13px] font-medium text-neutral-text-primary">{opt.label}</span>
                    <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </section>

        {/* Escalation */}
        {!isLoading && !isError && policy && (
          <FieldRow
            label="Auto-escalate after"
            hint="Days a blocked dependency can sit without resolution before escalating to the program manager."
          >
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={30}
                value={days}
                disabled={!canEdit}
                aria-invalid={!daysValid || undefined}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setDays(Number.isFinite(n) ? n : 0);
                }}
                className="w-20 h-8 px-2.5 rounded border border-neutral-border bg-neutral-surface-raised tppm-mono text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:opacity-60"
              />
              <span className="text-[13px] text-neutral-text-secondary">days</span>
              {!daysValid && (
                <span role="alert" className="text-[12px] text-semantic-critical">
                  Must be 1–30.
                </span>
              )}
            </div>
          </FieldRow>
        )}
      </div>
    </div>
  );
}
