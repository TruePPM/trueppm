import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { ReadOnlyIndicator } from '../components/ReadOnlyIndicator';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { useCalendars } from '@/hooks/useCalendars';
import { ROLE_ADMIN } from '@/lib/roles';
import {
  summarizeWorkingCalendar,
  SYSTEM_DEFAULT_CALENDAR,
  SYSTEM_DEFAULT_CALENDAR_LABEL as SYSTEM_DEFAULT_LABEL,
} from '../project/calendarDisplay';

const SYSTEM_DEFAULT_SUMMARY = summarizeWorkingCalendar(SYSTEM_DEFAULT_CALENDAR);

/**
 * Program > Working calendar settings page (ADR-0441, issue #1987).
 *
 * Mirrors {@link ProjectMethodologyPage} one scope up: calendar inheritance is
 * POLICY-driven, not override-presence driven. The workspace's
 * `calendarOverridePolicy` decides whether this picker is editable:
 *
 *  - SUGGEST (or OSS ENFORCE with no enterprise provider) → editable. The
 *    program's own `calendar` wins; "Inherited from the workspace default (X)"
 *    is shown as informational context when it is null.
 *  - INHERIT (or active Enterprise ENFORCE) → read-only. The effective calendar
 *    is the workspace default; the picker is locked and explains why. The
 *    server is the source of truth — a PATCH under lock is rejected 403 — so
 *    this is a render-gate that spares the user a doomed save, not the
 *    enforcement itself.
 *
 * Overriding is presented as a first-class equal choice (VoC: Morgan/Sarah/
 * Alex) — the inheritance banner uses neutral styling (never amber/at-risk,
 * never a confirm modal), matching the Project Methodology page's precedent.
 */
