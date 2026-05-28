/**
 * RecurrenceSection — task drawer section for recurring tasks (ADR-0090, #738).
 *
 * Turns a task into a calendar-cadence series (daily standup, weekly safety walk,
 * monthly review). Configures frequency / interval / weekday / day-of-month / time /
 * timezone, an end condition, and per-occurrence inheritance toggles, with a live
 * client-computed "Next 4 occurrences" preview. A prominent banner states the
 * recurring task is excluded from CPM / the critical path / Monte Carlo — recurring
 * occurrences are parallel, calendar-driven tasks, not nodes in the logical network.
 *
 * Registered against `task_detail.section` (priority 700). Gated to non-summary,
 * non-milestone tasks in sections/index.ts. Writes require Scheduler+ (Members see a
 * read-only summary). Editing is an explicit Save, not auto-save: attaching/detaching
 * a rule re-triggers a server-side CPM recompute, so we don't want a recompute per
 * keystroke — the preview updates live regardless.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DrawerSectionProps } from '@/lib/widget-registry';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import {
  useCreateRecurrenceRule,
  useDeleteRecurrenceRule,
  useRecurrenceRule,
  useUpdateRecurrenceRule,
} from '@/hooks/useRecurrenceRule';
import type { RecurrenceRuleInput, TaskRecurrenceRule } from '@/hooks/useRecurrenceRule';
import {
  WEEKDAYS,
  bitForDate,
  computeNextOccurrences,
  formatOccurrence,
  toggleWeekday,
  type RecurrenceEndType,
  type RecurrenceFrequency,
} from '@/lib/recurrence';

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: RecurrenceFrequency; label: string }> = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'CUSTOM', label: 'Custom' },
];

const INTERVAL_UNIT: Record<RecurrenceFrequency, string> = {
  DAILY: 'days',
  WEEKLY: 'weeks',
  MONTHLY: 'months',
  CUSTOM: 'days',
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Full IANA list when the engine supports it, else just the local zone. */
function supportedTimezones(): string[] {
  const sv = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof sv === 'function') {
    try {
      return sv('timeZone');
    } catch {
      /* fall through to local zone */
    }
  }
  return [browserTimezone()];
}

/** Sensible defaults for a brand-new rule: weekly on today, 09:00 local, never-ending. */
function defaultDraft(taskId: string): RecurrenceRuleInput {
  const today = new Date();
  return {
    task: taskId,
    frequency: 'WEEKLY',
    interval: 1,
    weekdays: bitForDate(today),
    day_of_month: today.getDate(),
    time_of_day: '09:00',
    timezone: browserTimezone(),
    end_type: 'NEVER',
    end_date: null,
    end_count: null,
    inherit_assignee: true,
    inherit_subtasks: false,
    inherit_attachments: false,
    inherit_morning_notification: false,
  };
}

function draftFromRule(rule: TaskRecurrenceRule): RecurrenceRuleInput {
  return {
    task: rule.task,
    frequency: rule.frequency,
    interval: rule.interval,
    weekdays: rule.weekdays,
    day_of_month: rule.day_of_month,
    time_of_day: rule.time_of_day.slice(0, 5),
    timezone: rule.timezone,
    end_type: rule.end_type,
    end_date: rule.end_date,
    end_count: rule.end_count,
    inherit_assignee: rule.inherit_assignee,
    inherit_subtasks: rule.inherit_subtasks,
    inherit_attachments: rule.inherit_attachments,
    inherit_morning_notification: rule.inherit_morning_notification,
  };
}

/** Client mirror of the server's clean() invariants — returns a message, or null if valid. */
function validateDraft(draft: RecurrenceRuleInput): string | null {
  if (draft.frequency === 'WEEKLY' && draft.weekdays === 0) {
    return 'Pick at least one weekday for a weekly recurrence.';
  }
  if (draft.frequency === 'MONTHLY' && (draft.day_of_month == null || draft.day_of_month < 1 || draft.day_of_month > 31)) {
    return 'Choose a day of the month (1–31) for a monthly recurrence.';
  }
  if (draft.interval < 1) {
    return 'The interval must be at least 1.';
  }
  if (draft.end_type === 'ON_DATE' && !draft.end_date) {
    return 'Choose the date the recurrence ends.';
  }
  if (draft.end_type === 'AFTER_N' && (draft.end_count == null || draft.end_count < 1)) {
    return 'Choose how many occurrences before it ends.';
  }
  return null;
}

