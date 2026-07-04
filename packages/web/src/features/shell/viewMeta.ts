import type { ComponentType } from 'react';
import {
  GanttIcon,
  BoardIcon,
  ListIcon,
  CalendarIcon,
  ResourcesIcon,
  RiskIcon,
  SprintIcon,
  SettingsIcon,
  BarChartIcon,
  WbsIcon,
  OverviewIcon,
  TodayIcon,
  ActivityIcon,
} from '@/components/Icons';

export type ViewIconType = ComponentType<{ className?: string; 'aria-hidden'?: 'true' }>;

export interface ViewMeta {
  label: string;
  Icon: ViewIconType;
}

/**
 * View key → display label + icon. Render metadata only — grouping/order lives
 * in `methodologyTabs.ts` (`VIEW_GROUPS`). Shared by `ViewTabs` (the bar), the
 * `ViewsMenu` (customize-views, ADR-0139), and the ⌘K palette so the three never
 * drift. `grid` replaced the legacy WBS + Table entries (ADR-0053).
 *
 * The `sprints` label here is the static default; surfaces that have a project
 * in context override it with the configured iteration label (ADR-0111/0116).
 */
export const VIEW_TAB_META: Record<string, ViewMeta> = {
  overview: { label: 'Overview', Icon: OverviewIcon },
  // Unified Today split view (ADR-0180) — the `unified` role-context lens lands here.
  today: { label: 'Today', Icon: TodayIcon },
  'product-backlog': { label: 'Backlog', Icon: WbsIcon },
  sprints: { label: 'Sprints', Icon: SprintIcon },
  schedule: { label: 'Schedule', Icon: GanttIcon },
  grid: { label: 'Grid', Icon: ListIcon },
  calendar: { label: 'Calendar', Icon: CalendarIcon },
  board: { label: 'Board', Icon: BoardIcon },
  risk: { label: 'Risks', Icon: RiskIcon },
  reports: { label: 'Reports', Icon: BarChartIcon },
  // Unified project changelog — the "what changed" feed (ADR-0199).
  activity: { label: 'Activity', Icon: ActivityIcon },
  resources: { label: 'Team', Icon: ResourcesIcon },
  // Settings — visible to all members (Viewer+); write controls are OWNER-gated
  // inside the page.
  settings: { label: 'Settings', Icon: SettingsIcon },
};
