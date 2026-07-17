import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, MouseEvent } from 'react';
import axios from 'axios';
import type { CeremonyCadenceType, CeremonyTemplate } from '@/api/types';
import {
  useCreateCeremony,
  useUpdateCeremony,
  type CeremonyCreatePayload,
} from '@/features/programs/hooks/useProgramCeremonyMutations';
import { isReservedScrumName } from './reservedScrumNames';
import {
  MONTHLY_ORDINAL_OPTIONS,
  OWNER_ROLE_SUGGESTIONS,
  WEEKDAY_OPTIONS,
  formatTime,
  parseMonthlyDay,
} from './cadenceCopy';

export interface CeremonyModalProps {
  programId: string;
  ceremony?: CeremonyTemplate;
  onClose: () => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  cadence_type: CeremonyCadenceType;
  /** Weekly/biweekly weekday slug. */
  weekday: string;
  /** Monthly ordinal (1st, 2nd…). */
  monthly_ordinal: string;
  /** Monthly weekday slug. */
  monthly_weekday: string;
  /** "HH:MM" — DRF accepts seconds-less time strings. */
  time: string;
  duration_minutes: number;
  owner_role: string;
  enabled: boolean;
}

function makeInitial(ceremony: CeremonyTemplate | undefined): FormState {
  if (!ceremony) {
    return {
      name: '',
      cadence_type: 'weekly',
      weekday: 'monday',
      monthly_ordinal: '1st',
      monthly_weekday: 'thursday',
      time: '10:00',
      duration_minutes: 60,
      owner_role: 'Program Manager',
      enabled: true,
    };
  }
  const monthly = parseMonthlyDay(ceremony.cadence_day);
  return {
    name: ceremony.name,
    cadence_type: ceremony.cadence_type,
    weekday:
      ceremony.cadence_type === 'weekly' || ceremony.cadence_type === 'biweekly'
        ? ceremony.cadence_day || 'monday'
        : 'monday',
    monthly_ordinal: monthly?.ordinal ?? '1st',
    monthly_weekday: monthly?.weekday ?? 'thursday',
    time: formatTime(ceremony.cadence_time) || '10:00',
    duration_minutes: ceremony.duration_minutes,
    owner_role: ceremony.owner_role,
    enabled: ceremony.enabled,
  };
}

function buildPayload(state: FormState): CeremonyCreatePayload {
  if (state.cadence_type === 'on_milestone') {
    return {
      name: state.name.trim(),
      cadence_type: 'on_milestone',
      cadence_day: '',
      cadence_time: null,
      duration_minutes: state.duration_minutes,
      owner_role: state.owner_role.trim(),
      enabled: state.enabled,
    };
  }
  const cadence_day =
    state.cadence_type === 'monthly'
      ? `${state.monthly_ordinal}-${state.monthly_weekday}`
      : state.weekday;
  return {
    name: state.name.trim(),
    cadence_type: state.cadence_type,
    cadence_day,
    // DRF TimeField accepts "HH:MM".
    cadence_time: state.time,
    duration_minutes: state.duration_minutes,
    owner_role: state.owner_role.trim(),
    enabled: state.enabled,
  };
}

function formatMutationError(error: Error): string {
  if (axios.isAxiosError(error) && error.response?.data) {
    const data = error.response.data as Record<string, unknown>;
    if (typeof data.detail === 'string') return data.detail;
    const messages: string[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (Array.isArray(val)) messages.push(`${key}: ${val.join(', ')}`);
      else if (typeof val === 'string') messages.push(`${key}: ${val}`);
    }
    if (messages.length > 0) return messages.join('. ');
  }
  return error.message || 'Couldn’t save ceremony.';
}

/**
 * Add/edit modal for a CeremonyTemplate (ADR-0079).
 *
 * Fields gate on ``cadence_type``:
 *   weekly / biweekly → weekday + time
 *   monthly           → ordinal + weekday + time
 *   on_milestone      → no day, no time
 *
 * Mirrors the Scrum reserved-name validation that the API enforces
 * (``RESERVED_SCRUM_CEREMONY_NAMES``) so the user gets feedback without
 * a round trip.
 */
