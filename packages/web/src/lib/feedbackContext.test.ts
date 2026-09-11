/**
 * Feedback context assembly (#2392).
 *
 * These tests are the privacy contract. The feature's whole premise is that a
 * self-hosted instance never leaks identifiers, so "what is NOT in the body" is
 * asserted at least as hard as what is.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeRoutePath,
  buildFeedbackBody,
  buildFeedbackUrl,
  collectFeedbackContext,
  extractProjectId,
  DEFAULT_FEEDBACK_URL,
} from './feedbackContext';

const CTX = {
  version: '0.4.0-beta.1',
  edition: 'community',
  buildSha: 'abcdef1234567890',
  routePath: '/projects/:id/board',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

describe('sanitizeRoutePath — what the route may reveal', () => {
  it('drops the query string, which carries filter values and search terms', () => {
    expect(sanitizeRoutePath('/projects/abc/board?q=payroll+migration&fa=u1')).toBe(
      '/projects/abc/board',
    );
  });

  it('drops the fragment too', () => {
    expect(sanitizeRoutePath('/board#task-notes')).toBe('/board');
  });

  it('replaces UUID segments — a project id in the PATH identifies it just as well', () => {
    expect(
      sanitizeRoutePath('/projects/e2e-fixture-0000-0000-0000-000000000001/board'),
    ).not.toContain('e2e-fixture');
  });

  it('replaces a real UUID with a placeholder', () => {
    expect(sanitizeRoutePath('/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/schedule')).toBe(
      '/projects/:id/schedule',
    );
  });

  it('replaces bare numeric ids', () => {
    expect(sanitizeRoutePath('/programs/42/overview')).toBe('/programs/:id/overview');
  });

  it('keeps the surface shape, which is the whole point', () => {
    expect(sanitizeRoutePath('/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/board')).toBe(
      '/projects/:id/board',
    );
  });

  it('handles a full URL and a bare path identically', () => {
    expect(sanitizeRoutePath('https://app.example.com/me/work?x=1')).toBe('/me/work');
    expect(sanitizeRoutePath('/me/work?x=1')).toBe('/me/work');
  });
});

describe('buildFeedbackBody — what travels', () => {
  it('names the build, edition, surface and browser', () => {
    const body = buildFeedbackBody(CTX);
    expect(body).toContain('0.4.0-beta.1');
    expect(body).toContain('community');
    expect(body).toContain('/projects/:id/board');
    expect(body).toContain('Mozilla/5.0 (Macintosh)');
  });

  it('abbreviates the SHA and omits it entirely when absent', () => {
    expect(buildFeedbackBody(CTX)).toContain('abcdef12');
    // A source checkout has no SHA; the version alone is enough there, and an
    // empty parenthetical would just look broken.
    expect(buildFeedbackBody({ ...CTX, buildSha: '' })).not.toContain('()');
  });

  it('prompts for expected / actual / steps rather than opening a blank box', () => {
    const body = buildFeedbackBody(CTX);
    expect(body).toContain('What happened');
    expect(body).toContain('What you expected');
    expect(body).toContain('Steps to reproduce');
  });

  it('tells the user they may edit or remove the environment block', () => {
    expect(buildFeedbackBody(CTX)).toContain('Edit or remove anything');
  });
});

describe('buildFeedbackBody — what must NOT travel', () => {
  it('carries no identifiers, user identity, or schedule content', () => {
    const ctx = collectFeedbackContext({
      version: '0.4.0',
      edition: 'community',
      buildSha: 'sha',
      href: '/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/board?q=Acme%20payroll&assignee=u-77',
      userAgent: 'UA',
    });
    const body = buildFeedbackBody(ctx);

    expect(body).not.toContain('3f2504e0');
    expect(body).not.toContain('Acme');
    expect(body).not.toContain('payroll');
    expect(body).not.toContain('u-77');
  });
});

describe('extractProjectId — a cache key, never a reported field (#3388)', () => {
  it('reads the project id out of a project route', () => {
    expect(extractProjectId('/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/board')).toBe(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
  });

  it('works from a full URL, query string and all', () => {
    expect(
      extractProjectId(
        'https://app.example.com/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/schedule?q=x',
      ),
    ).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('returns null off a project route', () => {
    expect(extractProjectId('/me/work')).toBeNull();
    expect(extractProjectId('/programs/3f2504e0-4f89-11d3-9a0c-0305e82c3301/overview')).toBeNull();
  });

  it('matches a non-UUID fixture id too — the route has only one shape under /projects/', () => {
    // `router.tsx` declares exactly one route here (`projects/:projectId`, no
    // `/projects/new`-style keyword to collide with), so whatever segment sits
    // there IS the project id — canonical UUID in production, a
    // human-readable id in this repo's own e2e fixtures.
    expect(extractProjectId('/projects/e2e-feedback-0000-0000-0000-000000002392/schedule')).toBe(
      'e2e-feedback-0000-0000-0000-000000002392',
    );
  });
});

describe('buildFeedbackBody — task count (#3388)', () => {
  it('reports the task count when known', () => {
    const body = buildFeedbackBody({ ...CTX, taskCount: 1234 });
    expect(body).toContain('Project size: 1,234 tasks');
  });

  it('omits the line entirely when the count is unknown, rather than reporting 0', () => {
    const body = buildFeedbackBody(CTX);
    expect(body).not.toContain('Project size');
  });
});

describe('collectFeedbackContext — task count passthrough (#3388)', () => {
  it('carries the task count straight through', () => {
    const ctx = collectFeedbackContext({
      version: '0.4.0',
      edition: 'community',
      buildSha: 'sha',
      href: '/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/schedule',
      userAgent: 'UA',
      taskCount: 42,
    });
    expect(ctx.taskCount).toBe(42);
  });

  it('leaves it undefined when the caller did not supply one', () => {
    const ctx = collectFeedbackContext({
      version: '0.4.0',
      edition: 'community',
      buildSha: 'sha',
      href: '/me/work',
      userAgent: 'UA',
    });
    expect(ctx.taskCount).toBeUndefined();
  });
});

describe('buildFeedbackUrl', () => {
  it('prefills the tracker form without sending anything', () => {
    const url = new URL(buildFeedbackUrl(DEFAULT_FEEDBACK_URL, CTX));
    expect(url.origin + url.pathname).toBe(DEFAULT_FEEDBACK_URL);
    expect(url.searchParams.get('issue[description]')).toContain('0.4.0-beta.1');
  });

  it('works against an operator-repointed tracker', () => {
    // The prefill params are harmless on a tracker that ignores them, so a
    // self-hoster's own helpdesk URL still opens — just without the prefill.
    const url = buildFeedbackUrl('https://helpdesk.internal/new', CTX);
    expect(url).toContain('https://helpdesk.internal/new');
  });
});
