/**
 * Guards for the Settings section→docs map (ADR-0682).
 *
 * Two separate things rot, so there are two separate suites:
 *
 *   1. **Coverage** — a new settings section shipping with no help entry. This is
 *      the exact regression #2487 was filed for: 38 of 44 sections had no docs
 *      path because nothing ever checked.
 *   2. **Resolution** — a docs heading being renamed or a page moved, silently
 *      turning a shipped in-product link into a dead one. Caught here rather than
 *      by a user.
 *
 * The resolution suite reads the real docs tree off disk. It is deliberately
 * coupled to `packages/website`: that coupling is the mechanism that keeps the
 * links honest, and it means a docs restructure must update the map in the same MR.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SETTINGS_DOCS, settingsDocsSlug, type SettingsScope } from './settingsDocs';
import { buildWorkspaceNavGroups } from './workspace/workspaceNav';
import { buildProgramSettingsNav } from './ProgramSettingsPage';
import { buildProjectSettingsNav, buildProjectSettingsMemberNav } from './ProjectSettingsPage';
import type { SettingsNavGroup } from './SettingsShell';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(HERE, '../../../../website/src/content/docs');

/** Every section id a scope's nav can render, flattened across its groups. */
function navSectionIds(groups: SettingsNavGroup[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.id));
}

/**
 * Slugify a markdown heading the way Starlight (github-slugger) does: lowercase,
 * drop every character outside `[a-z0-9 -]`, then spaces to hyphens.
 *
 * Runs of hyphens are NOT collapsed — "Groups & teams" becomes `groups--teams`,
 * because the `&` leaves its surrounding spaces behind. The repo already contains
 * a link relying on that exact behavior
 * (`#invites-settingsmembers--invite-flow`), which the test below pins.
 */
function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-');
}

/** All `##`/`###` heading slugs in a docs markdown file. */
function headingSlugs(absPath: string): Set<string> {
  const body = readFileSync(absPath, 'utf8');
  const slugs = new Set<string>();
  for (const line of body.split('\n')) {
    const m = /^#{2,4} (.+?)\s*$/.exec(line);
    if (m) slugs.add(slugifyHeading(m[1]));
  }
  return slugs;
}

/** Split `administration/project-settings/#general` into its page and fragment. */
function splitSlug(slug: string): { page: string; fragment: string | null } {
  const [page, fragment] = slug.split('#');
  return { page: page.replace(/\/$/, ''), fragment: fragment ?? null };
}

const SCOPES: SettingsScope[] = ['workspace', 'program', 'project'];

// `showTeamTab: true` so the methodology-gated Team and Signal-privacy sections
// (ADR-0078/ADR-0104) are included — a section that only some methodologies show
// still needs a docs entry.
const NAV_BY_SCOPE: Record<SettingsScope, string[]> = {
  workspace: navSectionIds(buildWorkspaceNavGroups({ linked: false })),
  program: navSectionIds(buildProgramSettingsNav()),
  // Union of the admin rail and the reduced member rail (#2971): a section a
  // non-admin can reach still needs a help entry, and the orphan check below must
  // not read the member rail's ids as leftovers.
  project: [
    ...navSectionIds(buildProjectSettingsNav({ showTeamTab: true, iterationSingular: 'Sprint' })),
    ...navSectionIds(buildProjectSettingsMemberNav()),
  ],
};

describe('slugifyHeading', () => {
  it('matches the anchors already published in the docs tree', () => {
    // Pinned against a real inbound link in features/settings/project-members.md,
    // so a change to this helper that diverges from Starlight fails here.
    expect(slugifyHeading('Invites (`/settings/members` → invite flow)')).toBe(
      'invites-settingsmembers--invite-flow',
    );
    expect(slugifyHeading('Groups & teams (`/settings/groups`)')).toBe(
      'groups--teams-settingsgroups',
    );
    expect(slugifyHeading('Workflow & fields')).toBe('workflow--fields');
    expect(slugifyHeading('General API rate limiting')).toBe('general-api-rate-limiting');
  });
});

describe('SETTINGS_DOCS coverage', () => {
  it.each(SCOPES)('every %s nav section has a docs entry', (scope) => {
    const missing = NAV_BY_SCOPE[scope].filter((id) => !settingsDocsSlug(scope, id));
    // A new section must ship with help. Add an entry to settingsDocs.ts — and
    // if the section has no documentation of its own yet, point at the parent
    // page without a fragment rather than inventing an anchor.
    expect(missing).toEqual([]);
  });

  it.each(SCOPES)('has no orphan %s entries', (scope) => {
    const navIds = new Set(NAV_BY_SCOPE[scope]);
    const orphans = Object.keys(SETTINGS_DOCS[scope]).filter((id) => !navIds.has(id));
    // A leftover entry means a section was renamed or removed and the map was not
    // updated — the map would then be silently wrong for the renamed section.
    expect(orphans).toEqual([]);
  });
});

describe('SETTINGS_DOCS resolution', () => {
  const entries = SCOPES.flatMap((scope) =>
    Object.entries(SETTINGS_DOCS[scope]).map(([id, slug]) => ({ scope, id, slug })),
  );

  it('covers all 48 sections', () => {
    expect(entries).toHaveLength(48);
  });

  it.each(entries)('$scope/$id → $slug resolves to a real docs page', ({ slug }) => {
    const { page, fragment } = splitSlug(slug);
    const absPath = resolve(DOCS_ROOT, `${page}.md`);
    expect(existsSync(absPath), `missing docs page: ${page}.md`).toBe(true);

    if (fragment) {
      expect(headingSlugs(absPath), `no heading in ${page}.md slugifies to #${fragment}`).toContain(
        fragment,
      );
    }
  });

  it('never points at an in-app /docs path (rule 212)', () => {
    for (const { slug } of entries) {
      expect(slug.startsWith('/')).toBe(false);
      expect(slug).not.toMatch(/^https?:/);
    }
  });
});
