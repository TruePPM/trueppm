/**
 * Display-name → initials helper, shared by the PDF print surfaces.
 *
 * Lifted out of `boardPrintData.ts` (ADR-0159, issue 326) so the schedule print
 * transform (ADR-0188, issue 1436) can reuse the exact same fallback without a
 * cross-feature import. Print layouts render initials, never remote avatar
 * `<img>` — cross-origin images can silently drop from `html-to-image`.
 */

/** Two-letter initials from a display name ("Ada Lovelace" → "AL", "Cher" → "CH"). */
export function initialsOf(name: string): string | null {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
