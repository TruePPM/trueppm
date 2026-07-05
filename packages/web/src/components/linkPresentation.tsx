/**
 * Shared presentation primitives for external-link / asset rows (#970, #971).
 *
 * Lifted out of `features/schedule/sections/ExternalLinksSection.tsx` so both the
 * per-task drawer section and the unified Assets surface (ADR-0215) render a
 * provider glyph, status badge, preview-type chip, and label pills identically —
 * one source of truth, no drift. Color is never the only cue (WCAG 1.4.1): every
 * badge/chip carries a text label and the glyph is decorative (aria-hidden).
 */

import { previewTypeLabel } from '@/lib/previewType';
import { LINK_STATUS_DOT_CLASS, LINK_STATUS_LABEL, LINK_STATUS_TEXT_CLASS } from '@/lib/linkStatus';
import type { ExternalLinkStatus } from '@/lib/linkStatus';

/** Cloud-file providers whose right-slot is a preview-type chip, not a git status
 *  badge — a file has no PR/MR lifecycle (issue 571, ADR-0163). */
export const FILE_PROVIDERS = new Set(['google_drive', 'dropbox', 'box', 'onedrive']);

export function isFileProvider(provider: string): boolean {
  return FILE_PROVIDERS.has(provider);
}

/** Provider glyph — Unicode for zero icon-library cost (matches AttachmentSection).
 *  File providers (issue 571, ADR-0163) get distinct glyphs; the icon is decorative
 *  (aria-hidden) — the link title carries the meaning. */
export function providerIcon(provider: string): string {
  if (provider === 'github') return '🐙';
  if (provider === 'gitlab') return '🦊';
  if (provider === 'google_drive') return '📂';
  if (provider === 'dropbox') return '🗄️';
  if (provider === 'box') return '📦';
  if (provider === 'onedrive') return '☁️';
  return '🔗';
}

interface StatusBadgeProps {
  status: ExternalLinkStatus;
  /** Generic links have no lifecycle status — show a neutral em dash. */
  provider: string;
}

/** Colored-dot + uppercase-label status pill (mirrors the Connected Accounts pill).
 *
 * Color/label tokens come from the shared linkStatus module (issue 767, ADR-0155) so
 * the per-link badge, the at-a-glance list-row glyph, and the Gantt dot stay in
 * lockstep. Color is never the only signal — the uppercase label is always present
 * (WCAG 1.4.1). MERGED maps to brand-primary and DRAFT to at-risk (orange). */
export function StatusBadge({ status, provider }: StatusBadgeProps) {
  const isGenericUnknown = provider === 'generic' && status === 'unknown';
  const label = isGenericUnknown ? '—' : LINK_STATUS_LABEL[status];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide ${LINK_STATUS_TEXT_CLASS[status]}`}
      aria-label={`Status: ${isGenericUnknown ? 'not applicable' : status}`}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full ${LINK_STATUS_DOT_CLASS[status]}`}
      />
      {label}
    </span>
  );
}

/** Neutral preview-type chip for a cloud-file link (issue 571, ADR-0163). Distinct
 *  from `StatusBadge` — status pills are reserved for git lifecycle states; a
 *  file has no lifecycle, so its right-slot describes its *type*. */
export function TypeChip({ type }: { type: string }) {
  const label = previewTypeLabel(type);
  return (
    <span
      className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5
        text-[11px] font-medium text-neutral-text-secondary"
      aria-label={`File type: ${label}`}
    >
      {label}
    </span>
  );
}

/** Read-only label chips on a link row. Text is the signal (no color coding). */
export function LabelPills({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1 list-none" aria-label="Labels">
      {labels.map((label, i) => (
        <li
          key={`${label}-${i}`}
          className="inline-flex items-center rounded-chip bg-neutral-surface-sunken px-1.5 py-0.5
            text-xs text-neutral-text-secondary"
        >
          {label}
        </li>
      ))}
    </ul>
  );
}
