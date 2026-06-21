/**
 * Edition seam for the board PDF export footer (ADR-0159, issue 326).
 *
 * The community edition stamps a watermark line in the export footer. Enterprise
 * builds override this module at build time (the same web extension-point
 * convention used by the settings EnterpriseBadge / edition checks) to return
 * `null`, suppressing the line. Keeping the seam a single pure function means the
 * OSS code carries no runtime enterprise import — the Apache-2.0 one-way boundary
 * stays intact (CLAUDE.md Two-Repo Rule).
 */

/**
 * The watermark line rendered in the board-export footer, or `null` to omit it.
 *
 * OSS returns the community attribution; Enterprise overrides to `null`.
 */
export function boardExportFooterWatermark(): string | null {
  return 'Generated with TruePPM Community';
}
