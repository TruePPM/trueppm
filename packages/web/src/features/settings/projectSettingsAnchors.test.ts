import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildProjectSettingsNav,
  buildProjectSettingsMemberNav,
  PROJECT_SETTINGS_ANCHOR_ALIASES,
} from './ProjectSettingsPage';
import {
  TEAM_WORKFLOW_SECTION_ID,
  TEAM_WORKFLOW_SUBSECTION_IDS,
} from './project/ProjectTeamWorkflowPage';

/**
 * The project settings rail after the #2969 consolidation, and the promise that
 * consolidation made: **old addresses keep working**.
 *
 * The regression this file exists for is not "the new section is missing" — that
 * is loud. It is a retired anchor quietly resolving to nothing, which is silent by
 * construction: an unknown hash produces no error, no scroll, and a page top that
 * looks like a slow load. Both halves of the promise are pinned here, because they
 * are implemented by two different mechanisms that cannot see each other — the
 * router redirects the `/settings/<slug>` routes, the shell rewrites the
 * `#<slug>` hashes, and a hash is not part of the path a route matches.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = readFileSync(resolve(HERE, '../../router.tsx'), 'utf8');

const navIds = (opts?: { showTeamTab?: boolean }) =>
  buildProjectSettingsNav({
    showTeamTab: opts?.showTeamTab ?? true,
    iterationSingular: 'Sprint',
  }).flatMap((g) => g.items.map((i) => i.id));

describe('project settings rail — the three agile anchors are one row (#2969)', () => {
  it('carries the consolidated row', () => {
    expect(navIds()).toContain(TEAM_WORKFLOW_SECTION_ID);
  });

  it('carries none of the three rows it replaced', () => {
    const ids = navIds();
    for (const retired of TEAM_WORKFLOW_SUBSECTION_IDS) {
      expect(ids).not.toContain(retired);
    }
  });

  it('keeps the row in the pre-methodology rail too', () => {
    // `showTeamTab: false` drops Team and Signal privacy. The methodology decision
    // is exactly what a pre-methodology project is here to make, so it must not be
    // one of the rows that disappears.
    expect(navIds({ showTeamTab: false })).toContain(TEAM_WORKFLOW_SECTION_ID);
  });

  it('answers a rail search for every term the retired rows answered to', () => {
    // The rail filter matches label + keywords (#2320). Collapsing three rows into
    // one silently drops their vocabulary unless it is carried over, and the user
    // who typed "guardrails" gets an empty rail with no explanation.
    const row = buildProjectSettingsNav({ showTeamTab: true, iterationSingular: 'Sprint' })
      .flatMap((g) => g.items)
      .find((i) => i.id === TEAM_WORKFLOW_SECTION_ID);
    expect(row).toBeDefined();
    const haystack = `${row!.label} ${row!.keywords ?? ''}`.toLowerCase();
    for (const term of [
      'methodology',
      'waterfall',
      'agile',
      'hybrid',
      'workflow',
      'statuses',
      'lanes',
      'wip',
      'custom fields',
      'cadence',
      'guardrails',
    ]) {
      expect(haystack, `rail search for "${term}" finds nothing`).toContain(term);
    }
  });

  it('titles the row for the decision, not for the settings object', () => {
    const row = buildProjectSettingsNav({ showTeamTab: true, iterationSingular: 'Sprint' })
      .flatMap((g) => g.items)
      .find((i) => i.id === TEAM_WORKFLOW_SECTION_ID);
    expect(row!.label).toBe('How this team works');
  });
});

describe('retired anchors keep resolving (#2969)', () => {
  it('maps every retired id to the section that absorbed it', () => {
    expect(PROJECT_SETTINGS_ANCHOR_ALIASES).toEqual({
      methodology: TEAM_WORKFLOW_SECTION_ID,
      workflow: TEAM_WORKFLOW_SECTION_ID,
      guardrails: TEAM_WORKFLOW_SECTION_ID,
    });
  });

  it('every alias target is a live rail section', () => {
    // An alias pointing at an id no rail renders is worse than no alias: the shell
    // silently declines the rewrite and the user still lands nowhere.
    const ids = new Set(navIds());
    for (const target of Object.values(PROJECT_SETTINGS_ANCHOR_ALIASES)) {
      expect(ids.has(target)).toBe(true);
    }
  });

  it('no alias shadows a live section id', () => {
    const ids = new Set(navIds());
    for (const from of Object.keys(PROJECT_SETTINGS_ANCHOR_ALIASES)) {
      expect(ids.has(from)).toBe(false);
    }
  });

  it('the router redirects the route form of each retired anchor to the same place', () => {
    // Read off `router.tsx` source rather than by mounting the whole route tree:
    // the assertion is about configuration, and a redirect that exists but points
    // at the old anchor is exactly the mistake a mounted test would also have to
    // spell out. The E2E spec drives the real navigation.
    for (const slug of TEAM_WORKFLOW_SUBSECTION_IDS) {
      const route = new RegExp(
        `path: 'settings/${slug}',[\\s\\S]{0,320}?anchor="${TEAM_WORKFLOW_SECTION_ID}"`,
      );
      expect(ROUTER, `settings/${slug} does not redirect to #${TEAM_WORKFLOW_SECTION_ID}`).toMatch(
        route,
      );
    }
  });

  it('leaves the other legacy section redirects pointing at their own anchors', () => {
    // The consolidation must not have been done by rewriting the redirect block
    // wholesale — every other `/settings/<slug>` still answers on its own id.
    for (const slug of ['general', 'access', 'team', 'calendars', 'lifecycle']) {
      expect(ROUTER).toMatch(
        new RegExp(`path: 'settings/${slug}',[\\s\\S]{0,320}?anchor="${slug}"`),
      );
    }
  });
});

describe('the member rail is untouched by the consolidation (#2971)', () => {
  it('still carries exactly the divergence digest', () => {
    // #2971 pinned this allow-list deliberately. #2969 collapses three ADMIN rows
    // and must not widen what a non-admin member is shown — restated here so a
    // future consolidation that reaches into the member builder fails on the
    // issue that owns it, not only on #2971's own file.
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(['template-divergence']);
  });

  it('does not show a member the consolidated admin section', () => {
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain(TEAM_WORKFLOW_SECTION_ID);
  });
});
