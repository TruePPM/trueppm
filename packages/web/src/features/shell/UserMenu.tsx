import { useState, useEffect, useRef, type RefObject } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuthStore } from '@/stores/authStore';
import { apiClient } from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useProjectId } from '@/hooks/useProjectId';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { ThemeToggle } from '@/components/ThemeToggle';
import { RoleContextMenuRow } from '@/features/shell/RoleContextMenuRow';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

// ---------------------------------------------------------------------------
// Menu content — shared between desktop dropdown and mobile bottom sheet
// ---------------------------------------------------------------------------

interface MenuContentProps {
  /** Avatar pixel size for the header (28px in both variants per spec). */
  initials: string | undefined;
  displayName: string | undefined;
  email: string | undefined;
  onSignOut: () => void;
  onOpenShortcuts: () => void;
  onClose: () => void;
  /** true for mobile bottom sheet (52px row height); false for desktop (36px). */
  isMobile: boolean;
  /** When set, renders a "Project settings" link in the menu. */
  projectId: string | undefined;
}

function MenuContent({
  initials,
  displayName,
  email,
  onSignOut,
  onOpenShortcuts,
  onClose,
  isMobile,
  projectId,
}: MenuContentProps) {
  const rowBase = isMobile
    ? 'flex items-center px-4 min-h-[52px]'
    : 'flex items-center px-4 min-h-[36px]';

  const rowInteractive = [
    rowBase,
    'hover:bg-chrome-surface-raised',
    'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface',
  ].join(' ');

  return (
    <>
      {/* Header: avatar + display name + email */}
      <div className={`${rowBase} gap-3`}>
        <span
          className="flex-shrink-0 w-7 h-7 rounded-full bg-brand-primary text-white text-xs font-semibold flex items-center justify-center"
          aria-hidden="true"
        >
          {initials ?? '?'}
        </span>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-semibold text-neutral-text-primary truncate leading-tight">
            {displayName ?? ''}
          </span>
          <span className="tppm-mono text-xs text-neutral-text-secondary truncate leading-tight">
            {email ?? ''}
          </span>
        </div>
      </div>

      {/* Theme row */}
      <div className={`${rowBase} justify-between`}>
        <span className="text-sm text-neutral-text-primary">Theme</span>
        <ThemeToggle />
      </div>

      {/* View focus — role-context lens switcher (issue 1263, ADR-0162). Presentation
          only; never changes access. Same plain-row pattern as Theme. */}
      <RoleContextMenuRow isMobile={isMobile} />

      {/* My Work — cross-project contributor surface (#499, ADR-0065 Gap 2).
          Placed above project-scoped items so it's reachable without a project. */}
      <NavLink
        to="/me/work"
        role="menuitem"
        onClick={onClose}
        className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
      >
        My Work
      </NavLink>

      {/* Project settings — only shown when a project is in context */}
      {projectId && (
        <NavLink
          to={`/projects/${projectId}/settings/members`}
          role="menuitem"
          onClick={onClose}
          className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
        >
          Project settings
        </NavLink>
      )}

      {/* General preferences — default landing screen (ADR-0129).
          Placed directly above Notifications. */}
      <NavLink
        to="/me/settings/general"
        role="menuitem"
        onClick={onClose}
        className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
      >
        General
      </NavLink>

      {/* Notifications row */}
      <NavLink
        to="/me/settings/notifications"
        role="menuitem"
        onClick={onClose}
        className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
      >
        Notifications
      </NavLink>

      {/* Personal access tokens row (issue 648) */}
      <NavLink
        to="/me/settings/api-tokens"
        role="menuitem"
        onClick={onClose}
        className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
      >
        Personal access tokens
      </NavLink>

      {/* Keyboard shortcuts row */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onOpenShortcuts();
        }}
        className={`${rowInteractive} w-full text-left text-sm text-neutral-text-primary`}
      >
        Keyboard shortcuts
      </button>

      {/* Divider */}
      <div className="mx-4 border-t border-neutral-border" aria-hidden="true" />

      {/* Sign out row */}
      <button
        type="button"
        role="menuitem"
        onClick={onSignOut}
        className={[
          rowInteractive,
          'w-full text-left text-sm text-neutral-text-primary',
          'hover:text-semantic-critical hover:bg-semantic-critical/5',
        ].join(' ')}
      >
        Sign out
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Avatar chip — the trigger button
// ---------------------------------------------------------------------------

interface AvatarChipProps {
  initials: string | undefined;
  isLoading: boolean;
  isOpen: boolean;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

function AvatarChip({ initials, isLoading, isOpen, onClick, buttonRef }: AvatarChipProps) {
  if (isLoading) {
    return (
      <button
        ref={buttonRef}
        type="button"
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onClick}
        className="motion-safe:animate-pulse bg-brand-primary/30 rounded-full w-8 h-8 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-brand-primary"
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="User menu"
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onClick={onClick}
      className={[
        'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold',
        'focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-brand-primary',
        initials
          ? 'bg-brand-primary text-white'
          : 'bg-neutral-surface-raised text-neutral-text-disabled',
      ].join(' ')}
    >
      {initials ?? '?'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// UserMenu — top-level exported component
// ---------------------------------------------------------------------------

export function UserMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Mobile bottom sheet is a modal dialog (role="dialog" aria-modal="true"): trap
  // Tab/Shift+Tab inside it and land focus on its first control on open so a
  // keyboard user can't tab out into the obscured app behind it (WCAG 2.4.3 /
  // 2.1.2). Escape is handled by the existing document listener below, which also
  // restores focus to the trigger, so no onEscape is passed here. The desktop
  // dropdown is a non-modal role="menu" and is intentionally not trapped.
  const sheetRef = useFocusTrap<HTMLDivElement>(isOpen);
  const navigate = useNavigate();

  const { user, isLoading } = useCurrentUser();
  const projectId = useProjectId();
  const clearTokens = useAuthStore((s) => s.clearTokens);

  function close() {
    setIsOpen(false);
  }

  function toggle() {
    setIsOpen((prev) => !prev);
  }

  function handleSignOut() {
    // Best-effort server logout: clears the httpOnly refresh cookie and
    // blacklists the token (when the blacklist app is installed) so it can't be
    // replayed (#897). Local state is cleared regardless of the network result —
    // the user must end up signed out even if the request fails offline.
    void apiClient.post('/auth/logout/').catch(() => {
      /* offline / already-expired — local clear below is authoritative for the UI */
    });
    clearTokens();
    queryClient.clear();
    void navigate('/login');
  }

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close();
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  // Close when clicking outside. This handler is registered at every width, so
  // it must recognize BOTH menu surfaces as "inside": the desktop dropdown
  // (menuRef) and the mobile bottom sheet (sheetRef). Without the sheetRef
  // check, a pointerdown on a control inside the sheet (e.g. the theme toggle)
  // is misclassified as an outside click, closes the sheet on pointerdown, and
  // the control's click never fires — the mobile theme switcher did nothing
  // while the identical desktop dropdown worked (#1679). The mobile backdrop
  // still closes on its own onClick; this guard only prevents the false close.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      const insideDropdown = menuRef.current?.contains(target) ?? false;
      const insideSheet = sheetRef.current?.contains(target) ?? false;
      const onTrigger = buttonRef.current?.contains(target) ?? false;
      if (!insideDropdown && !insideSheet && !onTrigger) {
        close();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // sheetRef is a stable ref from useFocusTrap; listed to satisfy exhaustive-deps.
  }, [isOpen, sheetRef]);

  const sharedContentProps = {
    initials: user?.initials,
    displayName: user?.display_name,
    email: user?.email,
    onSignOut: handleSignOut,
    onOpenShortcuts: () => setShowShortcuts(true),
    onClose: close,
    projectId,
  };

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Desktop: relative-positioned dropdown                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="hidden md:block relative" ref={menuRef}>
        <AvatarChip
          initials={user?.initials}
          isLoading={isLoading}
          isOpen={isOpen}
          onClick={toggle}
          buttonRef={buttonRef}
        />

        {isOpen && (
          <div
            role="menu"
            aria-label="User menu"
            className="absolute top-full right-0 mt-1 z-50 w-64 bg-chrome-surface rounded-card border border-neutral-border flex flex-col py-1"
          >
            <MenuContent {...sharedContentProps} isMobile={false} />
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Mobile: avatar chip + bottom sheet                                  */}
      {/* ------------------------------------------------------------------ */}
      <div className="md:hidden">
        <AvatarChip
          initials={user?.initials}
          isLoading={isLoading}
          isOpen={isOpen}
          onClick={toggle}
          buttonRef={buttonRef}
        />

        {isOpen && (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={close} />
            {/* Bottom sheet — heterogeneous controls (theme toggle, links, buttons)
                require Tab navigation so role="dialog" is correct here, not role="menu". */}
            <div
              ref={sheetRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="User menu"
              className="fixed bottom-0 inset-x-0 z-50 bg-chrome-surface rounded-t-card border-t border-neutral-border flex flex-col py-2 focus:outline-none"
            >
              <MenuContent {...sharedContentProps} isMobile={true} />
            </div>
          </>
        )}
      </div>

      {/* Keyboard shortcuts modal — rendered outside the menu so it survives close() */}
      {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </>
  );
}
