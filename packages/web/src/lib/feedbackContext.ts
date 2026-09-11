/**
 * Assemble the prefilled bug-report / feedback URL (#2392).
 *
 * **A link, not a beacon.** Nothing here sends anything. It builds a URL string;
 * the user reads the assembled body in-app, then chooses to open it. A
 * self-hosted — potentially air-gapped — instance must never phone home as a
 * side effect of a control existing on screen, so there is no POST on this path,
 * no telemetry, and no network call triggered by rendering.
 *
 * **What travels, and what deliberately does not.** The context is the minimum
 * that makes a report actionable: which build, which edition, which *surface*,
 * which browser, and — since #3388 — how many tasks are in the project the
 * reporter is looking at. It carries no workspace, program, project or task
 * identifier, no user identity, and no schedule content — the route *path*
 * tells us where the user was without telling us what they were looking at,
 * and the task count is a bare number with nothing to trace it back to a
 * specific project once it lands on the tracker.
 */

/** The default public tracker. Not stored in the DB — see `Workspace.feedback_url`. */
export const DEFAULT_FEEDBACK_URL = 'https://gitlab.com/trueppm/trueppm/-/issues/new';

export interface FeedbackContext {
  version: string;
  edition: string;
  buildSha: string;
  /** Route path only — no query string, no fragment, no ids. */
  routePath: string;
  userAgent: string;
  /**
   * Task count of the project currently in view (#3388), sourced from data the
   * page has already fetched — never a dedicated request the dialog triggers
   * itself. `undefined` when the caller is not on a project route, or is but
   * the count is not yet warm in cache; the field is simply omitted from the
   * body rather than reported as zero, which would be a lie about a project
   * that just hasn't loaded its tasks yet.
   *
   * This is a channel, not a measurement: only reports that are filed at all,
   * from projects whose task list happened to be cached at that moment, ever
   * surface here. See `.claude/persona-calibration.md`'s "task ceiling"
   * assumption for what this is evidence toward and what it structurally
   * cannot see.
   */
  taskCount?: number;
}

/**
 * Reduce a full location to a path safe to send.
 *
 * Two separate strips, both load-bearing:
 *  - the **query string and fragment** go, because they carry task ids, filter
 *    values, and search terms;
 *  - every **UUID and long numeric segment** in the path is replaced with a
 *    placeholder, because `/projects/<uuid>/board` identifies a project just as
 *    surely as a query parameter would.
 *
 * What survives is the shape of the surface — `/projects/:id/board` — which is
 * exactly what a bug report needs and nothing more.
 */
export function sanitizeRoutePath(href: string): string {
  // Accept a full URL or a bare path; take only the pathname either way.
  let path: string;
  try {
    path = new URL(href, 'http://localhost').pathname;
  } catch {
    path = href.split('?')[0]?.split('#')[0] ?? '/';
  }
  return (
    path
      .split('/')
      .map((seg) => (looksLikeIdentifier(seg) ? ':id' : seg))
      .join('/') || '/'
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deliberately wider than "is this a valid UUID".
 *
 * Ids in the wild are not always strict hex — fixtures and imported records
 * carry prefixed or otherwise irregular forms — and a redactor that only catches
 * the canonical shape gives false confidence exactly where it matters. The third
 * clause is the catch-all: a long segment containing a digit is an identifier,
 * not a route word. Real route words are short (`board`, `schedule`) or
 * digit-free (`connected-accounts`), so they survive.
 */
function looksLikeIdentifier(seg: string): boolean {
  if (!seg) return false;
  if (UUID_RE.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  return seg.length >= 16 && /\d/.test(seg);
}

const PROJECT_ID_PATH_RE = /^\/projects\/([^/]+)(?:\/|$)/;

/**
 * Pull the project id out of a route, for a cache lookup only (#3388) — never
 * for the reported body, which strips it via {@link sanitizeRoutePath}.
 *
 * Matches any non-empty segment, not just the canonical UUID shape: the
 * router declares exactly one route under `/projects/` — `projects/:projectId`
 * (see `router.tsx`), with no fixed keyword segment (no `/projects/new`) that
 * a broader match could collide with — so whatever sits there always *is* the
 * project id, canonical UUID in production or a human-readable fixture id in
 * tests. A regex requiring the strict UUID shape would silently never fire
 * against this codebase's own e2e fixtures (`e2e-feedback-0000-...`), which
 * is exactly the false-negative direction this function is supposed to prefer
 * — just not for a reason this narrow. Still stricter than
 * {@link looksLikeIdentifier} in one way: it only ever reads the segment the
 * route itself declares as the id, so there's nothing here for a false
 * *positive* to misfire against.
 */
export function extractProjectId(href: string): string | null {
  let path: string;
  try {
    path = new URL(href, 'http://localhost').pathname;
  } catch {
    path = href.split('?')[0]?.split('#')[0] ?? '/';
  }
  return PROJECT_ID_PATH_RE.exec(path)?.[1] ?? null;
}

/**
 * The issue body, shown verbatim in-app before the user leaves.
 *
 * Prompts for expected / actual / steps rather than leaving a blank box: a
 * report that omits what the user expected is usually unactionable, and asking
 * at the moment of frustration is the only time it gets answered.
 */
export function buildFeedbackBody(ctx: FeedbackContext): string {
  return [
    '### What happened',
    '',
    '',
    '### What you expected',
    '',
    '',
    '### Steps to reproduce',
    '',
    '1. ',
    '2. ',
    '',
    '---',
    '',
    '<!-- Environment, filled in automatically. Edit or remove anything you',
    '     would rather not share. -->',
    '',
    `- TruePPM: ${ctx.version}${ctx.buildSha ? ` (${ctx.buildSha.slice(0, 8)})` : ''}`,
    `- Edition: ${ctx.edition}`,
    `- Screen: ${ctx.routePath}`,
    `- Browser: ${ctx.userAgent}`,
    // Omitted rather than reported as 0 when unknown (#3388) — see the field's
    // own doc comment. Line order keeps it last: everything above is always
    // present, so a reader scanning for "did they include project size" finds
    // it (or its absence) at a fixed spot.
    ...(ctx.taskCount === undefined
      ? []
      : [`- Project size: ${ctx.taskCount.toLocaleString()} tasks`]),
  ].join('\n');
}

/**
 * Compose the target URL.
 *
 * GitLab's new-issue form reads `issue[title]` / `issue[description]`; those
 * params are harmless on a tracker that ignores them, so a repointed operator
 * URL still works and simply arrives without the prefill.
 */
export function buildFeedbackUrl(baseUrl: string, ctx: FeedbackContext): string {
  const url = new URL(baseUrl);
  url.searchParams.set('issue[title]', '');
  url.searchParams.set('issue[description]', buildFeedbackBody(ctx));
  return url.toString();
}

/** Read the current context. Pure with respect to the network — nothing is sent. */
export function collectFeedbackContext(input: {
  version: string;
  edition: string;
  buildSha: string;
  href: string;
  userAgent: string;
  taskCount?: number;
}): FeedbackContext {
  return {
    version: input.version,
    edition: input.edition,
    buildSha: input.buildSha,
    routePath: sanitizeRoutePath(input.href),
    userAgent: input.userAgent,
    taskCount: input.taskCount,
  };
}
