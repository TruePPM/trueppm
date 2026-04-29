import type { Risk } from '@/api/types';

// RFC 4180 quoting: wrap in double-quotes if the value contains commas, double-quotes, or newlines.
// Embedded double-quotes are doubled.
function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Format YYYY-MM-DD as "MMM D, YYYY" for human readability in the export.
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatShortId(shortId: string): string {
  if (!shortId) return '';
  if (/^\d+$/.test(shortId)) return `R-${String(parseInt(shortId, 10)).padStart(3, '0')}`;
  return `R-${shortId.slice(0, 4).toUpperCase()}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  TECHNICAL:          'Technical',
  EXTERNAL:           'External',
  ORGANIZATIONAL:     'Organizational',
  PROJECT_MANAGEMENT: 'Project Management',
};

const RESPONSE_LABELS: Record<string, string> = {
  AVOID:    'Avoid',
  MITIGATE: 'Mitigate',
  TRANSFER: 'Transfer',
  ACCEPT:   'Accept',
};

const STATUS_LABELS: Record<string, string> = {
  OPEN:       'Open',
  MITIGATING: 'Mitigating',
  RESOLVED:   'Resolved',
  ACCEPTED:   'Accepted',
  CLOSED:     'Closed',
};

// Column order per ADR-0043: ID, Title, Status, Category, Response, P, I, Severity, Owner,
// Mitigation Due Date, Trigger, Contingency, Description
const HEADERS = [
  'ID', 'Title', 'Status', 'Category', 'Response',
  'P', 'I', 'Severity', 'Owner',
  'Mitigation Due Date', 'Trigger', 'Contingency', 'Description',
];

function riskToRow(risk: Risk): string[] {
  return [
    formatShortId(risk.short_id),
    risk.title,
    STATUS_LABELS[risk.status] ?? risk.status,
    risk.category ? (CATEGORY_LABELS[risk.category] ?? risk.category) : '',
    risk.response ? (RESPONSE_LABELS[risk.response] ?? risk.response) : '',
    String(risk.probability),
    String(risk.impact),
    String(risk.severity),
    risk.owner ?? '',
    formatDate(risk.mitigation_due_date),
    risk.trigger ?? '',
    risk.contingency ?? '',
    risk.description ?? '',
  ];
}

/**
 * Builds the CSV string (with UTF-8 BOM) from a list of risks.
 * Exported for unit testing — no side effects.
 */
export function generateRisksCSV(risks: Risk[]): string {
  const lines: string[] = [
    HEADERS.map(csvCell).join(','),
    ...risks.map((r) => riskToRow(r).map(csvCell).join(',')),
  ];
  // BOM prefix for Excel UTF-8 compatibility
  return '﻿' + lines.join('\r\n');
}

/**
 * Triggers a client-side download of a CSV file containing the given risks.
 * Filename format: risks-{projectSlug}-{YYYY-MM-DD}.csv
 */
export function exportRisksToCSV(risks: Risk[], projectSlug: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `risks-${projectSlug}-${today}.csv`;
  const csv = generateRisksCSV(risks);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
