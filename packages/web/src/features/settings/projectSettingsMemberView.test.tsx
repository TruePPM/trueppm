import { describe, it, expect } from 'vitest';
import { buildProjectSettingsMemberNav, buildProjectSettingsNav } from './ProjectSettingsPage';

/**
 * The reduced project-settings rail a non-admin member sees (#2971).
 *
 * The failure this pins is not "a section is missing" — it is the whole issue:
 * project settings was admin-only end to end (`RequireAdminSettings` bounces
 * anyone whose org-wide `can_access_admin_settings` is false), so a divergence
 * digest mounted only on the consolidated page would have been readable by the
 * PMO and unreachable by the team it reports on. The endpoint answering a Viewer
 * with 200 proves nothing on its own if no route renders it.
 */
describe('project settings — member view', () => {
  it('carries the divergence digest, the one section a member is here for', () => {
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain('template-divergence');
  });

  it('carries nothing a non-admin cannot act on', () => {
    // A declared allow-list, not a filter: a section becomes member-visible by
    // being named in the member builder. If this ever grows, it must grow by
    // someone deciding it should — which is what makes this assertion worth having
    // even though it looks like it just restates the builder.
    const ids = buildProjectSettingsMemberNav().flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(['template-divergence']);
  });

  it('uses the same section id as the admin rail, so one anchor serves both', () => {
    // `/projects/:id/settings#template-divergence` must resolve for an admin and a
    // member alike. Two ids would mean two addresses for one report, which is the
    // seam a "PMO copy" would eventually grow out of.
    const adminIds = buildProjectSettingsNav({
      showTeamTab: true,
      iterationSingular: 'Sprint',
    }).flatMap((g) => g.items.map((i) => i.id));
    expect(adminIds).toContain('template-divergence');
  });

  it('labels the member rail for its audience, not as a subset of the admin one', () => {
    const groups = buildProjectSettingsMemberNav();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Your project');
  });
});
