export type ContextTabKey = 'overview' | 'plan' | 'deliver' | 'risks' | 'people';

export interface ContextToggle {
  /** The route segment (`schedule`, `board`, …) — the same key `VIEW_TAB_META` uses. */
  view: string;
  label: string;
  to: string;
  active: boolean;
}

export interface ContextTab {
  key: ContextTabKey;
  label: string;
  /** Where the tab itself goes: its active toggle, else its default toggle. */
  to: string;
  active: boolean;
  /** Layout toggles under the tab (Plan: Schedule/Grid/Calendar; Deliver: Board/Sprints/Backlog). One entry means no toggle UI. */
  toggles: ContextToggle[];
}

export interface ContextTabsModel {
  tabs: ContextTab[];
  /** Everything that is not one of the five — rendered behind "More". */
  more: ContextToggle[];
}

export interface ContextTabsInput {
  scope: 'project' | 'program';
  /** `/projects/ATL` or `/programs/PM` — the ref path without a view segment. */
  basePath: string;
  /** The active view segment, `overview` for a bare ref path. */
  activeView: string;
  /**
   * View keys this user may see on this context — the caller folds methodology,
   * surface visibility, `hidden_views` and role gates into it. Labels for views
   * come from the caller too so the iteration noun ("Sprints" / "Iterations")
   * stays the one the workspace configured.
   */
  visibleViews: ReadonlyArray<string>;
  /**
   * Views the PERSON hid (`user.hidden_views`). Kept separate from `visibleViews`
   * because the Schedule override below must win over the methodology filter
   * but never over an explicit personal choice.
   */
  userHiddenViews: ReadonlyArray<string>;
  labelFor: (view: string) => string;
}

/**
 * Group order inside a tab is the order the toggles render in, and the first
 * VISIBLE entry is the tab's default destination — so methodology sets the
 * default only by deciding which toggles exist (a Waterfall project has no
 * Sprints, so Deliver lands on Board; every project has Schedule, so Plan lands
 * there). It never moves a view between tabs, which is what makes spatial
 * memory survive a switch from a Waterfall project to an Agile one.
 */
const PROJECT_GROUPS: Record<ContextTabKey, string[]> = {
  overview: ['overview'],
  plan: ['schedule', 'grid', 'calendar'],
  deliver: ['board', 'sprints', 'product-backlog'],
  risks: ['risk'],
  people: ['resources'],
};
const PROJECT_MORE = ['today', 'reports', 'activity', 'assets', 'settings'];

const PROGRAM_GROUPS: Record<ContextTabKey, string[]> = {
  overview: ['overview'],
  plan: ['schedule'],
  deliver: ['backlog'],
  risks: [],
  people: ['resources'],
};
const PROGRAM_MORE = ['projects', 'labels', 'agents', 'members', 'assets', 'settings'];

const TAB_LABEL: Record<ContextTabKey, string> = {
  overview: 'Overview',
  plan: 'Plan',
  deliver: 'Deliver',
  risks: 'Risks',
  people: 'People',
};

/**
 * Every project gets Plan, and Plan always offers Schedule: the engine is the
 * product, and an Agile project hiding its own schedule was the single largest
 * IA finding of the Pass 1 audit. A user's explicit `hidden_views` choice is
 * still honored by the caller's `visibleViews`; this only overrides the
 * methodology filter that removed `schedule` wholesale from Agile projects.
 */
const ALWAYS_VISIBLE_PROJECT_VIEWS = new Set(['schedule']);

export function resolveContextTabs(input: ContextTabsInput): ContextTabsModel {
  const groups = input.scope === 'project' ? PROJECT_GROUPS : PROGRAM_GROUPS;
  const moreKeys = input.scope === 'project' ? PROJECT_MORE : PROGRAM_MORE;
  const visible = new Set(input.visibleViews);
  const userHidden = new Set(input.userHiddenViews);
  const isVisible = (view: string) =>
    !userHidden.has(view) &&
    (visible.has(view) || (input.scope === 'project' && ALWAYS_VISIBLE_PROJECT_VIEWS.has(view)));
  const toggle = (view: string): ContextToggle => ({
    view,
    label: input.labelFor(view),
    to: `${input.basePath}/${view}`,
    active: input.activeView === view,
  });

  const tabs: ContextTab[] = [];
  for (const key of Object.keys(groups) as ContextTabKey[]) {
    const toggles = groups[key].filter(isVisible).map(toggle);
    if (toggles.length === 0) continue;
    const activeToggle = toggles.find((t) => t.active);
    tabs.push({
      key,
      label: TAB_LABEL[key],
      to: (activeToggle ?? toggles[0]).to,
      active: activeToggle !== undefined,
      toggles,
    });
  }
  const more = moreKeys.filter(isVisible).map(toggle);
  return { tabs, more };
}
