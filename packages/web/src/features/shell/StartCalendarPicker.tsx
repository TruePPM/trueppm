import { useCalendarLibrary } from '@/hooks/useProjectCalendars';
import { SELECT_CHEVRON } from './selectChevron';
import type { InheritedCalendar } from './useInheritedCalendar';

export interface StartCalendarPickerProps {
  /** `null` = use the inherited default (nothing sent on create). */
  value: string | null;
  onChange: (calendarId: string | null) => void;
  inherited: InheritedCalendar;
  /**
   * `id` of the form this field belongs to, when it is rendered outside that
   * form's DOM subtree — the Start sheet pins it in the footer, below the
   * scrolling `<form>` (#3130). Without it the browser excludes the control from
   * the form's implicit-submission behavior, so Enter would do nothing here while
   * working from every other field on the sheet. The value itself never travels
   * through the form: it is controlled React state read at submit.
   */
  formId?: string;
}

/**
 * Single-select working-calendar picker for the Start sheet (#2728).
 *
 * Deliberately lighter than `AddCalendarPicker` (the post-create multi-select
 * overlay for composing base + overlay calendars): this is a single choice made
 * once, at creation, before there is a project to attach overlays to. The default
 * option always shows the *resolved* inherited calendar (program → workspace →
 * system default, ADR-0441) so the field never opens on a blank "choose one" —
 * there is always a concrete calendar that would apply if the user submits without
 * touching this field. Picking an explicit option here becomes `project.calendar`
 * at create time; leaving it on "inherited" omits the field entirely and lets the
 * server perform the same resolution authoritatively.
 */
export function StartCalendarPicker({
  value,
  onChange,
  inherited,
  formId,
}: StartCalendarPickerProps) {
  const { data: library, isLoading: libraryLoading } = useCalendarLibrary();
  const options = (library ?? []).filter((c) => c.id !== inherited.id);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-text-secondary">Working calendar</span>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        disabled={inherited.loading || libraryLoading}
        form={formId}
        aria-label="Working calendar"
        style={{ backgroundImage: SELECT_CHEVRON }}
        className="h-9 pl-3 pr-8 rounded-control border border-neutral-border bg-neutral-surface
          text-sm text-neutral-text-primary appearance-none bg-no-repeat bg-[right_0.5rem_center]
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">
          {inherited.loading ? 'Loading…' : `${inherited.name} (inherited)`}
        </option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="text-xs text-neutral-text-secondary">
        Governs every computed date — working days, hours per day, and holidays.
        {!inherited.loading && (
          <>
            {' '}
            {value === null
              ? `Inherited${inherited.source === 'system_default' ? '' : ` from ${inherited.source}`}: ${inherited.summary}.`
              : 'Overridden for this project.'}
          </>
        )}
        {' '}Changeable later in project settings.
      </span>
    </label>
  );
}
