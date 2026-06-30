/**
 * Edition seam for the schedule PDF export footer (ADR-0188, issue 1436).
 *
 * A verbatim mirror of the board export seam (`boardExportEdition.ts`,
 * ADR-0159): the community edition stamps a watermark line in the export footer.
 * Enterprise builds override this module at build time (the same web
 * extension-point convention used by the settings EnterpriseBadge / edition
 * checks) to return `null`, suppressing the line. Keeping the seam a single pure
 * function means the OSS code carries no runtime enterprise import — the
 * Apache-2.0 one-way boundary stays intact (CLAUDE.md Two-Repo Rule).
 */

/**
 * The watermark line rendered in the schedule-export footer, or `null` to omit it.
 *
 * OSS returns the community attribution; Enterprise overrides to `null`.
 */
export function scheduleExportFooterWatermark(): string | null {
  return 'Generated with TruePPM Community';
}