/** Pull a readable message out of a DRF / axios validation error. */
function serverErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (data && typeof data === 'object') {
    const parts: string[] = [];
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value)) parts.push(value.map(String).join(' '));
      else if (typeof value === 'string') parts.push(value);
    }
    if (parts.length) return parts.join(' ');
  }
  return 'Could not save the recurrence. Please try again.';
}

const LABEL = 'text-xs font-medium uppercase tracking-wide text-neutral-text-secondary tppm-mono';

/** Label + control row — 7rem label column on the left, wraps to stacked on narrow widths. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-neutral-border py-2.5 sm:grid-cols-[7rem_1fr] sm:gap-3">
      <span className={`${LABEL} pt-1`}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Heads-up banner: recurring tasks never enter the CPM graph. */
function CpmExclusionBanner() {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-md border border-semantic-warning bg-semantic-warning-bg px-3 py-2.5 text-xs leading-relaxed text-neutral-text-primary"
    >
      {/* Body copy uses the high-contrast neutral token, not amber-on-amber-bg
          (which fails WCAG 1.4.3 at body size). The warning is still carried by the
          amber border, tint, and glyph. */}
      <span aria-hidden="true" className="text-semantic-warning">
        ⚠
      </span>
      <span>
        <strong className="font-semibold">Heads up:</strong> recurrences aren&apos;t added to the
        schedule&apos;s CPM compute — they run parallel to the project plan, not as a dependency in
        it (excluded from the critical path and Monte Carlo).
      </span>
    </div>
  );
}

