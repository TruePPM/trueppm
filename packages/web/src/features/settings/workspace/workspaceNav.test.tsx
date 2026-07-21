import { describe, it, expect } from 'vitest';
import { buildWorkspaceNavGroups } from './workspaceNav';

/** Flatten every nav item's id across all groups, in order. */
function itemIds(groups: ReturnType<typeof buildWorkspaceNavGroups>): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.id));
}

describe('buildWorkspaceNavGroups (#2013 — one source of truth, no drift)', () => {
  it('lists the full rail — SSO and the whole Delivery group included — in both modes', () => {
    // The off-route Trash / System Health shells used to hand-copy NAV_GROUPS and
    // dropped `sso` plus most of Delivery; both modes must now be complete.
    // Danger (an inline scroll section) sits BEFORE the System tool group so the
    // consolidated page's inline sections stay contiguous and the route-departure
    // tools cluster last (#2252). Observability is a System tool (#2250).
    const expected = [
      'general',
      'members',
      'groups',
      'roles',
      'sso',
      'methodology',
      'schedule',
      'calendar',
      'programs',
      'attachments',
      'email',
      'danger',
      'health',
      'observability',
      'retention',
      'trash',
    ];
    expect(itemIds(buildWorkspaceNavGroups({ linked: false }))).toEqual(expected);
    expect(itemIds(buildWorkspaceNavGroups({ linked: true }))).toEqual(expected);
  });

  it('marks the System tool items external (route departures) with their own routes (#2250/#2252)', () => {
    for (const mode of [false, true]) {
      const groups = buildWorkspaceNavGroups({ linked: mode });
      const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
      // Observability is its own tool page, flagged external in both modes.
      expect(byId.observability.to).toBe('/settings/observability');
      expect(byId.observability.external).toBe(true);
      // The other System tools are external too; inline config sections are not.
      expect(byId.health.external).toBe(true);
      expect(byId.trash.external).toBe(true);
      expect(byId.general.external).toBeUndefined();
      expect(byId.danger.external).toBeUndefined();
    }
  });

  it('inline mode (consolidated page) omits `to` on config sections so they scroll-spy', () => {
    const groups = buildWorkspaceNavGroups({ linked: false });
    const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
    // Config sections are inline (no `to`).
    expect(byId.general.to).toBeUndefined();
    expect(byId.sso.to).toBeUndefined();
    expect(byId.methodology.to).toBeUndefined();
    expect(byId.danger.to).toBeUndefined();
    // System Health tools always navigate — separate routes.
    expect(byId.health.to).toBe('/settings/health');
    expect(byId.trash.to).toBe('/settings/trash');
  });

  it('linked mode (off-route shells) deep-links config sections back to the consolidated anchor', () => {
    const groups = buildWorkspaceNavGroups({ linked: true });
    const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
    expect(byId.general.to).toBe('/settings#general');
    expect(byId.sso.to).toBe('/settings#sso');
    expect(byId.calendar.to).toBe('/settings#calendar');
    expect(byId.danger.to).toBe('/settings#danger');
    // System Health tools keep their own routes regardless of mode.
    expect(byId.health.to).toBe('/settings/health');
    expect(byId.retention.to).toBe('/settings/health/retention');
  });
});
