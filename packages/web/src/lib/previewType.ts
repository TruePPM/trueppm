/**
 * Cloud-file preview-type presentation (issue 571, ADR-0163).
 *
 * Mirrors the server's `PREVIEW_TYPE_VALUES` (registry.py). The server classifies
 * an unfurled file URL onto one of these; the web layer maps each onto a single
 * Unicode glyph (zero icon-library cost, matching the provider-icon convention)
 * and a human label for the type chip. The map MUST stay exhaustive — an unknown
 * key falls back to the generic file glyph so a new server value never renders
 * blank.
 */

export type PreviewType =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'pdf'
  | 'folder'
  | 'file';

const PREVIEW_TYPE_GLYPH: Record<PreviewType, string> = {
  document: '📝',
  spreadsheet: '📊',
  presentation: '📽️',
  image: '🖼️',
  pdf: '📕',
  folder: '📁',
  file: '📄',
};

const PREVIEW_TYPE_LABEL: Record<PreviewType, string> = {
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  image: 'Image',
  pdf: 'PDF',
  folder: 'Folder',
  file: 'File',
};

/** Glyph for a preview type; falls back to the generic file glyph for any
 *  unknown key (keeps the placeholder/chip exhaustive against future values). */
export function previewTypeGlyph(type: string): string {
  return PREVIEW_TYPE_GLYPH[type as PreviewType] ?? PREVIEW_TYPE_GLYPH.file;
}

/** Human label for the type chip; falls back to the generic 'File'. */
export function previewTypeLabel(type: string): string {
  return PREVIEW_TYPE_LABEL[type as PreviewType] ?? PREVIEW_TYPE_LABEL.file;
}