/** Live "Next 4 occurrences" preview computed from the working draft. */
function OccurrencePreview({ draft, occurrenceCount }: { draft: RecurrenceRuleInput; occurrenceCount: number }) {
  const items = useMemo(
    () => computeNextOccurrences({ ...draft, occurrence_count: occurrenceCount }, 4),
    [draft, occurrenceCount],
  );
  return (
    <div className="rounded-md bg-neutral-surface-sunken px-3 py-2.5">
      <div className={`${LABEL} mb-1`}>Next 4 occurrences</div>
      {/* Announce the recomputed dates to assistive tech as the rule is edited. */}
      <div aria-live="polite">
        {items.length === 0 ? (
          <p className="text-xs text-neutral-text-secondary">
            This rule doesn&apos;t produce any upcoming occurrences.
          </p>
        ) : (
          <p className="tppm-mono text-xs text-neutral-text-primary">
            {items.map(formatOccurrence).join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}

const PILL_BASE =
  'rounded px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-50';

interface FormProps {
  taskId: string;
  rule: TaskRecurrenceRule | null;
  onClose: () => void;
}

/** The Scheduler+ editor — create (no rule) or edit (existing rule). */
function RecurrenceForm({ taskId, rule, onClose }: FormProps) {
  const [draft, setDraft] = useState<RecurrenceRuleInput>(() =>
    rule ? draftFromRule(rule) : defaultDraft(taskId),
  );
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Move focus to the destructive confirm button when the inline confirm appears,
  // so a keyboard user isn't stranded on a button that was just replaced.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus();
  }, [confirmingDelete]);

  const create = useCreateRecurrenceRule();
  const update = useUpdateRecurrenceRule();
  const remove = useDeleteRecurrenceRule();
  const saving = create.isPending || update.isPending;

  const timezones = useMemo(supportedTimezones, []);
  const clientError = validateDraft(draft);

  function set<K extends keyof RecurrenceRuleInput>(key: K, value: RecurrenceRuleInput[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function changeFrequency(frequency: RecurrenceFrequency) {
    // DAILY is "every day": pin interval to 1 and clear the (hidden) interval input.
    setDraft((d) => ({ ...d, frequency, interval: frequency === 'DAILY' ? 1 : Math.max(d.interval, 1) }));
  }

  function changeEndType(end_type: RecurrenceEndType) {
    setDraft((d) => ({
      ...d,
      end_type,
      end_date: end_type === 'ON_DATE' ? d.end_date : null,
      end_count: end_type === 'AFTER_N' ? (d.end_count ?? 12) : null,
    }));
  }

  function handleSave() {
    if (clientError) {
      setServerError(clientError);
      return;
    }
    setServerError(null);
    const onError = (err: Error) => setServerError(serverErrorMessage(err));
    if (rule) {
      update.mutate({ ruleId: rule.id, taskId, patch: draft }, { onSuccess: onClose, onError });
    } else {
      create.mutate(draft, { onSuccess: onClose, onError });
    }
  }

  function handleDelete() {
    if (!rule) return;
    remove.mutate(
      { ruleId: rule.id, taskId },
      { onSuccess: onClose, onSettled: () => setConfirmingDelete(false) },
    );
  }

  const showInterval = draft.frequency !== 'DAILY';

  return (
    <div className="flex flex-col gap-2">
      <CpmExclusionBanner />

      <Row label="Repeats">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Repeat frequency">
          {FREQUENCY_OPTIONS.map((opt) => {
            const active = draft.frequency === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => changeFrequency(opt.value)}
                className={`${PILL_BASE} ${
                  active
                    ? 'bg-brand-primary text-white'
                    : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </Row>

      {showInterval && (
        <Row label="Every">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={365}
              value={draft.interval}
              onChange={(e) => set('interval', Math.max(1, Number(e.target.value) || 1))}
              aria-label={`Interval in ${INTERVAL_UNIT[draft.frequency]}`}
              className="h-8 w-16 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            />
            <span className="text-sm text-neutral-text-secondary">{INTERVAL_UNIT[draft.frequency]}</span>
          </div>
        </Row>
      )}

      {draft.frequency === 'WEEKLY' && (
        <Row label="On">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Days of week">
            {WEEKDAYS.map((wd) => {
              const on = (draft.weekdays & wd.bit) !== 0;
              return (
                <button
                  key={wd.bit}
                  type="button"
                  aria-pressed={on}
                  aria-label={wd.label}
                  onClick={() => set('weekdays', toggleWeekday(draft.weekdays, wd.bit))}
                  className={`flex h-11 w-11 items-center justify-center rounded-full text-xs font-bold focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 ${
                    on
                      ? 'bg-brand-primary text-white'
                      : 'bg-neutral-surface text-neutral-text-secondary hover:bg-neutral-surface-raised'
                  }`}
                >
                  {wd.short}
                </button>
              );
            })}
          </div>
        </Row>
      )}

      {draft.frequency === 'MONTHLY' && (
        <Row label="Day of month">
          <input
            type="number"
            min={1}
            max={31}
            value={draft.day_of_month ?? ''}
            onChange={(e) => set('day_of_month', e.target.value ? Number(e.target.value) : null)}
            aria-label="Day of month"
            className="h-8 w-16 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          />
        </Row>
      )}

      <Row label="Time">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="time"
            value={draft.time_of_day}
            onChange={(e) => set('time_of_day', e.target.value)}
            aria-label="Time of day"
            className="h-8 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          />
          <select
            value={draft.timezone}
            onChange={(e) => set('timezone', e.target.value)}
            aria-label="Timezone"
            className="h-8 max-w-[14rem] rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            {!timezones.includes(draft.timezone) && (
              <option value={draft.timezone}>{draft.timezone}</option>
            )}
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </div>
      </Row>

      <Row label="Ends">
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Ends">
          <label className="flex items-center gap-2 text-sm text-neutral-text-primary">
            <input
              type="radio"
              name="recurrence-end"
              checked={draft.end_type === 'NEVER'}
              onChange={() => changeEndType('NEVER')}
            />
            Never
          </label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-neutral-text-primary">
              <input
                type="radio"
                name="recurrence-end"
                checked={draft.end_type === 'ON_DATE'}
                onChange={() => changeEndType('ON_DATE')}
              />
              On
            </label>
            <input
              type="date"
              value={draft.end_date ?? ''}
              disabled={draft.end_type !== 'ON_DATE'}
              onChange={(e) => set('end_date', e.target.value || null)}
              aria-label="End date"
              className="h-8 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-40"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-neutral-text-primary">
              <input
                type="radio"
                name="recurrence-end"
                checked={draft.end_type === 'AFTER_N'}
                onChange={() => changeEndType('AFTER_N')}
              />
              After
            </label>
            <input
              type="number"
              min={1}
              max={999}
              value={draft.end_count ?? ''}
              disabled={draft.end_type !== 'AFTER_N'}
              onChange={(e) => set('end_count', e.target.value ? Number(e.target.value) : null)}
              aria-label="Number of occurrences"
              className="h-8 w-16 rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-40"
            />
            <span className="text-sm text-neutral-text-secondary">occurrences</span>
          </div>
        </div>
      </Row>

      <Row label="Each occurrence">
        <div className="flex flex-col gap-2">
          <Toggle
            label="Inherit assignees"
            checked={draft.inherit_assignee}
            onChange={(v) => set('inherit_assignee', v)}
          />
          <Toggle
            label="Inherit attachments"
            checked={draft.inherit_attachments}
            onChange={(v) => set('inherit_attachments', v)}
          />
          <Toggle
            label="Inherit subtasks"
            checked={draft.inherit_subtasks}
            onChange={(v) => set('inherit_subtasks', v)}
            deferred
          />
          <Toggle
            label="Notify assignees the morning of"
            checked={draft.inherit_morning_notification}
            onChange={(v) => set('inherit_morning_notification', v)}
            deferred
          />
        </div>
      </Row>

      <OccurrencePreview draft={draft} occurrenceCount={rule?.occurrence_count ?? 0} />

      {serverError && (
        <p className="text-xs text-semantic-critical" role="alert">
          {serverError}
        </p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || clientError !== null}
          className="rounded bg-brand-primary px-3 h-9 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-50"
        >
          {saving ? 'Saving…' : rule ? 'Save recurrence' : 'Add recurrence'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-3 h-9 text-sm text-neutral-text-secondary hover:bg-neutral-surface focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          Cancel
        </button>
        {rule &&
          (confirmingDelete ? (
            <span className="ml-auto flex items-center gap-2">
              <span className="text-xs text-neutral-text-secondary">Existing occurrences are kept.</span>
              <button
                ref={confirmRef}
                type="button"
                onClick={handleDelete}
                onKeyDown={(e) => {
                  // Escape from the focused confirm button cancels (focus lands here via the effect).
                  if (e.key === 'Escape') setConfirmingDelete(false);
                }}
                disabled={remove.isPending}
                className="rounded bg-semantic-critical px-3 h-9 text-sm font-medium text-white hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:opacity-50"
              >
                {remove.isPending ? 'Stopping…' : 'Confirm stop'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                className="rounded px-2 h-9 text-sm text-neutral-text-secondary hover:bg-neutral-surface focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="ml-auto rounded px-3 h-9 text-sm text-semantic-critical hover:bg-semantic-critical/10 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              Stop recurring
            </button>
          ))}
      </div>
      {remove.isError && (
        <p className="text-xs text-semantic-critical" role="alert">
          Couldn&apos;t stop the recurrence. Please try again.
        </p>
      )}
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Stored on the rule but not materialized yet (ADR-0090) — render disabled + labeled. */
  deferred?: boolean;
}

function Toggle({ label, checked, onChange, deferred }: ToggleProps) {
  return (
    <label
      className={`flex items-center gap-2 text-sm ${
        deferred ? 'text-neutral-text-secondary' : 'text-neutral-text-primary'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={deferred}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-neutral-border text-brand-primary focus:ring-brand-primary disabled:opacity-50"
      />
      <span>{label}</span>
      {deferred && (
        <span
          className="rounded-full bg-neutral-surface px-2 py-0.5 text-xs uppercase tracking-wide text-neutral-text-secondary"
          title="Stored for a future release — has no effect yet."
        >
          Not active yet
        </span>
      )}
    </label>
  );
}

/** Member (read-only) summary of a configured rule. */
function RecurrenceReadOnly({ rule }: { rule: TaskRecurrenceRule }) {
  const draft = useMemo(() => draftFromRule(rule), [rule]);
  const summary = useMemo(() => describeRule(rule), [rule]);
  return (
    <div className="flex flex-col gap-2">
      <CpmExclusionBanner />
      <p className="text-sm text-neutral-text-primary">{summary}</p>
      <OccurrencePreview draft={draft} occurrenceCount={rule.occurrence_count} />
    </div>
  );
}

/** One-line human summary, e.g. "Every 2 weeks on Mon, Wed at 09:00 · ends May 31, 2027". */
function describeRule(rule: TaskRecurrenceRule): string {
  const n = rule.interval > 1 ? `${rule.interval} ` : '';
  let base: string;
  switch (rule.frequency) {
    case 'DAILY':
      base = 'Every day';
      break;
    case 'WEEKLY': {
      const days = WEEKDAYS.filter((wd) => rule.weekdays & wd.bit)
        .map((wd) => wd.label.slice(0, 3))
        .join(', ');
      base = `Every ${n}week${rule.interval > 1 ? 's' : ''}${days ? ` on ${days}` : ''}`;
      break;
    }
    case 'MONTHLY':
      base = `Every ${n}month${rule.interval > 1 ? 's' : ''} on day ${rule.day_of_month ?? '—'}`;
      break;
    case 'CUSTOM':
      base = `Every ${rule.interval} day${rule.interval > 1 ? 's' : ''}`;
      break;
    default:
      base = 'Recurring';
  }
  const time = rule.time_of_day.slice(0, 5);
  let ends = '';
  if (rule.end_type === 'ON_DATE' && rule.end_date) ends = ` · ends ${rule.end_date}`;
  else if (rule.end_type === 'AFTER_N' && rule.end_count) ends = ` · ${rule.end_count} occurrences`;
  return `${base} at ${time}${ends}`;
}

export function RecurrenceSection({ taskId, projectId }: DrawerSectionProps) {
  const { rule, isLoading, error } = useRecurrenceRule(projectId, taskId);
  const { role, isLoading: roleLoading } = useCurrentUserRole(projectId);
  const [editing, setEditing] = useState(false);

  // Pessimistic while the role loads: hide write affordances to avoid a flash of
  // controls a Member can't use (they'd 403 on save anyway).
  const canEdit = role !== null && role >= ROLE_SCHEDULER;

  if (isLoading || roleLoading) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading recurrence">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-9 rounded border border-neutral-border bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-semantic-critical" role="alert">
        Couldn&apos;t load the recurrence rule.
      </p>
    );
  }

  // Editing covers both create (rule === null) and edit (rule set), entered from
  // the empty state's Add button or the configured view's Edit button.
  if (editing) {
    return (
      <RecurrenceForm taskId={taskId} rule={rule} onClose={() => setEditing(false)} />
    );
  }

  if (!rule) {
    return (
      <div className="flex flex-col gap-2">
        <p
          role="note"
          className="rounded border border-dashed border-neutral-border bg-neutral-surface-sunken px-4 py-3 text-xs text-neutral-text-secondary"
        >
          🔁 This task doesn&apos;t repeat.
          {canEdit ? ' Add a recurrence to spawn it on a schedule.' : ''}
        </p>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="self-start rounded border border-neutral-border px-3 h-9 text-sm font-medium text-neutral-text-primary hover:bg-neutral-surface focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            Add recurrence
          </button>
        )}
      </div>
    );
  }

  // A rule exists.
  if (!canEdit) {
    return <RecurrenceReadOnly rule={rule} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <RecurrenceReadOnly rule={rule} />
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="self-start rounded border border-neutral-border px-3 h-9 text-sm font-medium text-neutral-text-primary hover:bg-neutral-surface focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
      >
        Edit recurrence
      </button>
    </div>
  );
}
