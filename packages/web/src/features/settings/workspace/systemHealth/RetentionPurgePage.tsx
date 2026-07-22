/**
 * Workspace > System health > Retention & purge (ADR-0173, #693).
 *
 * Workspace-admin operator UI to tune per-table retention windows, configure the
 * purge schedule, run/preview purges on demand, and review recent runs. Renders
 * inside the shared SettingsShell and uses the standard dirty-form save contract:
 * page-local state → useDirtyForm → shared save bar → PATCH → snapshot bump.
 *
 * Run-now / dry-run are out-of-band actions (not part of dirty state). Lowering a
 * retention value shows an irreversibility warning backed by the impact endpoint;
 * saving only changes the window — the next run enforces it.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import axios from 'axios';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SettingsPageTitle, SettingsCard } from '../../SettingsShell';
import {
  useRetentionSettings,
  useUpdateRetention,
  useRetentionImpact,
  useRunPurge,
  type RetentionState,
  type RetentionSchedule,
  type RetentionPolicyRow,
  type PurgeRun,
  type PurgeRunState,
  type ScheduleFrequency,
} from '@/hooks/useRetention';
import { useDirtyForm } from '../../hooks/useDirtyForm';
import { formatBytes, formatTimeAgo } from './formatAge';

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

interface EditablePolicy {
  key: string;
  value: number;
  enabled: boolean;
}

function toEditable(policies: RetentionPolicyRow[]): EditablePolicy[] {
  return policies.map((p) => ({ key: p.key, value: p.value, enabled: p.enabled }));
}

// ---------------------------------------------------------------------------
// Toggle (role="switch") — mirrors the WorkspaceGeneralPage pattern.
// ---------------------------------------------------------------------------

function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded-control disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span
        className={[
          'relative w-8 h-[18px] rounded-full border transition-colors shrink-0',
          on ? 'bg-brand-primary border-brand-primary-dark' : 'bg-neutral-surface-sunken border-neutral-border',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] w-3 h-3 rounded-full bg-white transition-[left] duration-150',
            on ? 'left-[14px]' : 'left-[2px]',
          ].join(' ')}
        />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Policy table row
// ---------------------------------------------------------------------------

function PolicyRow({
  meta,
  edit,
  initialValue,
  onValueChange,
  onEnabledChange,
}: {
  meta: RetentionPolicyRow;
  edit: EditablePolicy;
  initialValue: number;
  onValueChange: (value: number) => void;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const inputId = useId();
  const warnId = useId();
  const disablable = meta.key !== 'TRUEPPM_SYNC_BATCH_RETENTION_HOURS';
  const lowered = edit.enabled && edit.value < initialValue;
  const debouncedValue = useDebounced(edit.value, 400);
  const impact = useRetentionImpact(
    meta.key,
    debouncedValue,
    lowered && debouncedValue < initialValue,
  );

  return (
    <>
      <tr className="border-b border-neutral-border/55 align-top">
        <td className="px-4 py-3">
          <div className="text-[13px] font-medium text-neutral-text-primary flex items-center gap-1.5">
            {meta.label}
            {lowered && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-chip text-[11px] font-semibold bg-semantic-at-risk-bg text-semantic-at-risk uppercase tracking-wide">
                Lowering
              </span>
            )}
          </div>
          <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">{meta.note}</div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <label htmlFor={inputId} className="sr-only">
            {meta.label} retention, {meta.unit}
          </label>
          <span className="inline-flex items-center gap-1.5">
            <input
              id={inputId}
              type="number"
              min={1}
              inputMode="numeric"
              value={edit.value}
              disabled={!edit.enabled}
              aria-describedby={lowered ? warnId : undefined}
              onChange={(e) => onValueChange(Math.max(1, Number(e.target.value) || 1))}
              className="w-[72px] h-8 px-2 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary tppm-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:border-brand-primary disabled:opacity-40"
            />
            <span className="text-[12px] text-neutral-text-secondary">{meta.unit}</span>
          </span>
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          {disablable ? (
            <Toggle
              on={edit.enabled}
              onChange={onEnabledChange}
              label={`Enable ${meta.label} purge`}
            />
          ) : (
            <span className="text-[12px] text-neutral-text-secondary" aria-disabled="true">
              Always on
            </span>
          )}
        </td>
        <td className="px-4 py-3 text-right whitespace-nowrap text-[13px] text-neutral-text-secondary tppm-mono">
          ~{meta.row_count.toLocaleString()}
        </td>
        <td className="px-4 py-3 text-right whitespace-nowrap text-[13px] text-neutral-text-secondary tppm-mono">
          ~{formatBytes(meta.bytes)}
        </td>
      </tr>
      {lowered && (
        <tr className="border-b border-neutral-border/55">
          <td colSpan={5} className="px-4 pb-3 pt-0">
            <div
              id={warnId}
              role="status"
              className="rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg px-3 py-2 text-[12px] text-neutral-text-primary"
            >
              {impact.isFetching ? (
                <span className="text-neutral-text-secondary">Checking impact…</span>
              ) : impact.isError ? (
                <span className="text-neutral-text-secondary">{"Couldn't estimate impact."}</span>
              ) : impact.data ? (
                <>
                  <span className="font-semibold text-semantic-at-risk">⚠ </span>
                  Lowering {meta.label} to {edit.value} {meta.unit} makes{' '}
                  <span className="font-semibold tppm-mono">
                    ~{impact.data.eligible_rows.toLocaleString()}
                  </span>{' '}
                  rows ({formatBytes(impact.data.eligible_bytes)}) purge-eligible. Purged rows
                  cannot be recovered.
                </>
              ) : (
                <span className="text-neutral-text-secondary">Checking impact…</span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Recent purges log
// ---------------------------------------------------------------------------

const RUN_STATE_BADGE: Record<PurgeRunState, { label: string; cls: string; dot: string }> = {
  ok: { label: 'OK', cls: 'text-semantic-on-track', dot: 'bg-semantic-on-track' },
  partial: { label: 'Partial', cls: 'text-semantic-at-risk', dot: 'bg-semantic-at-risk' },
  failed: { label: 'Failed', cls: 'text-semantic-critical', dot: 'bg-semantic-critical' },
  // The running dot pulses under `motion-safe`; a permanent brand-colored ring keeps
  // the running state perceivable when the user has reduced-motion enabled (WCAG 2.3.3).
  running: {
    label: 'Running',
    cls: 'text-brand-primary',
    dot: 'bg-brand-primary motion-safe:animate-pulse ring-2 ring-brand-primary/40',
  },
};

export function RunStateBadge({ run }: { run: PurgeRun }) {
  if (run.trigger === 'dry_run' && run.state !== 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-neutral-text-secondary">
        <span className="w-2 h-2 rounded-full ring-1 ring-neutral-border" aria-hidden="true" />
        Dry run
      </span>
    );
  }
  const badge = RUN_STATE_BADGE[run.state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] font-medium ${badge.cls}`}>
      <span className={`w-2 h-2 rounded-full ${badge.dot}`} aria-hidden="true" />
      {badge.label}
    </span>
  );
}

function RunsLog({ runs }: { runs: PurgeRun[] }) {
  if (runs.length === 0) {
    return (
      <div className="px-4 py-6 text-[13px] text-neutral-text-secondary">
        No purges recorded yet — run one above or wait for the next scheduled run.
      </div>
    );
  }
  return (
    <table className="w-full text-[12px]" aria-label="Recent purges">
      <thead>
        <tr className="border-b border-neutral-border/55 bg-neutral-surface-sunken">
          {['Started', 'Duration', 'State', 'Tables', 'Rows', 'Freed'].map((h, i) => (
            <th
              key={h}
              scope="col"
              className={`px-4 py-2 font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase ${
                i >= 3 ? 'text-right' : 'text-left'
              }`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const completed = run.tables.filter((t) => t.state === 'ok').length;
          return (
            <tr key={run.id} className="border-b border-neutral-border/55 last:border-0">
              <td className="px-4 py-2 text-neutral-text-primary" title={run.started_at}>
                {formatTimeAgo(run.started_at)}
              </td>
              <td className="px-4 py-2 tppm-mono text-neutral-text-secondary">
                {run.duration_ms === null ? '—' : `${(run.duration_ms / 1000).toFixed(1)}s`}
              </td>
              <td className="px-4 py-2">
                <RunStateBadge run={run} />
              </td>
              <td className="px-4 py-2 text-right tppm-mono text-neutral-text-secondary">
                {completed} / {run.tables.length || 5}
              </td>
              <td className="px-4 py-2 text-right tppm-mono text-neutral-text-secondary">
                {run.rows_deleted.toLocaleString()}
                {run.trigger === 'dry_run' && ' (est)'}
              </td>
              <td className="px-4 py-2 text-right tppm-mono text-neutral-text-secondary">
                {formatBytes(run.bytes_freed)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Confirm-run dialog
// ---------------------------------------------------------------------------

function ConfirmRunDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  // Trap focus and route Escape to Cancel. Cancel is first in DOM so the trap
  // seats initial focus on the safe (Cancel) button — a destructive confirm must
  // never autofocus the destructive action (matches ConfirmDiscardDialog's
  // rationale). Focus restores to the trigger on close.
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4">
      <div
        ref={trapRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        className="w-full max-w-md rounded-card bg-neutral-surface-raised border border-neutral-border p-5 focus:outline-none"
      >
        <h2 id={titleId} className="text-[15px] font-semibold text-neutral-text-primary">
          Run purge now?
        </h2>
        <p id={bodyId} className="mt-2 text-[13px] text-neutral-text-secondary leading-relaxed">
          This permanently deletes rows older than each enabled retention window across the five
          operational tables. This cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-control bg-semantic-critical text-white text-[13px] font-semibold hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1"
          >
            Run purge
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function RetentionPurgePage() {
  const { data, isLoading, error, refetch } = useRetentionSettings();
  const updateRetention = useUpdateRetention();
  const runPurge = useRunPurge();

  const [policies, setPolicies] = useState<EditablePolicy[]>([]);
  const [schedule, setSchedule] = useState<RetentionSchedule>({
    frequency: 'daily',
    time_of_day_utc: '02:00:00',
    day_of_week: null,
    on_failure: 'continue',
  });
  const [initial, setInitial] = useState<{ policies: EditablePolicy[]; schedule: RetentionSchedule }>(
    { policies: [], schedule: schedule },
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // Seed page-local state from the loaded settings (and after a save/invalidation).
  useEffect(() => {
    if (!data) return;
    const snapshot = { policies: toEditable(data.policies), schedule: data.schedule };
    setPolicies(snapshot.policies);
    setSchedule(snapshot.schedule);
    setInitial(snapshot);
  }, [data]);

  const values = { policies, schedule };

  const onSave = useCallback(async () => {
    await updateRetention.mutateAsync({
      policies: policies.map((p) => ({ key: p.key, value: p.value, enabled: p.enabled })),
      schedule,
    });
    setInitial({ policies, schedule });
  }, [policies, schedule, updateRetention]);

  const onReset = useCallback(() => {
    setPolicies(initial.policies);
    setSchedule(initial.schedule);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: true });

  const setPolicyValue = (key: string, value: number) =>
    setPolicies((prev) => prev.map((p) => (p.key === key ? { ...p, value } : p)));
  const setPolicyEnabled = (key: string, enabled: boolean) =>
    setPolicies((prev) => prev.map((p) => (p.key === key ? { ...p, enabled } : p)));

  const triggerRun = async (dryRun: boolean) => {
    await runPurge.mutateAsync(dryRun);
    setActionMsg(dryRun ? 'Dry run queued — results appear below.' : 'Purge queued — results appear below.');
    window.setTimeout(() => setActionMsg(null), 6000);
  };

  if (isLoading) {
    return (
      <div className="px-6 py-5 space-y-5" aria-busy="true" aria-label="Loading retention settings">
        <div className="h-[260px] rounded-card bg-neutral-surface-raised motion-safe:animate-pulse border border-neutral-border" />
        <div className="h-[150px] rounded-card bg-neutral-surface-raised motion-safe:animate-pulse border border-neutral-border" />
        <div className="h-[180px] rounded-card bg-neutral-surface-raised motion-safe:animate-pulse border border-neutral-border" />
      </div>
    );
  }

  if (error && !data) {
    const is403 = axios.isAxiosError(error) && error.response?.status === 403;
    return (
      <div className="px-6 py-8 flex flex-col gap-3 items-start">
        <p className="text-[13px] text-semantic-critical">
          {is403
            ? 'Admin access required. Contact your workspace owner.'
            : "Couldn't load retention settings — the API may be unreachable."}
        </p>
        {!is403 && (
          <button
            type="button"
            onClick={() => void refetch()}
            className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const state = data as RetentionState;
  const metaByKey = new Map(state.policies.map((p) => [p.key, p]));
  const initialByKey = new Map(initial.policies.map((p) => [p.key, p.value]));

  return (
    <div>
      <SettingsPageTitle
        title="Retention & purge"
        subtitle="Operational data is deleted permanently once older than its window. Times are UTC, no DST."
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void triggerRun(true)}
              disabled={runPurge.isPending}
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 disabled:opacity-60"
            >
              Dry run
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              disabled={runPurge.isPending}
              className="px-3 py-1.5 rounded-control border border-semantic-critical text-[13px] font-semibold text-semantic-critical hover:bg-semantic-critical-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:opacity-60"
            >
              Run purge now
            </button>
          </div>
        }
      />

      <div className="px-6 py-5 space-y-5 max-w-[960px]">
        {actionMsg && (
          <div
            role="status"
            className="rounded-card border border-brand-primary/40 bg-brand-primary-light px-3 py-2 text-[13px] text-brand-primary"
          >
            {actionMsg}
          </div>
        )}

        {/* Per-table policy table */}
        <SettingsCard>
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">Retention windows</h2>
          </div>
          <table className="w-full text-[13px]" aria-label="Retention windows">
            <thead>
              <tr className="border-b border-neutral-border/55 bg-neutral-surface-sunken">
                <th scope="col" className="px-4 py-2 text-left font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase">
                  Table
                </th>
                <th scope="col" className="px-4 py-2 text-left font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase">
                  Retention
                </th>
                <th scope="col" className="px-4 py-2 text-left font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase">
                  Enabled
                </th>
                <th scope="col" className="px-4 py-2 text-right font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase">
                  Est. rows
                </th>
                <th scope="col" className="px-4 py-2 text-right font-semibold text-neutral-text-secondary text-[11px] tracking-[.06em] uppercase">
                  Est. size
                </th>
              </tr>
            </thead>
            <tbody>
              {policies.map((edit) => {
                const meta = metaByKey.get(edit.key);
                if (!meta) return null;
                return (
                  <PolicyRow
                    key={edit.key}
                    meta={meta}
                    edit={edit}
                    initialValue={initialByKey.get(edit.key) ?? edit.value}
                    onValueChange={(v) => setPolicyValue(edit.key, v)}
                    onEnabledChange={(en) => setPolicyEnabled(edit.key, en)}
                  />
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-2.5 text-[11px] text-neutral-text-secondary border-t border-neutral-border/55">
            Row counts and sizes are PostgreSQL estimates, refreshed on load.
          </p>
        </SettingsCard>

        {/* Schedule */}
        <SettingsCard>
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">Purge schedule</h2>
          </div>
          <div className="px-4 py-3 space-y-4">
            <ScheduleFields schedule={schedule} onChange={setSchedule} />
          </div>
        </SettingsCard>

        {/* Recent purges */}
        <SettingsCard>
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">Recent purges</h2>
          </div>
          <RunsLog runs={state.runs} />
        </SettingsCard>
      </div>

      {confirmOpen && (
        <ConfirmRunDialog
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void triggerRun(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule fields
// ---------------------------------------------------------------------------

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'off', label: 'Off' },
];

function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: RetentionSchedule;
  onChange: (s: RetentionSchedule) => void;
}) {
  const timeId = useId();
  const dowId = useId();
  const off = schedule.frequency === 'off';

  return (
    <div className="space-y-4">
      {/* Frequency */}
      <div className="flex items-center gap-4">
        <span className="text-[13px] font-medium text-neutral-text-primary w-32 shrink-0">Frequency</span>
        <div className="inline-flex rounded-control border border-neutral-border overflow-hidden" role="radiogroup" aria-label="Purge frequency">
          {FREQUENCIES.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={schedule.frequency === f.value}
              onClick={() =>
                onChange({
                  ...schedule,
                  frequency: f.value,
                  day_of_week:
                    f.value === 'weekly' && schedule.day_of_week === null ? 0 : schedule.day_of_week,
                })
              }
              className={[
                'px-3 h-8 text-[13px] font-medium border-r border-neutral-border last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
                schedule.frequency === f.value
                  ? 'bg-sage-500 text-navy-900'
                  : 'bg-neutral-surface-raised text-neutral-text-primary hover:bg-neutral-surface-sunken',
              ].join(' ')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Day of week (weekly only) */}
      {schedule.frequency === 'weekly' && (
        <div className="flex items-center gap-4">
          <label htmlFor={dowId} className="text-[13px] font-medium text-neutral-text-primary w-32 shrink-0">
            Day of week
          </label>
          <select
            id={dowId}
            value={schedule.day_of_week ?? 0}
            onChange={(e) => onChange({ ...schedule, day_of_week: Number(e.target.value) })}
            className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {DOW.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Time of day */}
      <div className={`flex items-center gap-4 ${off ? 'opacity-40' : ''}`}>
        <label htmlFor={timeId} className="text-[13px] font-medium text-neutral-text-primary w-32 shrink-0">
          Time of day
        </label>
        <input
          id={timeId}
          type="time"
          disabled={off}
          value={schedule.time_of_day_utc.slice(0, 5)}
          onChange={(e) =>
            onChange({
              ...schedule,
              time_of_day_utc: e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value,
            })
          }
          className="h-8 px-2.5 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary tppm-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:cursor-not-allowed"
        />
        <span className="text-[12px] text-neutral-text-secondary">Runs at this UTC time — no DST shift.</span>
      </div>

      {/* On failure */}
      <div className={`flex items-start gap-4 ${off ? 'opacity-40' : ''}`}>
        <span className="text-[13px] font-medium text-neutral-text-primary w-32 shrink-0 pt-1">On failure</span>
        <div className="space-y-1.5" role="radiogroup" aria-label="On-failure behavior">
          {(
            [
              { value: 'continue', label: 'Continue and flag the failed table', hint: 'Purges remaining tables; the failed table is marked in the run.' },
              { value: 'stop', label: 'Stop the run on first error', hint: 'Aborts the run as soon as a table fails.' },
            ] as const
          ).map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
              <input
                type="radio"
                name="on_failure"
                value={opt.value}
                disabled={off}
                checked={schedule.on_failure === opt.value}
                onChange={() => onChange({ ...schedule, on_failure: opt.value })}
                className="mt-0.5 accent-brand-primary"
              />
              <span>
                {opt.label}
                <span className="block text-[12px] text-neutral-text-secondary">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
