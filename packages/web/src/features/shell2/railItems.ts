import type { ComponentType } from 'react';
import {
  InboxIcon,
  OverviewIcon,
  FolderIcon,
  ResourcesIcon,
  AgentIcon,
  type IconProps,
} from '@/components/Icons';
import { WORK_PATH } from './workModel';

export type RailItemKey = 'home' | 'inbox' | 'work' | 'people' | 'agents';

export interface RailItem {
  key: RailItemKey;
  label: string;
  to: string;
  active: boolean;
  /** Unread/attention count, omitted when zero. */
  badge?: number;
  Icon: ComponentType<IconProps>;
}

export interface RailItemsInput {
  pathname: string;
  /** Server-resolved role home (`user.landing.path`); the rail never re-derives it. */
  landingPath: string | undefined;
  /**
   * The Agents surface for the program in context, or `null` when no program is
   * in context. Agent governance is program-scoped until the workspace-level
   * page lands, so the item is omitted rather than pointed at a page that
   * cannot answer "what did agents do?" for the person's own work.
   */
  programAgentsPath: string | null;
  inboxCount: number;
  agentsCount: number;
}

const INBOX_PATH = '/me/notifications';
const PEOPLE_PATH = '/resources';
const HOME_FALLBACK_PATH = '/me/work';

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * The five global destinations — "where am I" — in rail order. Active state is
 * resolved from the pathname alone so the rail, the phone bar and the flyout
 * agree without sharing React state.
 *
 * Work is active on any program or project route: the context header's tabs
 * answer "how am I looking at it", the rail only says the person is inside the
 * work tree. People stays scoped to the org catalog route; a project's own Team
 * tab is a lens of that project, not the People destination.
 */
export function resolveRailItems(input: RailItemsInput): RailItem[] {
  const { pathname } = input;
  const home =
    input.landingPath && input.landingPath !== '/' ? input.landingPath : HOME_FALLBACK_PATH;
  const homeActive =
    under(pathname, HOME_FALLBACK_PATH) ||
    (home !== HOME_FALLBACK_PATH &&
      under(pathname, home) &&
      !under(pathname, '/projects') &&
      !under(pathname, '/programs'));
  const items: RailItem[] = [
    { key: 'home', label: 'Home', to: home, active: homeActive, Icon: OverviewIcon },
    {
      key: 'inbox',
      label: 'Inbox',
      to: INBOX_PATH,
      active: under(pathname, INBOX_PATH),
      badge: input.inboxCount > 0 ? input.inboxCount : undefined,
      Icon: InboxIcon,
    },
    {
      key: 'work',
      label: 'Work',
      to: WORK_PATH,
      active:
        (under(pathname, '/projects') ||
          under(pathname, '/programs') ||
          under(pathname, WORK_PATH)) &&
        !(input.programAgentsPath !== null && pathname === input.programAgentsPath),
      Icon: FolderIcon,
    },
    {
      key: 'people',
      label: 'People',
      to: PEOPLE_PATH,
      active: under(pathname, PEOPLE_PATH),
      Icon: ResourcesIcon,
    },
  ];
  if (input.programAgentsPath !== null) {
    items.push({
      key: 'agents',
      label: 'Agents',
      to: input.programAgentsPath,
      active: pathname === input.programAgentsPath,
      badge: input.agentsCount > 0 ? input.agentsCount : undefined,
      Icon: AgentIcon,
    });
  }
  return items;
}
