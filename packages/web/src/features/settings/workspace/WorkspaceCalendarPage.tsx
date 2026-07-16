import { useCallback, useEffect, useState } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useCalendars } from '@/hooks/useCalendars';
import { summarizeWorkingCalendar, SYSTEM_DEFAULT_CALENDAR } from '../project/calendarDisplay';
import type { CalendarOverridePolicy } from '@/api/types';

/**
 * Workspace > Working calendar defaults page (ADR-0441, issue #1987).
 *
 * The workspace is the non-null-ish ROOT of the Project → Program → Workspace
 * calendar cascade — `calendar` is nullable here too (null = fall through to the
 * hardcoded Mon-Fri/8h/UTC system default; there is no materialized system-default
 * `Calendar` row). Unlike the project/program pages, there is no parent scope to
 * inherit from, so this is a plain picker rather than an inherit-button + select
 * pair.
 *
 * `calendarOverridePolicy` governs whether programs and projects may deviate:
 *  - SUGGEST (default) → lower scopes may override; the workspace value only
 *    pre-fills.
 *  - INHERIT → the workspace value wins everywhere; lower-scope pickers are
 *    read-only.
 *  - ENFORCE → hard lock. Enterprise-only; the OSS surface disables the radio
 *    and shows the upsell badge, and the server degrades ENFORCE to SUGGEST when
 *    no enterprise provider is registered.
 */

