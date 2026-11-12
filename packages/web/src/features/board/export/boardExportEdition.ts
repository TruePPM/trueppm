/**
 * Edition seam for the board PDF export footer (ADR-0159, issue 326).
 *
 * The community edition stamps a watermark line in the export footer. Keeping
 * the seam a single pure function means the OSS code carries no runtime
 * enterprise import — the Apache-2.0 one-way boundary stays intact (CLAUDE.md
 * Two-Repo Rule).
 *
 * NOT YET WIRED (#1175, #3374). The intent is that an Enterprise build replaces
 * this module at build time so it returns `null` and suppresses the line, but no
 * such override exists today: `vite.config.ts` carries no `resolve.alias` for this
 * module, and the settings EnterpriseBadge is a different mechanism (a runtime
 * `useEdition()` check, not a build-time swap). Until the frontend slot-registry
 * loader work in #1175 lands, an Enterprise build also stamps the Community line.
 * See the matching note in `@/lib/widget-registry`.
 */

/**
 * The watermark line rendered in the board-export footer, or `null` to omit it.
 *
 * OSS returns the community attribution. The Enterprise `null` override is not wired yet (see the file header).
 */
export function boardExportFooterWatermark(): string | null {
  return 'Generated with TruePPM Community';
}
