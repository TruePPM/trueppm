import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import type { SettingsNavGroup } from './SettingsShell';
import { buildProjectSettingsNav, buildProjectSettingsMemberNav } from './ProjectSettingsPage';
import { buildProgramSettingsNav } from './ProgramSettingsPage';
import { buildWorkspaceNavGroups } from './workspace/workspaceNav';
import { ExternalLinkIcon, WarningIcon } from '@/components/Icons';

/**
 * Glyph uniqueness across every settings rail (issue 2425).
 *
 * The defect this locks out: 6 of the 9 project `Configuration` rows rendered the
 * same glyph (SettingsIcon x5, ExternalLinkIcon x2). A column where most entries
 * are identical is negative information — it trains the eye to skip the column,
 * which costs the rows whose icon actually distinguishes them.
 *
 * The rule is per *group*, not per rail: the same concept deliberately keeps the
 * same glyph across the project / program / workspace rails, so a cross-group
 * repeat is intended and a within-group repeat is the bug.
 */

/** Every rail, in the variants that change which rows are present. */
const RAILS: Array<{ name: string; groups: SettingsNavGroup[] }> = [
  {
    name: 'project (agile — Team and Signal privacy present)',
    groups: buildProjectSettingsNav({ showTeamTab: true, iterationSingular: 'Sprint' }),
  },
  {
    name: 'project (pre-methodology — Team and Signal privacy hidden)',
    groups: buildProjectSettingsNav({ showTeamTab: false, iterationSingular: 'Sprint' }),
  },
  {
    // The reduced rail a non-admin project member sees (#2971). One row today, so
    // uniqueness is vacuous — it is listed anyway because the moment a second
    // member-readable section is added, this is the only place that would catch it
    // reusing the first one's glyph.
    name: 'project (member view — non-admin)',
    groups: buildProjectSettingsMemberNav(),
  },
  { name: 'program', groups: buildProgramSettingsNav() },
  { name: 'workspace (inline)', groups: buildWorkspaceNavGroups({ linked: false }) },
  { name: 'workspace (deep-linked)', groups: buildWorkspaceNavGroups({ linked: true }) },
];

/**
 * Resolve a nav item's `icon` to the icon component itself.
 *
 * Every rail wraps its glyph in a local `NavIcon` sizing span, so the component
 * that carries the meaning is the wrapper's single child — comparing the wrappers
 * would find every row identical.
 */
function iconComponent(icon: unknown): unknown {
  if (!isValidElement(icon)) return icon;
  const { children } = icon.props as { children?: unknown };
  return isValidElement(children) ? children.type : icon.type;
}

describe.each(RAILS)('$name settings rail', ({ groups }) => {
  it.each(groups.map((g) => [g.label, g] as const))(
    'renders no repeated glyph within the %s group',
    (_label, group) => {
      const icons = group.items.map((item) => iconComponent(item.icon));
      expect(new Set(icons).size).toBe(icons.length);
    },
  );

  it('never uses ExternalLinkIcon — no settings row navigates off-app', () => {
    // An arrow leaving a box conventionally means "this leaves the app". Attachments
    // and Sharing stay inside TruePPM, so the glyph was actively misleading, not
    // merely generic.
    const icons = groups.flatMap((g) => g.items.map((item) => iconComponent(item.icon)));
    expect(icons).not.toContain(ExternalLinkIcon);
  });

  it('reserves WarningIcon for the Danger group', () => {
    // A warning triangle has to keep meaning "exception". Spending it on routine
    // configuration (sprint guardrails, notifications) is what made it stop reading
    // as one.
    const misplaced = groups
      .filter((g) => g.label !== 'Danger')
      .flatMap((g) => g.items.map((item) => ({ label: item.label, icon: iconComponent(item.icon) })))
      .filter((entry) => entry.icon === WarningIcon)
      .map((entry) => entry.label);
    expect(misplaced).toEqual([]);
  });
});
