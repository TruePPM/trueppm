import { useState, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { useAuthStore } from '@/stores/authStore';
import { queryClient } from '@/lib/queryClient';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';

// ---------------------------------------------------------------------------
// Theme pill SVG icons — extracted from TopBar.tsx THEME_BUTTONS
// ---------------------------------------------------------------------------

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Theme pill — shared between desktop dropdown and mobile bottom sheet
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light mode', icon: <SunIcon /> },
  { value: 'auto', label: 'Auto (system) mode', icon: <MonitorIcon /> },
  { value: 'dark', label: 'Dark mode', icon: <MoonIcon /> },
];

interface ThemePillProps {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
}

function ThemePill({ theme, onSetTheme }: ThemePillProps) {
  return (
    <div
      role="group"
      aria-label="Color scheme"
      className="flex items-center border border-neutral-border rounded"
    >
      {THEME_OPTIONS.map(({ value, label, icon }, i) => (
        <button
          key={value}
          type="button"
          onClick={() => onSetTheme(value)}
          aria-pressed={theme === value}
          aria-label={label}
          className={[
            'h-7 w-7 flex items-center justify-center text-xs',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
            i === 0 ? 'rounded-l' : '',
            i === THEME_OPTIONS.length - 1 ? 'rounded-r' : 'border-r border-neutral-border',
            theme === value
              ? 'bg-neutral-surface-sunken text-neutral-text-primary'
              : 'text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised',
          ].join(' ')}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu content — shared between desktop dropdown and mobile bottom sheet
// ---------------------------------------------------------------------------

interface MenuContentProps {
  /** Avatar pixel size for the header (28px in both variants per spec). */
  initials: string | undefined;
  displayName: string | undefined;
  email: string | undefined;
  theme: Theme;
  onSetTheme: (t: Theme) => void;
  onSignOut: () => void;
  onOpenShortcuts: () => void;
  onClose: () => void;
  /** true for mobile bottom sheet (52px row height); false for desktop (36px). */
  isMobile: boolean;
}

function MenuContent({
  initials,
  displayName,
  email,
  theme,
  onSetTheme,
  onSignOut,
  onOpenShortcuts,
  onClose,
  isMobile,
}: MenuContentProps) {
  const rowBase = isMobile
    ? 'flex items-center px-4 min-h-[52px]'
    : 'flex items-center px-4 min-h-[36px]';

  const rowInteractive = [
    rowBase,
    'hover:bg-chrome-surface-raised',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
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
        <ThemePill theme={theme} onSetTheme={onSetTheme} />
      </div>

      {/* Notifications row */}
      <a
        href="/settings/notifications"
        role="menuitem"
        onClick={onClose}
        className={`${rowInteractive} text-sm text-neutral-text-primary no-underline`}
      >
        Notifications
      </a>

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
        className="animate-pulse bg-brand-primary/30 rounded-full w-8 h-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary"
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-primary',
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
  const navigate = useNavigate();

  const { user, isLoading } = useCurrentUser();
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const clearTokens = useAuthStore((s) => s.clearTokens);

  function close() {
    setIsOpen(false);
  }

  function toggle() {
    setIsOpen((prev) => !prev);
  }

  function handleSignOut() {
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

  // Close when clicking outside (desktop only — backdrop handles mobile)
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        close();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isOpen]);

  const sharedContentProps = {
    initials: user?.initials,
    displayName: user?.display_name,
    email: user?.email,
    theme,
    onSetTheme: setTheme,
    onSignOut: handleSignOut,
    onOpenShortcuts: () => setShowShortcuts(true),
    onClose: close,
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
            className="absolute top-full right-0 mt-1 z-50 w-60 bg-chrome-surface rounded-lg border border-neutral-border flex flex-col py-1"
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
            <div
              className="fixed inset-0 z-40"
              aria-hidden="true"
              onClick={close}
            />
            {/* Bottom sheet */}
            <div
              role="menu"
              aria-label="User menu"
              className="fixed bottom-0 inset-x-0 z-50 bg-chrome-surface rounded-t-2xl border-t border-neutral-border flex flex-col py-2"
            >
              <MenuContent {...sharedContentProps} isMobile={true} />
            </div>
          </>
        )}
      </div>

      {/* Keyboard shortcuts modal — rendered outside the menu so it survives close() */}
      {showShortcuts && (
        <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
      )}
    </>
  );
}
