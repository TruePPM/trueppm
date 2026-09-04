import type { CreatedProjectIntent } from './NewProjectModal';

/**
 * Where a just-created project should land, given what the user asked for at the
 * moment of commitment (#2710) and, for a template application, the project's
 * derived methodology (#2734, ADR-0800).
 *
 * `NewProjectModal` is mounted from several entry points — the "+ New" dispatcher,
 * the sidebar rail, the My Work empty state, a program's "Add project" action — each
 * of which previously reimplemented this branch inline. Centralizing it means the
 * CSV-import deep link (#2710) and the agile-backlog landing (#2734) apply
 * consistently everywhere the sheet can be opened from, rather than only at the one
 * call site that happened to be updated.
 *
 * - `importCsv` → the Schedule with the CSV/Excel wizard already open.
 * - AGILE + `templateApplied` → the product backlog, with `?seeding=1` so
 *   `ProductBacklogPage` treats a momentarily-empty backlog as "still filling" from
 *   the fire-and-forget template apply (ADR-0789 §4) rather than genuinely empty.
 * - Non-AGILE + `templateApplicationId` → the Schedule, with the seed banner
 *   polling that application for its `result_summary` counts (ADR-0799 §1). Gated
 *   on the id rather than on `templateApplied` because a failed dispatch leaves
 *   nothing to poll — that case falls through to Overview rather than landing on a
 *   banner that can never resolve.
 * - `blank` → the surface the Start sheet's Blank card names: the Schedule, whose
 *   `BlankProjectCanvas` puts the caret in the first outline row (#2733), or the
 *   product backlog for an AGILE project. It landed on Overview until #3311 — the
 *   card had promised the outline since the sheet shipped and the destination had
 *   returned Overview since this file was introduced, a day apart, never agreeing.
 *   No `seeding=1` on the AGILE branch: nothing is being applied, so a blank
 *   backlog is genuinely empty and must read as its own empty state, not as one
 *   still filling.
 * - Everything else (import way) → Overview.
 *
 * The AGILE split is not cosmetic. `methodologyTabs.ts` hides the Schedule's nav
 * entry for an AGILE project and `ScheduleView` answers a direct URL with
 * "Schedule isn't part of this project's workflow" (#2619) — so routing every
 * blank create there would trade one wrong landing for a dead end.
 *
 * The seeded branches are mutually exclusive by construction: `way` is one of
 * `'template' | 'blank' | 'import'`, so `importCsv`, a template application and
 * `blank` can never be set together.
 */
export function createdProjectDestination(
  projectId: string,
  intent?: CreatedProjectIntent,
): string {
  if (intent?.importCsv) return `/projects/${projectId}/schedule?import=csv`;
  if (intent?.templateApplied && intent.methodology === 'AGILE') {
    return `/projects/${projectId}/product-backlog?seeding=1`;
  }
  if (intent?.templateApplicationId && intent.methodology !== 'AGILE') {
    return `/projects/${projectId}/schedule?templateApplication=${intent.templateApplicationId}`;
  }
  if (intent?.blank) {
    return intent.methodology === 'AGILE'
      ? `/projects/${projectId}/product-backlog`
      : `/projects/${projectId}/schedule`;
  }
  return `/projects/${projectId}/overview`;
}
