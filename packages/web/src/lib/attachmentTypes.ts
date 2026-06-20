/**
 * Attachment-type catalog and helpers (ADR-0153, issue 976).
 *
 * The single client-side source of human labels and group structure for the
 * task-attachment MIME allow-list. The *policy* (which types are allowed at a
 * given scope) is a server fact resolved per project — this module only supplies
 * the catalog the settings checklist renders and the label lookup the drawer and
 * settings pages use. Keep the catalog in step with the backend system default
 * (`attachment_policy.SYSTEM_DEFAULT_ATTACHMENT_TYPES`); extra MIMEs returned by
 * the server that are not in the catalog fall back to the raw MIME via
 * {@link labelForMime}.
 */

export interface AttachmentTypeOption {
  /** The MIME type, e.g. "application/pdf". The stored/compared value. */
  mime: string;
  /** Human-readable label shown in the checklist and provenance lines. */
  label: string;
  /** Group heading the option renders under (a `<fieldset><legend>` group). */
  group: string;
}

export interface DeniedAttachmentType {
  mime: string;
  label: string;
}

/**
 * The selectable attachment types, grouped for the checklist. Order within a
 * group is the display order. The MIME strings are the canonical lowercase
 * values the server stores and compares against.
 */
export const ATTACHMENT_TYPE_CATALOG: readonly AttachmentTypeOption[] = [
  // Documents
  { mime: 'application/pdf', label: 'PDF', group: 'Documents' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document',
    group: 'Documents',
  },
  { mime: 'text/plain', label: 'Plain text', group: 'Documents' },
  { mime: 'application/rtf', label: 'Rich text', group: 'Documents' },
  // Images
  { mime: 'image/png', label: 'PNG image', group: 'Images' },
  { mime: 'image/jpeg', label: 'JPEG image', group: 'Images' },
  { mime: 'image/gif', label: 'GIF image', group: 'Images' },
  { mime: 'image/webp', label: 'WebP image', group: 'Images' },
  // Spreadsheets
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel spreadsheet',
    group: 'Spreadsheets',
  },
  { mime: 'text/csv', label: 'CSV', group: 'Spreadsheets' },
  // Presentations
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint',
    group: 'Presentations',
  },
  // Archives
  { mime: 'application/zip', label: 'ZIP archive', group: 'Archives' },
];

/**
 * The permanent security denylist (ADR-0153, issue 976). The server subtracts these
 * from every resolved allow-list and rejects them on write — they can never
 * appear in an effective list. Shown disabled in an "Always blocked" group so an
 * admin understands why they are unavailable, not that they are merely unchecked.
 */
export const DENIED_ATTACHMENT_TYPES: readonly DeniedAttachmentType[] = [
  { mime: 'text/html', label: 'HTML' },
  { mime: 'image/svg+xml', label: 'SVG image' },
  { mime: 'application/xhtml+xml', label: 'XHTML' },
];

/** Catalog groups in display order, derived once from the catalog. */
export const ATTACHMENT_TYPE_GROUPS: readonly string[] = ATTACHMENT_TYPE_CATALOG.reduce<string[]>(
  (groups, opt) => (groups.includes(opt.group) ? groups : [...groups, opt.group]),
  [],
);

const LABEL_BY_MIME: ReadonlyMap<string, string> = new Map(
  [...ATTACHMENT_TYPE_CATALOG, ...DENIED_ATTACHMENT_TYPES].map((o) => [o.mime, o.label]),
);

/**
 * Human label for a MIME type, falling back to the raw MIME when the type is not
 * in the catalog (e.g. a server-side default the client doesn't yet model).
 */
export function labelForMime(mime: string): string {
  return LABEL_BY_MIME.get(mime) ?? mime;
}

/** Comma-joined human labels for a list of MIME types (catalog order is not enforced). */
export function labelsForMimes(mimes: readonly string[]): string[] {
  return mimes.map(labelForMime);
}
