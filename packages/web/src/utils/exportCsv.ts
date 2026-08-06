/**
 * exportTasksToCsv — convert a task list to a CSV Blob and trigger a download.
 *
 * Column order: WBS, Name, Start, Finish, Duration (days), Progress (%), Status, Critical.
 * Fields containing commas, double-quotes, or newlines are RFC 4180–escaped. Fields that
 * could be interpreted as a spreadsheet formula are neutralized first (see `escapeField`).
 *
 * Performance: synchronous, no I/O. Typically < 10 ms for 1000 tasks.
 */

import type { Task } from '@/types';

const CSV_HEADERS = ['WBS', 'Name', 'Start', 'Finish', 'Duration (days)', 'Progress (%)', 'Status', 'Critical'];

// A leading `=`, `+`, `-`, `@`, tab, or CR is how Excel/Sheets/LibreOffice decide a cell
// is a formula rather than literal text. Task names are user-supplied (including via CSV
// import, which applies no character filtering) and flow into this export unmodified, so
// a name like `=cmd|'/C calc'!A0` would otherwise execute on open (OWASP CSV injection).
const FORMULA_PREFIX_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function escapeField(value: string): string {
  // Neutralize a leading formula-trigger character first, then apply RFC 4180 quoting to
  // the (possibly prefixed) value — the two must compose, since prefixing never removes
  // the need for quoting and quoting alone does not stop Excel from evaluating a formula.
  const safe = value.length > 0 && FORMULA_PREFIX_CHARS.has(value[0]) ? `'${value}` : value;
  // `\r` is quoted as well as `\n`, and that is load-bearing rather than tidy: records are
  // joined with `\r\n`, and the formula prefix only guards position 0 of a field. An
  // interior lone `\r` in an unquoted field therefore ENDS the record, and whatever follows
  // it starts the next one unprefixed — turning `2026-99-99\r=cmd|'/C calc'!A0` back into a
  // live formula the guard above believed it had neutralized.
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return safe;
}

export function tasksToCsvString(tasks: Task[]): string {
  const rows: string[] = [CSV_HEADERS.join(',')];
  for (const t of tasks) {
    rows.push([
      escapeField(t.wbs),
      escapeField(t.name),
      escapeField(t.start),
      escapeField(t.finish),
      String(t.duration),
      String(t.progress),
      escapeField(t.status),
      t.isCritical ? 'Yes' : 'No',
    ].join(','));
  }
  return rows.join('\r\n');
}

/**
 * Save a CSV string as a browser download.
 *
 * Shared so every CSV surface uses one blob/anchor/revoke sequence — two hand-
 * rolled copies had already drifted apart on whether the anchor is attached to
 * the document before `.click()`.
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Attached before the click: Firefox ignores a click on a detached anchor.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function exportTasksToCsv(tasks: Task[], filename: string): void {
  downloadCsv(tasksToCsvString(tasks), filename);
}
