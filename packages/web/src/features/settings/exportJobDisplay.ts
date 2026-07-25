/**
 * Display helpers shared by the async export-bundle controls (program: {@link
 * ExportProgramBundle}; project: {@link ExportBundleCard}). Both poll the same
 * queued → running → ready/failed job lifecycle and render the same status text,
 * button label, and error message — extracting the branchy formatting keeps each
 * control flat (issue #2356 / #2081 cognitive-complexity pass) without changing a
 * single rendered string.
 */

/** Progress text shown next to the export button while a bundle is being built. */
export function exportStatusLabel(
  isQueuing: boolean,
  status: string | undefined,
): string | null {
  if (isQueuing) return 'Queuing…';
  if (status === 'pending') return 'Queued…';
  if (status === 'running') return 'Building bundle…';
  return null;
}

/** The export button's label across idle / building / ready-to-download states. */
export function bundleButtonLabel(busy: boolean, ready: boolean, idleLabel: string): string {
  if (busy) return 'Working…';
  if (ready) return 'Download bundle';
  return idleLabel;
}

/**
 * The error line under the export button, or `null` when there is nothing to
 * show. A download failure wins over a build failure, which wins over a queue
 * failure — the same precedence the inline `downloadError ?? (failed ? … : …)`
 * expression encoded before extraction.
 */
export function exportErrorText(opts: {
  downloadError: string | null;
  failed: boolean;
  errorDetail?: string | null;
  startError: string | null;
}): string | null {
  const { downloadError, failed, errorDetail, startError } = opts;
  if (downloadError) return downloadError;
  if (failed) return `Export failed${errorDetail ? `: ${errorDetail}` : ''}. Try again.`;
  return startError;
}
