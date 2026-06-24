import { type ReactNode } from 'react';

import { useThemeStore, type Theme } from '@/stores/themeStore';

/**
 * Segmented Light / Auto / Dark control (ADR-0126 theming, ADR-0127 context bar).
 *
 * Self-contained: reads and writes `themeStore` directly so it can be dropped into
 * the context bar, the user menu, or settings without prop threading. The `.dark`
 * class is applied by `useThemeInit` at the app root — this only sets the pref.
 */

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

const THEME_OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light mode', icon: <SunIcon /> },
  { value: 'auto', label: 'Auto (system) mode', icon: <MonitorIcon /> },
  { value: 'dark', label: 'Dark mode', icon: <MoonIcon /> },
];

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div
      role="group"
      aria-label="Color scheme"
      className={['flex items-center border border-neutral-border rounded-control', className ?? ''].join(' ')}
    >
      {THEME_OPTIONS.map(({ value, label, icon }, i) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-pressed={theme === value}
          aria-label={label}
          className={[
            'h-7 w-7 flex items-center justify-center text-xs',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
            i === 0 ? 'rounded-l-control' : '',
            i === THEME_OPTIONS.length - 1 ? 'rounded-r-control' : 'border-r border-neutral-border',
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
