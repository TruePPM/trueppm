import type { Risk } from '@/api/types';
import { localTodayIso } from '@/lib/localDate';
import { downloadCsv, escapeField } from '@/utils/exportCsv';

// Widen the shared guard to this module's cell types — several risk columns are
// numeric or nullable. Escaping itself is delegated, never reimplemented: this
// file used to carry a byte-identical copy of `escapeField`'s formula-prefix set
// and quoting rules, and a duplicated injection guard is a hazard in its own
// right (#2892 found the third copy of the #2762 class already drifted).
function csvCell(value: string | number | null | undefined): string {
  return escapeField(value == null ? '' : String(value));
}

// Column order per ADR-0043: ID, Title, Status, Category, Response, P, I, Severity, Owner,
// Mitigation Due Date, Trigger, Contingency, Description
const HEADERS = [
  'ID',
  'Title',
  'Status',
  'Category',
  'Response',
  'P',
  'I',
  'Severity',
  'Owner',
  'Mitigation Due Date',
  'Trigger',
  'Contingency',
  'Description',
];

function riskToRow(risk: Risk): string[] {
  return [
    // Fully-qualified ID (#929) — a CSV is a cross-project surface, so prefer the
    // <PROJECT>-R-NNN form the server provides over the compact in-project one.
    risk.qualified_id,
    risk.title,
    // Stored enum values, not display labels (data-interchange spec §5.5): the
    // importer accepts either, but a portable file carries the stored value.
    risk.status,
    risk.category ?? '',
    risk.response ?? '',
    String(risk.probability),
    String(risk.impact),
    String(risk.severity),
    risk.owner == null ? '' : String(risk.owner),
    // ISO 8601 as the API stores it (spec §5.5), never a locale-formatted date.
    risk.mitigation_due_date ?? '',
    risk.trigger ?? '',
    risk.contingency ?? '',
    risk.description ?? '',
  ];
}

/**
 * Builds the CSV string from a list of risks. UTF-8 with no BOM (spec §5.5: a BOM
 * is accepted on read but never written on export).
 * Exported for unit testing — no side effects.
 */
export function generateRisksCSV(risks: Risk[]): string {
  const lines: string[] = [
    HEADERS.map(csvCell).join(','),
    ...risks.map((r) => riskToRow(r).map(csvCell).join(',')),
  ];
  return lines.join('\r\n');
}

/**
 * Triggers a client-side download of a CSV file containing the given risks.
 * Filename format: risks-{projectSlug}-{YYYY-MM-DD}.csv
 */
export function exportRisksToCSV(risks: Risk[], projectSlug: string): void {
  // Local calendar day, not UTC (#2479) — a contributor exporting near midnight
  // should get a filename stamped with the day on their wall clock, not the day
  // in UTC, since the file is often filed as same-day evidence.
  const today = localTodayIso();
  const filename = `risks-${projectSlug}-${today}.csv`;
  downloadCsv(generateRisksCSV(risks), filename);
}