export function CeremonyModal({ programId, ceremony, onClose, onSaved }: CeremonyModalProps) {
  const [state, setState] = useState<FormState>(() => makeInitial(ceremony));
  const [formError, setFormError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const create = useCreateCeremony(programId);
  const update = useUpdateCeremony(programId);
  const isPending = create.isPending || update.isPending;

  const isEdit = !!ceremony;
  const reservedHit = useMemo(() => isReservedScrumName(state.name), [state.name]);
  const nameInvalid = !state.name.trim() || reservedHit;

  // Autofocus the name field on open; trap Escape to close.
  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !isPending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isPending, onClose]);

  function update_<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setState((s) => ({ ...s, [key]: value }));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setFormError(null);
    if (nameInvalid) return;
    const payload = buildPayload(state);
    try {
      if (isEdit && ceremony) {
        await update.mutateAsync({ ceremonyId: ceremony.id, patch: payload });
      } else {
        await create.mutateAsync(payload);
      }
      onSaved();
    } catch (err) {
      setFormError(formatMutationError(err as Error));
    }
  }

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget && !isPending) onClose();
  }

  return (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-overlay p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ceremony-modal-title"
        className="w-full max-w-[520px] rounded-card bg-neutral-surface-raised border border-neutral-border"
      >
        <header className="px-5 py-3 border-b border-neutral-border/55">
          <h2
            id="ceremony-modal-title"
            className="text-[14px] font-semibold text-neutral-text-primary"
          >
            {isEdit && ceremony ? `Edit ceremony · ${ceremony.name}` : 'Add ceremony'}
          </h2>
          <p className="text-xs text-neutral-text-secondary mt-0.5 leading-snug">
            Program-level cadence. Sprint events (Planning, Review, Retrospective) are configured
            per-sprint in Project settings.
          </p>
        </header>

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="px-5 py-4 space-y-4"
        >
          {/* Name */}
          <div>
            <label
              htmlFor="ceremony-name"
              className="block text-xs font-semibold text-neutral-text-primary mb-1"
            >
              Name{' '}
              <span aria-hidden="true" className="text-semantic-critical">
                *
              </span>
            </label>
            <input
              ref={nameRef}
              id="ceremony-name"
              type="text"
              value={state.name}
              onChange={(e) => update_('name', e.target.value)}
              placeholder="e.g. Program sync"
              aria-invalid={reservedHit || undefined}
              aria-describedby={reservedHit ? 'ceremony-name-error' : undefined}
              required
              maxLength={120}
              className="w-full px-2.5 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            />
            {reservedHit && (
              <p
                id="ceremony-name-error"
                role="alert"
                className="text-xs text-semantic-critical mt-1 leading-snug"
              >
                Sprint events are configured per-sprint, not as program-level ceremonies. Try a
                program-level name like &ldquo;Program sync&rdquo; or &ldquo;Steering
                committee&rdquo;.
              </p>
            )}
          </div>

          {/* Cadence type */}
          <fieldset>
            <legend className="block text-xs font-semibold text-neutral-text-primary mb-1.5">
              Cadence{' '}
              <span aria-hidden="true" className="text-semantic-critical">
                *
              </span>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'biweekly', label: 'Bi-weekly' },
                  { value: 'monthly', label: 'Monthly' },
                  { value: 'on_milestone', label: 'On milestone' },
                ] as { value: CeremonyCadenceType; label: string }[]
              ).map((opt) => {
                const selected = state.cadence_type === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={[
                      'flex items-center gap-2 px-2.5 py-1.5 rounded-card border text-[13px] cursor-pointer',
                      selected
                        ? 'bg-brand-primary/8 border-brand-primary text-brand-primary-dark font-medium'
                        : 'bg-neutral-surface-base border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="cadence_type"
                      value={opt.value}
                      checked={selected}
                      onChange={() => update_('cadence_type', opt.value)}
                      className="sr-only"
                    />
                    <span aria-hidden="true">{selected ? '●' : '○'}</span>
                    {opt.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Day / time row — hidden for on_milestone */}
          {state.cadence_type !== 'on_milestone' && (
            <div className="grid grid-cols-[1fr_120px_120px] gap-3">
              <div>
                <label
                  htmlFor="ceremony-day"
                  className="block text-xs font-semibold text-neutral-text-primary mb-1"
                >
                  Day
                </label>
                {state.cadence_type === 'monthly' ? (
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <select
                      id="ceremony-ordinal"
                      aria-label="Monthly ordinal"
                      value={state.monthly_ordinal}
                      onChange={(e) => update_('monthly_ordinal', e.target.value)}
                      className="px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                    >
                      {MONTHLY_ORDINAL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <select
                      id="ceremony-day"
                      aria-label="Monthly weekday"
                      value={state.monthly_weekday}
                      onChange={(e) => update_('monthly_weekday', e.target.value)}
                      className="px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                    >
                      {WEEKDAY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <select
                    id="ceremony-day"
                    value={state.weekday}
                    onChange={(e) => update_('weekday', e.target.value)}
                    className="w-full px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                  >
                    {WEEKDAY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label
                  htmlFor="ceremony-time"
                  className="block text-xs font-semibold text-neutral-text-primary mb-1"
                >
                  Time
                </label>
                <input
                  id="ceremony-time"
                  type="time"
                  required
                  value={state.time}
                  onChange={(e) => update_('time', e.target.value)}
                  className="w-full px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                />
              </div>
              <div>
                <label
                  htmlFor="ceremony-duration"
                  className="block text-xs font-semibold text-neutral-text-primary mb-1"
                >
                  Duration
                </label>
                <select
                  id="ceremony-duration"
                  value={state.duration_minutes}
                  onChange={(e) => update_('duration_minutes', Number(e.target.value))}
                  className="w-full px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                >
                  {[15, 30, 45, 60, 75, 90, 120, 180].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Duration only — for on_milestone */}
          {state.cadence_type === 'on_milestone' && (
            <div className="grid grid-cols-[120px] gap-3">
              <div>
                <label
                  htmlFor="ceremony-duration"
                  className="block text-xs font-semibold text-neutral-text-primary mb-1"
                >
                  Duration
                </label>
                <select
                  id="ceremony-duration"
                  value={state.duration_minutes}
                  onChange={(e) => update_('duration_minutes', Number(e.target.value))}
                  className="w-full px-2 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
                >
                  {[30, 45, 60, 90, 120, 180].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Owner role */}
          <div>
            <label
              htmlFor="ceremony-owner"
              className="block text-xs font-semibold text-neutral-text-primary mb-1"
            >
              Owner role
            </label>
            <input
              id="ceremony-owner"
              list="ceremony-owner-suggestions"
              type="text"
              value={state.owner_role}
              onChange={(e) => update_('owner_role', e.target.value)}
              placeholder="e.g. Program Manager"
              maxLength={64}
              className="w-full px-2.5 py-1.5 rounded-control border border-neutral-border bg-neutral-surface-base text-[13px]"
            />
            <datalist id="ceremony-owner-suggestions">
              {OWNER_ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <p className="text-xs text-neutral-text-secondary mt-1">
              Who chairs this ceremony. Free text — type your own if your team uses a different
              title.
            </p>
          </div>

          {/* Enabled */}
          <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => update_('enabled', e.target.checked)}
              className="rounded-control border-neutral-border text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            Enabled when saved
          </label>

          {formError && (
            <div
              role="alert"
              className="rounded-card border border-semantic-critical/40 bg-semantic-critical-bg px-3 py-2 text-xs text-semantic-critical"
            >
              {formError}
            </div>
          )}

          <footer className="flex justify-end gap-2 pt-2 border-t border-neutral-border/55 -mx-5 px-5 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="px-3 py-1.5 rounded-control border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending || nameInvalid}
              className="px-3 py-1.5 rounded-control bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
