import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { ClockIcon, SearchIcon } from '@/components/Icons';
import { Tooltip } from '@/components/Tooltip';
import { resolveRailItems } from './railItems';
import { QuickLogSheet } from './QuickLogSheet';

const TAB =
  'relative flex h-12 flex-col items-center justify-center gap-0.5 rounded-md text-xs text-p1-text-2 no-underline ' +
  'focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset aria-[current=page]:text-p1-text-1';

/**
 * The phone's global bar — ALWAYS present, on every route, which is the fix
 * for the v1 `BottomNav` returning null off a project and leaving My Work,
 * Programs and Notifications with no navigation at all. Home · Inbox · [Log] ·
 * Work · Search. In-context lenses live in the context header's scrollable
 * tab row, not here.
 *
 * `focus:` rather than `focus-visible:` on the tabs (rule 214).
 */
export function BottomBar2() {
  const { pathname } = useLocation();
  const { user } = useCurrentUser();
  const { count: inboxCount } = useUnreadNotificationCount();
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLButtonElement>(null);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  const items = resolveRailItems({
    pathname,
    landingPath: user?.landing?.path,
    programAgentsPath: null,
    inboxCount,
    agentsCount: 0,
  });
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const left = [byKey.home, byKey.inbox];
  const right = [byKey.work];

  const tab = (item: (typeof items)[number]) => {
    const { Icon } = item;
    return (
      <Link
        key={item.key}
        to={item.to}
        aria-current={item.active ? 'page' : undefined}
        className={TAB}
      >
        <Icon
          className={`h-[22px] w-[22px] ${item.active ? 'text-p1-brand' : ''}`}
          aria-hidden="true"
        />
        {item.label}
        {item.badge !== undefined && (
          <span className="absolute left-1/2 top-0.5 ml-1 min-w-[16px] rounded-full bg-p1-surface-3 px-1 font-mono text-xs leading-4 text-p1-text-1">
            <span className="sr-only">unread: </span>
            {item.badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="grid shrink-0 grid-cols-5 items-start border-t border-p1-hairline bg-p1-surface-1 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-1.5"
      >
        {left.map(tab)}
        {/* Opens the quick-log sheet; the full editor stays at /me/timesheet, linked from the sheet. */}
        <Tooltip content="Log time" describe={false}>
          <button
            ref={logRef}
            type="button"
            aria-label="Log time"
            aria-haspopup="dialog"
            aria-expanded={logOpen}
            onClick={() => setLogOpen(true)}
            className="flex h-12 items-center justify-center rounded-md focus:outline-none focus:ring-2 focus:ring-p1-focus focus:ring-inset"
          >
            <span
              className="-mt-1.5 flex h-12 w-12 items-center justify-center rounded-full bg-p1-brand text-p1-on-brand"
              aria-hidden="true"
            >
              <ClockIcon className="h-[22px] w-[22px]" />
            </span>
          </button>
        </Tooltip>
        {right.map(tab)}
        <button type="button" onClick={() => openPalette(true)} className={TAB}>
          <SearchIcon className="h-[22px] w-[22px]" aria-hidden="true" />
          Search
        </button>
      </nav>
      <QuickLogSheet
        isOpen={logOpen}
        onClose={() => {
          setLogOpen(false);
          // BottomSheet leaves close-side focus restoration to the caller (WCAG 2.4.3).
          requestAnimationFrame(() => logRef.current?.focus());
        }}
      />
    </>
  );
}