export function ProgramCalendarPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program, isLoading: programLoading } = useProgram(programId);
  const updateProgram = useUpdateProgram();
  const { data: ws } = useWorkspaceSettings();
  const { calendars, isLoading: calendarsLoading, error: calendarsError } = useCalendars();

  // null = inherit the workspace calendar (ADR-0441).
  const [calendarId, setCalendarId] = useState<string | null>(null);
  const seededProgramIdRef = useRef<string | null>(null);
  const [initialCalendarId, setInitialCalendarId] = useState<string | null>(null);

  useEffect(() => {
    if (!program || seededProgramIdRef.current === program.id) return;
    seededProgramIdRef.current = program.id;
    setCalendarId(program.calendar);
    setInitialCalendarId(program.calendar);
  }, [program]);

  const values = useMemo(() => ({ calendar: calendarId }), [calendarId]);
  const initialValues = useMemo(() => ({ calendar: initialCalendarId }), [initialCalendarId]);

  // The workspace locks overrides under INHERIT (always) or active Enterprise
  // ENFORCE. OSS never has an active ENFORCE provider, so ENFORCE behaves like
  // SUGGEST here and the picker stays editable.
  const lockedByPolicy = ws?.calendarOverridePolicy === 'inherit';
  // Admin+ on the program may edit; `my_role` is null until the program loads,
  // so gate pessimistically (read-only until proven Admin).
  const canEdit = !lockedByPolicy && program?.my_role != null && program.my_role >= ROLE_ADMIN;

  const handleSave = useCallback(async () => {
    if (!programId) return;
    await updateProgram.mutateAsync({ programId, patch: { calendar: calendarId } });
    setInitialCalendarId(calendarId);
  }, [updateProgram, programId, calendarId]);

  const handleReset = useCallback(() => {
    setCalendarId(initialCalendarId);
  }, [initialCalendarId]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!program && canEdit,
  });

  // Gate on all three: program, workspace settings, and the calendar library.
  // Until all resolve, `effective`/`inherited`/`lockedByPolicy` would fall back
  // to defaults and momentarily render a wrong, concrete-looking selection.
  if (programLoading || !program || ws === undefined || calendarsLoading) {
    return (
      <div className="px-6 py-8 space-y-3">
        <div className="h-16 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
        <div className="h-20 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
      </div>
    );
  }

  const effective = program.effective_calendar ?? null;
  const inherited = program.inherited_calendar ?? null;
  const workspaceCalendarName = inherited ? inherited.name : SYSTEM_DEFAULT_LABEL;

  // Under a workspace lock (INHERIT / active Enterprise ENFORCE) the program's own
  // `calendar` override no longer applies — the effective calendar is the workspace
  // one. Drive the (read-only) control from `effective` so a program that set an
  // override *before* the workspace was locked doesn't display its now-superseded
  // calendar as if selected (mirrors ProjectMethodologyPage's `lockedByPolicy ?
  // effective : own` discipline). When unlocked, the local edit state wins.
  const displayCalendarId = lockedByPolicy ? (effective ? effective.id : null) : calendarId;

  // Summary line under the control (ADR-0441): summarize the resolved effective
  // calendar while inheriting (or locked), else the chosen override row from the
  // fetched library (dirty or already saved).
  const displayCalendarRow = displayCalendarId
    ? (calendars.find((c) => c.id === displayCalendarId) ?? null)
    : null;
  const summaryLine =
    displayCalendarId === null
      ? effective
        ? summarizeWorkingCalendar(effective)
        : SYSTEM_DEFAULT_SUMMARY
      : displayCalendarRow
        ? summarizeWorkingCalendar(displayCalendarRow)
        : effective && effective.id === displayCalendarId
          ? summarizeWorkingCalendar(effective)
          : null;

  // Below-role / policy-locked users get the effective value + provenance instead
  // of a disabled picker (ADR-0133). "Inheriting" collapses to a single word; an
  // active override reads out the resolved calendar name.
  let readOnlyCalendarValue: string;
  if (displayCalendarId === null) {
    readOnlyCalendarValue = 'Inherited from workspace';
  } else if (displayCalendarRow?.name != null) {
    readOnlyCalendarValue = displayCalendarRow.name;
  } else if (effective && effective.id === displayCalendarId) {
    readOnlyCalendarValue = effective.name;
  } else {
    readOnlyCalendarValue = 'Workspace calendar';
  }

  return (
    <div>
      <SettingsPageTitle
        title="Working calendar"
        subtitle="The working calendar CPM uses to schedule this program's projects. Inherits the workspace default unless you override it here."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-6">
        {/* Inheritance context banner (neutral styling — overriding is a
            first-class equal choice, never an at-risk warning). */}
        <div className="rounded-card border border-neutral-border bg-neutral-surface-sunken px-4 py-3">
          {lockedByPolicy ? (
            <p className="text-[13px] text-neutral-text-primary">
              This workspace requires every program and project to use its default calendar —{' '}
              <span className="font-semibold">{workspaceCalendarName}</span>. The picker below is
              read-only. A workspace admin can relax this on the workspace Working calendar page.
            </p>
          ) : program.calendar === null ? (
            <p className="text-[13px] text-neutral-text-secondary">
              Inherited from the workspace default:{' '}
              <span className="font-semibold text-neutral-text-primary">
                {effective ? effective.name : SYSTEM_DEFAULT_LABEL}
              </span>
              . {effective ? summarizeWorkingCalendar(effective) : SYSTEM_DEFAULT_SUMMARY}. Choose a
              calendar below to override it for this program only.
            </p>
          ) : (
            <p className="text-[13px] text-neutral-text-secondary">
              Overriding the workspace default. This program uses its own calendar; the workspace
              default no longer applies here.
            </p>
          )}
        </div>

        <FieldRow
          label="Working calendar"
          hint="Override the workspace default calendar for this program's projects. Inherit to follow the workspace default."
        >
          {!canEdit ? (
            <ReadOnlyIndicator
              label="Working calendar"
              value={readOnlyCalendarValue}
              provenance={
                lockedByPolicy ? 'locked by workspace policy' : 'managed by the program admin'
              }
              filled={displayCalendarId !== null}
            />
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (canEdit) setCalendarId(null);
                }}
                disabled={!canEdit}
                aria-pressed={displayCalendarId === null}
                className={[
                  'px-3 py-1 rounded-control border text-[12px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  calendarId === null
                    ? 'bg-brand-primary-light text-brand-primary border-brand-primary/40'
                    : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  !canEdit ? 'cursor-not-allowed opacity-60' : '',
                ].join(' ')}
              >
                Inherit from workspace
              </button>
              <div className="relative inline-block w-[240px]">
                <select
                  value={displayCalendarId ?? ''}
                  onChange={(e) => setCalendarId(e.target.value === '' ? null : e.target.value)}
                  aria-label="Working calendar override"
                  // Disable when the workspace policy locks overrides, or on a load
                  // error — an enabled empty picker there would be indistinguishable
                  // from "no calendars exist". (The loading case is handled upstream
                  // by the page-level skeleton, so it never reaches this control.)
                  disabled={!canEdit || !!calendarsError}
                  className="w-full h-8 pl-2.5 pr-8 rounded-control border border-neutral-border bg-neutral-surface-raised text-[13px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
                >
                  <option value="">
                    {calendarsError ? "Couldn't load calendars" : 'Override with a calendar…'}
                  </option>
                  {/* Keep the current override selectable even if it isn't in the
                    fetched list yet (still loading, or the calendar was removed),
                    so the <select> stays controlled without a value/option mismatch. */}
                  {displayCalendarId && !calendars.some((c) => c.id === displayCalendarId) && (
                    <option value={displayCalendarId}>
                      {lockedByPolicy ? 'Workspace calendar' : 'Current override'}
                    </option>
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
                  <path
                    d="M4 6l4 4 4-4"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </div>
            </div>
          )}
          {summaryLine && (
            <p className="text-[12px] text-neutral-text-secondary mt-1.5">{summaryLine}</p>
          )}
        </FieldRow>
      </div>
    </div>
  );
}
