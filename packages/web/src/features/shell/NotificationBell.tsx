/**
 * NotificationBell — TopBar bell with unread badge (#311 frontend phase 3).
 *
 * Desktop: opens a right-anchored slide-out NotificationPanel.
 * Mobile (<md): navigates to /me/notifications full-screen route.
 *
 * Bell visible at all widths so users on mobile still know they have unread
 * mentions before they tap through. Badge count comes from
 * useUnreadNotificationCount (30 s poll, pauses when tab hidden).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useUnreadNotificationCount } from '@/hooks/useNotifications';
import { NotificationPanel } from './NotificationPanel';

const MAX_DISPLAY = 99;

export function NotificationBell() {
  const navigate = useNavigate();
  const { count } = useUnreadNotificationCount();
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
  const displayCount = count > MAX_DISPLAY ? `${MAX_DISPLAY}+` : String(count);
  const ariaLabel = hasUnread ? `Notifications, ${count} unread` : 'Notifications';

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={handleClick}
        aria-label={ariaLabel}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        className={`relative inline-flex items-center justify-center w-9 h-9 rounded-full
          ${hasUnread ? 'text-brand-primary' : 'text-neutral-text-secondary'}
          hover:bg-neutral-surface-raised
          focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none`}
      >
        <span aria-hidden="true" className="text-base leading-none">
          {hasUnread ? '🔔' : '🔕'}
        </span>
        {hasUnread && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1
              flex items-center justify-center
              text-[10px] font-semibold tppm-mono rounded-full
              bg-brand-primary text-white"
          >
            {displayCount}
          </span>
        )}
      </button>
      {panelOpen && <NotificationPanel onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
