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
 * - Everything else (blank project, import way, WATERFALL/HYBRID template) →
 *   Overview, unchanged from before this issue. The WATERFALL/HYBRID equivalent of
 *   the seeded-landing branch is #2731's concern, not built here.
 */
export function createdProjectDestination(
  projectId: string,
  intent?: CreatedProjectIntent,
): string {
  if (intent?.importCsv) return `/projects/${projectId}/schedule?import=csv`;
  if (intent?.templateApplied && intent.methodology === 'AGILE') {
    return `/projects/${projectId}/product-backlog?seeding=1`;
  }
  return `/projects/${projectId}/overview`;
}
