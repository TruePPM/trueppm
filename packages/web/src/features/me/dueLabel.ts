/**
 * Format the `due` field on a My Work task for display.
 *
 * The backend returns a `due` ISO date plus a `due_source` enum identifying
 * which step of the cascade produced it (`actual_finish → planned_start →
 * early_finish → sprint.finish_date`). Surfacing only a date is ambiguous —
 * "Due Oct 14" could mean any of four things — so the contributor surface
 * always renders the date alongside its source label.
 *
 * Examples:
 *   { due: "2026-10-14", due_source: "planned"   } → "Due Oct 14 (planned)"
 *   { due: "2026-10-14", due_source: "estimated" } → "Due Oct 14 (estimated)"
 *   { due: "2026-10-14", due_source: "actual"    } → "Done Oct 14"
 *   { due: "2026-10-14", due_source: "sprint"    } → "Ends with sprint"
 *   { due: null,         due_source: null        } → "No due date"
 */
import type { DueSource } from '@/hooks/useMyWork';

export interface DueLabel {
  /** Human-readable text shown on the row. */
  text: string;
  /** Screen-reader sentence — never abbreviated. */
  sr: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatShort(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}`;
}

function formatLong(iso: string): string {
  // Reads naturally in screen readers: "October 14, 2026"
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return `${months[m - 1]} ${d}, ${y}`;
}

export function formatDueLabel(due: string | null, source: DueSource): DueLabel {
  if (!due || !source) {
    return { text: 'No due date', sr: 'No due date set' };
  }
  const short = formatShort(due);
  const long = formatLong(due);
  switch (source) {
    case 'actual':
      return { text: `Done ${short}`, sr: `Completed on ${long}` };
    case 'planned':
      return { text: `Due ${short} (planned)`, sr: `Due ${long}, planned commitment` };
    case 'estimated':
      return { text: `Due ${short} (estimated)`, sr: `Due ${long}, estimated from schedule` };
    case 'sprint':
      return { text: `Ends with sprint`, sr: `Ends with the current sprint on ${long}` };
    default:
      return { text: short, sr: long };
  }
}
