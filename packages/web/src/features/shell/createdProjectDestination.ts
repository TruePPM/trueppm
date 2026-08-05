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
 * - Everything else (blank project, import way) → Overview.
 *
 * The three seeded branches are mutually exclusive by construction: `way` is one of
 * `'template' | 'blank' | 'import'`, so `importCsv` and a template application can
 * never both be set.
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
  return `/projects/${projectId}/overview`;
}
