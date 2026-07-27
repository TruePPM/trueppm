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
 * which browser. It carries no workspace, program, project or task identifier,
 * no user identity, and no schedule content — the route *path* tells us where
 * the user was without telling us what they were looking at.
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
}): FeedbackContext {
  return {
    version: input.version,
    edition: input.edition,
    buildSha: input.buildSha,
    routePath: sanitizeRoutePath(input.href),
    userAgent: input.userAgent,
  };
}
