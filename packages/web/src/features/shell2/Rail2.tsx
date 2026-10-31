import { useLocation, Link } from 'react-router';
import { useShellStore } from '@/stores/shellStore';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { usePinned } from '@/hooks/usePins';
import { useProjectId } from '@/hooks/useProjectId';
import { useProgramId } from '@/hooks/useProgramId';
import { useProject } from '@/hooks/useProject';
import { programPath, projectPath } from '@/lib/refPath';
import { ArrowLeftIcon, ArrowRightIcon, LogoMark } from '@/components/Icons';
import { UserMenu } from '@/features/shell/UserMenu';
import { resolveRailItems, type RailItem } from './railItems';
import { WorkFlyout } from './WorkFlyout';

/** Personal pins shown under the five destinations; the design caps it at seven. */
const MAX_PINS = 7;

/**
 * The item row recipe. 44px tall (rule 5) rather than the design's 32: the floor
 * is a floor. Labels stay in the DOM as `sr-only` when the rail is collapsed so
 * the accessible name never changes with width (rule 330(d)).
 */
const ROW =
  'group relative flex h-11 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium text-p1-text-2 no-underline ' +
  'hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-0 aria-[current=page]:bg-p1-brand-tint aria-[current=page]:text-p1-text-1';

/**
 * A plain `Link`, not `NavLink`: NavLink overrides `aria-current` with its own
 * URL-prefix match, which would light Home on every `/me/work/…` sub-route and
 * Work on every project route. Active state is resolved once in
 * `resolveRailItems` so the rail, the phone bar and the tests agree.
 */
function RailRow({ item, collapsed }: { item: RailItem; collapsed: boolean }) {
  const { Icon } = item;
  return (
    <Link
      to={item.to}
      aria-current={item.active ? 'page' : undefined}
      className={`${ROW} ${collapsed ? 'justify-center px-0' : ''}`}
    >
      <Icon
        className={`h-4 w-4 shrink-0 ${item.active ? 'text-p1-brand' : ''}`}
        aria-hidden="true"
      />
      <span className={collapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
      {item.badge !== undefined && (
        <span
          className={[
            'rounded-full bg-p1-surface-3 font-mono text-xs leading-4 text-p1-text-1 tabular-nums',
            collapsed
              ? 'absolute right-1 top-1 min-w-[16px] px-1 text-center'
              : 'ml-auto min-w-[20px] px-1.5 text-center',
          ].join(' ')}
        >
          <span className="sr-only">{item.label === 'Inbox' ? 'unread' : 'pending'}: </span>
          {item.badge}
        </span>
      )}
    </Link>
  );
}

export interface Rail2Props {
  /** Collapsed to the 64px icon rail — the caller folds viewport width and the user's choice. */
  collapsed: boolean;
}

/**
 * The five-item global rail: Home · Inbox · Work · People · Agents, then the
 * person's pins, then the only identity in the app. It answers "where am I";
 * the context header's tab row answers "how am I looking at it". No health
 * dots, no view list, no gear — those were the four jobs that grew the v1
 * sidebar to 2,000 lines.
 */
export function Rail2({ collapsed }: Rail2Props) {
  const { pathname } = useLocation();
  const { user } = useCurrentUser();
  const { count: inboxCount } = useUnreadNotificationCount();
  const { data: pins } = usePinned();
  const projectId = useProjectId();
  const programId = useProgramId();
  const { data: project } = useProject(projectId);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);

  const programIdInContext = programId ?? project?.program_detail?.id ?? null;
  const items = resolveRailItems({
    pathname,
    landingPath: user?.landing?.path,
    programAgentsPath: programIdInContext
      ? programPath({ id: programIdInContext }, 'agents')
      : null,
    inboxCount,
    agentsCount: 0,
  });

  const visiblePins = (pins ?? []).slice(0, MAX_PINS);

  return (
    <aside
      aria-label="Primary navigation"
      data-collapsed={collapsed ? 'true' : 'false'}
      className={`flex h-full shrink-0 flex-col gap-0.5 bg-p1-surface-0 p-2 text-p1-text-1 ${collapsed ? 'w-16' : 'w-[248px]'}`}
    >
      <div
        className={`mb-2 flex h-11 items-center gap-2.5 px-2 ${collapsed ? 'justify-center px-0' : ''}`}
      >
        <LogoMark className="h-7 w-7 shrink-0" aria-hidden="true" />
        <span className={collapsed ? 'sr-only' : 'truncate font-semibold'}>TruePPM</span>
        {!collapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Collapse navigation"
            className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-p1-text-3 hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-0"
          >
            <ArrowLeftIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <nav aria-label="Destinations" className="flex flex-col gap-0.5">
        {items.map((item) =>
          item.key === 'work' && collapsed ? (
            <WorkFlyout key={item.key} item={item} />
          ) : (
            <RailRow key={item.key} item={item} collapsed={collapsed} />
          ),
        )}
      </nav>

      {!collapsed && visiblePins.length > 0 && (
        <nav aria-label="Pinned" className="mt-3 flex flex-col gap-0.5">
          <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-p1-text-3">Pinned</div>
          {visiblePins.map((pin) => {
            const to =
              pin.kind === 'program'
                ? programPath({ id: pin.id, code: pin.code }, 'overview')
                : projectPath({ id: pin.id, code: pin.code }, 'overview');
            const active = pin.kind === 'project' ? pin.id === projectId : pin.id === programId;
            return (
              <Link
                key={`${pin.kind}:${pin.id}`}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={`${ROW} font-normal`}
              >
                <span
                  className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-p1-surface-3 text-xs font-semibold text-p1-text-2"
                  aria-hidden="true"
                >
                  {pin.name.charAt(0)}
                </span>
                <span className="truncate" title={pin.name}>
                  {pin.name}
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {collapsed && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label="Expand navigation"
          className="mt-3 flex h-11 w-11 items-center justify-center self-center rounded-md text-p1-text-3 hover:bg-p1-surface-2 hover:text-p1-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-p1-focus focus-visible:ring-offset-2 focus-visible:ring-offset-p1-surface-0"
        >
          <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <div
        className={`mt-auto flex h-11 items-center gap-2.5 px-1 ${collapsed ? 'justify-center px-0' : ''}`}
      >
        <UserMenu />
        {!collapsed && user && (
          <span className="flex min-w-0 flex-col leading-4" aria-hidden="true">
            <span className="truncate text-sm font-medium">{user.display_name}</span>
          </span>
        )}
      </div>
    </aside>
  );
}
