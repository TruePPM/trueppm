import { describe, expect, it } from 'vitest';
import { resolveContextTabs } from './contextTabs';

const LABEL: Record<string, string> = {
  overview: 'Dashboard',
  today: 'Today',
  schedule: 'Schedule',
  grid: 'Grid',
  calendar: 'Calendar',
  board: 'Board',
  sprints: 'Sprints',
  'product-backlog': 'Backlog',
  risk: 'Risks',
  reports: 'Reports',
  activity: 'Activity',
  assets: 'Assets',
  resources: 'Team',
  settings: 'Settings',
  backlog: 'Backlog',
  projects: 'Projects',
  labels: 'Labels',
  agents: 'Agents',
  members: 'Members',
};
const labelFor = (v: string) => LABEL[v] ?? v;

const WATERFALL = [
  'schedule',
  'grid',
  'calendar',
  'overview',
  'today',
  'board',
  'risk',
  'reports',
  'activity',
  'assets',
  'resources',
  'settings',
];
const AGILE_NO_SCHEDULE = [
  'grid',
  'calendar',
  'product-backlog',
  'sprints',
  'board',
  'overview',
  'today',
  'risk',
  'reports',
  'activity',
  'assets',
  'resources',
];

describe('resolveContextTabs — project', () => {
  it('renders the five tabs in fixed order with the layout toggles under Plan and Deliver', () => {
    const m = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/ATL',
      activeView: 'overview',
      visibleViews: WATERFALL,
      labelFor,
    });
    expect(m.tabs.map((t) => t.key)).toEqual(['overview', 'plan', 'deliver', 'risks', 'people']);
    expect(m.tabs[1].toggles.map((t) => t.view)).toEqual(['schedule', 'grid', 'calendar']);
    expect(m.tabs[2].toggles.map((t) => t.view)).toEqual(['board']);
    expect(m.more.map((t) => t.view)).toEqual([
      'today',
      'reports',
      'activity',
      'assets',
      'settings',
    ]);
  });

  it('a tab goes to its active toggle, else its first toggle', () => {
    const onGrid = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/ATL',
      activeView: 'grid',
      visibleViews: WATERFALL,
      labelFor,
    });
    const plan = onGrid.tabs.find((t) => t.key === 'plan')!;
    expect(plan.active).toBe(true);
    expect(plan.to).toBe('/projects/ATL/grid');
    const elsewhere = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/ATL',
      activeView: 'risk',
      visibleViews: WATERFALL,
      labelFor,
    });
    expect(elsewhere.tabs.find((t) => t.key === 'plan')!.to).toBe('/projects/ATL/schedule');
    expect(elsewhere.tabs.filter((t) => t.active).map((t) => t.key)).toEqual(['risks']);
  });

  it('every project has Plan with Schedule, even when the methodology filter removed it', () => {
    const m = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/AG',
      activeView: 'board',
      visibleViews: AGILE_NO_SCHEDULE,
      labelFor,
    });
    expect(m.tabs.find((t) => t.key === 'plan')!.toggles.map((t) => t.view)).toEqual([
      'schedule',
      'grid',
      'calendar',
    ]);
    expect(m.tabs.find((t) => t.key === 'deliver')!.toggles.map((t) => t.view)).toEqual([
      'board',
      'sprints',
      'product-backlog',
    ]);
  });

  it('drops a tab whose every view is hidden, and keeps settings out of the tab row', () => {
    const m = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/ATL',
      activeView: 'overview',
      visibleViews: ['overview', 'schedule'],
      labelFor,
    });
    expect(m.tabs.map((t) => t.key)).toEqual(['overview', 'plan']);
    expect(m.more).toEqual([]);
  });

  it('uses the caller labels so the iteration noun is the configured one', () => {
    const m = resolveContextTabs({
      userHiddenViews: [],
      scope: 'project',
      basePath: '/projects/AG',
      activeView: 'sprints',
      visibleViews: AGILE_NO_SCHEDULE,
      labelFor: (v) => (v === 'sprints' ? 'Iterations' : labelFor(v)),
    });
    expect(
      m.tabs.find((t) => t.key === 'deliver')!.toggles.find((t) => t.view === 'sprints')!.label,
    ).toBe('Iterations');
  });
});

describe('resolveContextTabs — program', () => {
  it('maps the program views onto the same four tabs (no Risks) and folds the rest under More', () => {
    const m = resolveContextTabs({
      userHiddenViews: [],
      scope: 'program',
      basePath: '/programs/PM',
      activeView: 'agents',
      visibleViews: [
        'overview',
        'backlog',
        'projects',
        'schedule',
        'resources',
        'members',
        'assets',
        'settings',
        'labels',
        'agents',
      ],
      labelFor,
    });
    expect(m.tabs.map((t) => t.key)).toEqual(['overview', 'plan', 'deliver', 'people']);
    expect(m.tabs.find((t) => t.key === 'deliver')!.to).toBe('/programs/PM/backlog');
    expect(m.more.map((t) => t.view)).toEqual([
      'projects',
      'labels',
      'agents',
      'members',
      'assets',
      'settings',
    ]);
    expect(m.more.find((t) => t.view === 'agents')!.active).toBe(true);
    expect(m.tabs.some((t) => t.active)).toBe(false);
  });
});

describe('resolveContextTabs — personal hidden views', () => {
  it('a view the person hid stays hidden, even Schedule', () => {
    const m = resolveContextTabs({
      userHiddenViews: ['schedule', 'risk'],
      scope: 'project',
      basePath: '/projects/ATL',
      activeView: 'overview',
      visibleViews: WATERFALL.filter((v) => v !== 'schedule' && v !== 'risk'),
      labelFor,
    });
    expect(m.tabs.find((t) => t.key === 'plan')!.toggles.map((t) => t.view)).toEqual([
      'grid',
      'calendar',
    ]);
    expect(m.tabs.some((t) => t.key === 'risks')).toBe(false);
  });
});
