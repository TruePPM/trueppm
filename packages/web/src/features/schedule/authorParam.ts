/**
 * The `?author=` deep link — how every demoted creation surface lands in the
 * Designer instead of opening its own modal (#2952, design `v6-cases.js` case
 * 18).
 *
 * Eight surfaces could create a task and each owned a form. The disposition is
 * not "consolidate them" but **demote** them: they stay as entry points, and
 * each one lands in the same authoring surface with the caret in the right
 * place. A URL param is the seam because these callers are strangers to each
 * other — the shell's `+ New`, a board lane, the palette — and a shared store
 * would couple them to the Schedule's mount lifecycle. A link does not care
 * whether the target is mounted yet.
 */

/** What the demoted caller wants authored on arrival. */
export type AuthorIntent = 'task' | 'milestone';

export const AUTHOR_PARAM = 'author';
export const AUTHOR_PARENT_PARAM = 'under';

/**
 * Parse the param, rejecting anything unrecognized.
 *
 * Deliberately strict: this value arrives from a URL a user can hand-edit or a
 * stale bookmark can carry, and the consumer's job is to *create a row*. A
 * permissive parse that fell through to a default would let `?author=` typos
 * silently write to the plan.
 */
export function parseAuthorIntent(raw: string | null): AuthorIntent | null {
  return raw === 'task' || raw === 'milestone' ? raw : null;
}

/**
 * Build the link a demoted surface navigates to.
 *
 * `under` is the container the new row belongs inside. Omitted means "wherever
 * the Schedule's own insertion point would put it", which is what the shell's
 * context-free `+ New task` means — the caller is stating intent, not
 * overriding the outline's rules.
 */
export function authorLink(
  projectId: string,
  intent: AuthorIntent,
  opts: { under?: string | null } = {},
): string {
  const params = new URLSearchParams({ [AUTHOR_PARAM]: intent });
  if (opts.under) params.set(AUTHOR_PARENT_PARAM, opts.under);
  return `/projects/${projectId}/schedule?${params.toString()}`;
}
