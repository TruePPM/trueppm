/**
 * NotificationBell — TopBar bell with unread badge (#311 frontend phase 3).
 *
 * Desktop: opens a right-anchored slide-out NotificationPanel.
 * Mobile (<md): navigates to /me/notifications full-screen route.
 *
 * Bell visible at all widths so users on mobile still know they have unread
 * mentions before they tap through. Badge count comes from
 * useUnreadNotificationCount (30 s poll, pauses when tab hidden).
 *
 * The bell is ALWAYS the plain active BellIcon (#1707): unread is signalled by
 * the count badge + brand-primary accent, never by swapping to a slashed/muted
 * glyph. The former zero-unread muted-bell glyph read as "notifications turned
 * off" even though no mute state exists. A genuine mute would use a distinct
 * bell-off glyph driven by a real mute flag — never by `count === 0`.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { BellIcon, MoonIcon } from '@/components/Icons';
import { NotificationPanel } from './NotificationPanel';

const MAX_DISPLAY = 99;

export function NotificationBell() {
  const navigate = useNavigate();
  const { count } = useUnreadNotificationCount();
  const { user } = useCurrentUser();
  const [panelOpen, setPanelOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close panel on outside-click (desktop slide-out behavior — non-modal).
  useEffect(() => {
    if (!panelOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPanelOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanelOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [panelOpen]);

  function handleClick() {
    // < md: navigate to dedicated route; >= md: open slide-out.
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      void navigate('/me/notifications');
      return;
    }
    setPanelOpen((o) => !o);
  }

  const hasUnread = count > 0;
  const dnd = user?.dnd_enabled ?? false;
  const displayCount = count > MAX_DISPLAY ? `${MAX_DISPLAY}+` : String(count);
  // The unread count and the DND state are orthogonal — the label always states
  // that the in-app inbox stays active under DND (the "not disabled" promise for
  // AT users, since DND only pauses email/push).
  const unreadPart = hasUnread ? `, ${count} unread` : '';
  const dndPart = dnd
    ? '. Do Not Disturb on — email and push paused, in-app inbox still active'
    : '';
  const ariaLabel = `Notifications${unreadPart}${dndPart}`;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        aria-label={ariaLabel}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        className={`relative inline-flex items-center justify-center w-11 h-11 rounded-full
          ${hasUnread ? 'text-brand-primary' : 'text-neutral-text-secondary'}
          hover:bg-neutral-surface-raised
          focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none`}
      >
        <BellIcon aria-hidden="true" className="w-5 h-5" />
        {hasUnread && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1
              flex items-center justify-center
              text-xs font-semibold tppm-mono rounded-full
              bg-brand-primary text-white"
          >
            {displayCount}
          </span>
        )}
        {/* DND indicator — a calm ink crescent chip on the opposite (bottom-right)
            corner from the count badge, so both read together. Driven by the real
            dnd_enabled fact (web-rule 240); aria-hidden — the meaning is in the
            button's aria-label. */}
        {dnd && (
          <span
            aria-hidden="true"
            className="absolute bottom-0.5 right-0.5 w-3.5 h-3.5 rounded-full
              flex items-center justify-center
              bg-neutral-text-primary text-neutral-surface ring-2 ring-chrome-surface"
          >
            <MoonIcon className="w-2.5 h-2.5" />
          </span>
        )}
      </button>
      {panelOpen && <NotificationPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