export function WorkspaceCalendarPage() {
  const { data: ws, isLoading } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();
  const { calendars, isLoading: calendarsLoading, error: calendarsError } = useCalendars();

  const [calendarId, setCalendarId] = useState<string | null>(null);
  const [overridePolicy, setOverridePolicy] = useState<CalendarOverridePolicy>('suggest');

  const [initial, setInitial] = useState<{
    calendarId: string | null;
    overridePolicy: CalendarOverridePolicy;
  }>({ calendarId: null, overridePolicy: 'suggest' });

  // Seed local state once the query resolves (or re-resolves after a save).
  useEffect(() => {
    if (!ws) return;
    const snap = { calendarId: ws.calendar, overridePolicy: ws.calendarOverridePolicy };
    setCalendarId(snap.calendarId);
    setOverridePolicy(snap.overridePolicy);
    setInitial(snap);
  }, [ws]);

  const values = { calendarId, overridePolicy };

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({
      calendar: calendarId,
      calendarOverridePolicy: overridePolicy,
    });
    setInitial({ calendarId, overridePolicy });
  }, [calendarId, overridePolicy, updateSettings]);

  const onReset = useCallback(() => {
    setCalendarId(initial.calendarId);
    setOverridePolicy(initial.overridePolicy);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: true });

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-24 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }

  const selectedCalendar = calendarId ? (calendars.find((c) => c.id === calendarId) ?? null) : null;
  const summary = selectedCalendar
    ? summarizeWorkingCalendar(selectedCalendar)
    : summarizeWorkingCalendar(SYSTEM_DEFAULT_CALENDAR);

  return (
    <div>
      <SettingsPageTitle
        title="Working calendar"
        subtitle="Set the default working calendar for all new programs and projects. They can override it per scope unless you require a single calendar."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* Default calendar picker */}
        <section aria-labelledby="calendar-heading">
          <h2
            id="calendar-heading"
            className="text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mb-3"
          >
            Default calendar
          </h2>
          <div className="relative inline-block w-[280px]">
            <select
              value={calendarId ?? ''}
              onChange={(e) => setCalendarId(e.target.value === '' ? null : e.target.value)}
              aria-label="Default working calendar"
              // Disable while loading or if the fetch failed — an enabled empty
              // picker would be indistinguishable from "no calendars exist".
              disabled={calendarsLoading || !!calendarsError}
              className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
            >
              <option value="">
                {calendarsLoading
                  ? 'Loading calendars…'
                  : calendarsError
                    ? "Couldn't load calendars"
                    : 'System default (Mon–Fri, 8h/day)'}
              </option>
              {/* Keep the current default selectable even if it isn't in the fetched
                  list yet (still loading, or the calendar was removed), so the
                  <select> stays controlled without a value/option mismatch. */}
              {calendarId && !calendars.some((c) => c.id === calendarId) && (
                <option value={calendarId}>Current default</option>
              )}
              {calendars.map((cal) => (
                <option key={cal.id} value={cal.id}>
                  {cal.name}
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
          <p className="text-[12px] text-neutral-text-secondary mt-1.5">{summary}</p>
        </section>

        {/* Override policy */}
        <section
          id="workspace-calendar-override-policy"
          aria-labelledby="calendar-policy-heading"
          className="rounded-card border border-neutral-border bg-neutral-surface-raised overflow-hidden"
        >
          <div className="px-4 py-3 border-b border-neutral-border/55">
            <h2
              id="calendar-policy-heading"
              className="text-[13px] font-semibold text-neutral-text-primary"
            >
              Program &amp; project override policy
            </h2>
            <p className="text-[12px] text-neutral-text-secondary mt-0.5">
              Controls how programs and projects deviate from the workspace default.
            </p>
          </div>
          <div className="px-4 py-3 space-y-2">
            {(
              [
                {
                  id: 'suggest',
                  label: 'Suggest (recommended)',
                  hint: 'New programs and projects pre-fill the default but PMs can change it per scope.',
                  enterprise: false,
                },
                {
                  id: 'inherit',
                  label: 'Inherit',
                  hint: 'Every program and project follows this calendar. Per-scope pickers are read-only.',
                  enterprise: false,
                },
                {
                  id: 'enforce',
                  label: 'Enforce',
                  hint: 'This calendar is mandatory and cannot be overridden. Good for org-wide compliance.',
                  enterprise: true,
                },
              ] as const
            ).map((opt) => {
              const checked = overridePolicy === opt.id;
              const disabled = opt.enterprise;
              return (
                <label
                  key={opt.id}
                  className={[
                    'flex items-start gap-2.5 rounded-card p-2 group',
                    disabled
                      ? 'cursor-not-allowed'
                      : 'cursor-pointer hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
                      checked && !disabled
                        ? 'border-brand-primary bg-brand-primary'
                        : 'border-neutral-border bg-neutral-surface',
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    {checked && !disabled && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </span>
                  <input
                    type="radio"
                    name="workspace-calendar-override-policy"
                    value={opt.id}
                    checked={checked}
                    disabled={disabled}
                    readOnly={disabled}
                    // A disabled radio conveys nothing to a screen reader beyond
                    // "unavailable" — the visual EnterpriseBadge next to the label
                    // doesn't reach non-visual users, so the reason is spelled out
                    // via an sr-only span (accessibility gap fixed here, #1987).
                    aria-describedby={disabled ? 'calendar-enforce-enterprise-hint' : undefined}
                    onChange={() => {
                      if (!disabled) setOverridePolicy(opt.id);
                    }}
                    className="sr-only"
                  />
                  <span className="flex flex-col">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={[
                          'text-[13px] font-medium',
                          disabled ? 'text-neutral-text-disabled' : 'text-neutral-text-primary',
                        ].join(' ')}
                      >
                        {opt.label}
                      </span>
                      {/* ENFORCE is an Enterprise hard lock (ADR-0441); disabled on the
                          OSS surface with the community-only upsell badge. The server
                          degrades ENFORCE to SUGGEST when no enterprise provider is
                          registered, so storing it is harmless. */}
                      {opt.enterprise && <EnterpriseBadge />}
                    </span>
                    <span className="text-[12px] text-neutral-text-secondary">{opt.hint}</span>
                  </span>
                </label>
              );
            })}
            <span id="calendar-enforce-enterprise-hint" className="sr-only">
              Enforce requires TruePPM Enterprise.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
