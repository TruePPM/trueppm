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
    // Danger sits before the System group, which stays LAST so the scroll order
    // reads Organization → Delivery → Danger → System (#2298). Every item — System
    // included — is now a scroll anchor, not a route departure.
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
      'rate-limit',
      'observability',
      'retention',
      'trash',
    ];
    expect(itemIds(buildWorkspaceNavGroups({ linked: false }))).toEqual(expected);
    expect(itemIds(buildWorkspaceNavGroups({ linked: true }))).toEqual(expected);
  });

  it('no item is external — System is part of the scroll surface now (#2298)', () => {
    for (const mode of [false, true]) {
      const groups = buildWorkspaceNavGroups({ linked: mode });
      const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
      // The System items dropped `external` — they scroll-anchor like every other
      // group, which is what auto-removes the "Opens a separate page" caption (#2291).
      expect(byId.health.external).toBeUndefined();
      expect(byId['rate-limit'].external).toBeUndefined();
      expect(byId.observability.external).toBeUndefined();
      expect(byId.retention.external).toBeUndefined();
      expect(byId.trash.external).toBeUndefined();
      expect(byId.general.external).toBeUndefined();
      expect(byId.danger.external).toBeUndefined();
    }
  });

  it('inline mode (consolidated page) omits `to` on EVERY item — System included — so they scroll-spy', () => {
    const groups = buildWorkspaceNavGroups({ linked: false });
    const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
    // Config sections are inline (no `to`)…
    expect(byId.general.to).toBeUndefined();
    expect(byId.sso.to).toBeUndefined();
    expect(byId.danger.to).toBeUndefined();
    // …and so are the System sections now (#2298).
    expect(byId.health.to).toBeUndefined();
    expect(byId['rate-limit'].to).toBeUndefined();
    expect(byId.observability.to).toBeUndefined();
    expect(byId.retention.to).toBeUndefined();
    expect(byId.trash.to).toBeUndefined();
  });

  it('linked mode (off-route shells) deep-links EVERY item back to the consolidated anchor', () => {
    const groups = buildWorkspaceNavGroups({ linked: true });
    const byId = Object.fromEntries(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
    expect(byId.general.to).toBe('/settings#general');
    expect(byId.sso.to).toBe('/settings#sso');
    expect(byId.danger.to).toBe('/settings#danger');
    // System sections deep-link to their consolidated anchors too (#2298).
    expect(byId.health.to).toBe('/settings#health');
    expect(byId['rate-limit'].to).toBe('/settings#rate-limit');
    expect(byId.observability.to).toBe('/settings#observability');
    expect(byId.retention.to).toBe('/settings#retention');
    expect(byId.trash.to).toBe('/settings#trash');
  });
});
