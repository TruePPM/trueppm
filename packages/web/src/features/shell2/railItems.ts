import type { ComponentType } from 'react';
import {
  InboxIcon,
  OverviewIcon,
  FolderIcon,
  ResourcesIcon,
  AgentIcon,
  type IconProps,
} from '@/components/Icons';
import { PEOPLE_PATH } from '@/features/people/peoplePath';
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
  /** The Home destination. Shell v2 passes `/home`, which renders the server-resolved role home. */
  landingPath: string | undefined;
  inboxCount: number;
  agentsCount: number;
}

const INBOX_PATH = '/me/notifications';
const HOME_FALLBACK_PATH = '/me/work';
/** The workspace Agents page (#4757): agents across the programs the person can see. */
export const AGENTS_PATH = '/agents';
const PROGRAM_AGENTS_RE = /^\/programs\/[^/]+\/agents\/?$/;

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * The five global destinations — "where am I" — in rail order. Active state is
 * resolved from the pathname alone so the rail, the phone bar and the flyout
 * agree without sharing React state.
 *
 * Work is active on any program or project route: the context header's tabs
 * answer "how am I looking at it", the rail only says the person is inside the
 * work tree. People is active on the capacity view (`/people`) and the org catalog
 * route it holds as its Directory; a project's own Team tab is a lens of that
 * project, not the People destination.
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
        !PROGRAM_AGENTS_RE.test(pathname),
      Icon: FolderIcon,
    },
    {
      key: 'people',
      label: 'People',
      to: PEOPLE_PATH,
      // The roster keeps its own route (⌘K's people tier deep-links `/resources?q=`),
      // and it is the People destination's Directory, so People stays active there.
      active: under(pathname, PEOPLE_PATH) || under(pathname, '/resources'),
      Icon: ResourcesIcon,
    },
    // Always present (#4757): the workspace page lists agents across every program
    // the person can see, and a program's own agents page still lights this item.
    {
      key: 'agents',
      label: 'Agents',
      to: AGENTS_PATH,
      active: under(pathname, AGENTS_PATH) || PROGRAM_AGENTS_RE.test(pathname),
      badge: input.agentsCount > 0 ? input.agentsCount : undefined,
      Icon: AgentIcon,
    },
  ];
  return items;
}
