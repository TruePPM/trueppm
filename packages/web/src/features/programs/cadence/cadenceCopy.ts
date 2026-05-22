import type { CeremonyTemplate } from '@/api/types';

export interface DayOption {
  value: string;
  label: string;
}

export const WEEKDAY_OPTIONS: DayOption[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];

export const MONTHLY_ORDINAL_OPTIONS: DayOption[] = [
  { value: '1st', label: 'First' },
  { value: '2nd', label: 'Second' },
  { value: '3rd', label: 'Third' },
  { value: '4th', label: 'Fourth' },
  { value: 'last', label: 'Last' },
];

export const OWNER_ROLE_SUGGESTIONS: string[] = [
  'Program Manager',
  'Risk Lead',
  'Scheduler',
  'Resource Manager',
  'Sponsor',
];

const WEEKDAY_LABELS: Record<string, string> = Object.fromEntries(
  WEEKDAY_OPTIONS.map((o) => [o.value, o.label]),
);

const ORDINAL_LABELS: Record<string, string> = Object.fromEntries(
  MONTHLY_ORDINAL_OPTIONS.map((o) => [o.value, o.label.toLowerCase()]),
);

/** "1st-thursday" → { ordinal: "1st", weekday: "thursday" }; "" → null. */
export function parseMonthlyDay(
  value: string,
): { ordinal: string; weekday: string } | null {
  const parts = value.split('-');
  if (parts.length !== 2) return null;
  return { ordinal: parts[0], weekday: parts[1] };
}

/** Render a ceremony's cadence as the table-row summary line. */
export function formatCadence(
  ceremony: Pick<CeremonyTemplate, 'cadence_type' | 'cadence_day' | 'cadence_time'>,
): string {
  const { cadence_type, cadence_day, cadence_time } = ceremony;
  if (cadence_type === 'on_milestone') return 'On milestone';

  const time = formatTime(cadence_time);

  if (cadence_type === 'weekly') {
    const day = WEEKDAY_LABELS[cadence_day] ?? cadence_day;
    return `Weekly · ${day}${time ? ' ' + time : ''}`;
  }
  if (cadence_type === 'biweekly') {
    const day = WEEKDAY_LABELS[cadence_day] ?? cadence_day;
    return `Bi-weekly · ${day}${time ? ' ' + time : ''}`;
  }
  // monthly
  const parsed = parseMonthlyDay(cadence_day);
  if (parsed) {
    const ord = ORDINAL_LABELS[parsed.ordinal] ?? parsed.ordinal;
    const wd = WEEKDAY_LABELS[parsed.weekday] ?? parsed.weekday;
    return `Monthly · ${ord} ${wd}${time ? ' ' + time : ''}`;
  }
  return `Monthly${time ? ' · ' + time : ''}`;
}

/** "10:00:00" → "10:00"; null/empty → "". */
export function formatTime(raw: string | null | undefined): string {
  if (!raw) return '';
  // DRF TimeField serializes "HH:MM:SS" or "HH:MM:SS.ffffff"; truncate to HH:MM.
  const m = /^(\d{1,2}:\d{2})/.exec(raw);
  return m ? m[1] : raw;
}

export function formatDuration(minutes: number): string {
  return `${minutes} min`;
}
