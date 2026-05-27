import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useSettingsSaveStore } from './hooks/useSettingsSaveStore';
import { ConfirmDiscardDialog } from './components/ConfirmDiscardDialog';
import { formatRelative } from '../../lib/formatRelative';

export interface SettingsNavItem {
  id: string;
  label: string;
  to: string;
  icon: ReactNode;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export interface SettingsScopeLink {
  scope: 'workspace' | 'project' | 'program';
  label: string;
  to: string;
}

interface SettingsShellProps {
  /** Which scope tab is active in the switcher */
  scope: 'workspace' | 'project' | 'program';
  /** Scope switcher destinations */
  scopeLinks: SettingsScopeLink[];
  /** Name shown in the context selector (workspace/program/project name) */
  contextName: string;
  /** Health dot for project/program context — omit for workspace */
  contextHealth?: 'onTrack' | 'atRisk' | 'critical' | null;
  /** Nav groups for the left rail */
  navGroups: SettingsNavGroup[];
}

const HEALTH_COLOR: Record<string, string> = {
  onTrack: 'bg-semantic-on-track',
  atRisk: 'bg-semantic-at-risk',
  critical: 'bg-semantic-critical',
};

/**
 * Shared settings layout: left rail + nav + save bar.
 *
 * Renders `<Outlet/>` for page content. Reads dirty / save state from
 * `useSettingsSaveStore`, which the active page populates via `useDirtyForm`.
 * Owns the navigation guard: `beforeunload` for browser-level navigation
 * and an `onClick` interceptor on each `NavLink` / scope button for
 * in-app navigation. Both routes through `ConfirmDiscardDialog`.
 */
export function SettingsShell({
  scope,
  scopeLinks,
  contextName,
  contextHealth,
  navGroups,
}: SettingsShellProps) {
  const navigate = useNavigate();

  const dirty = useSettingsSaveStore((s) => s.dirty);
  const isSaving = useSettingsSaveStore((s) => s.isSaving);
  const saveError = useSettingsSaveStore((s) => s.saveError);
  const lastSavedAt = useSettingsSaveStore((s) => s.lastSavedAt);
  const triggerSave = useSettingsSaveStore((s) => s.triggerSave);
  const triggerDiscard = useSettingsSaveStore((s) => s.triggerDiscard);

  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  // Ticker drives the "Saved [time]" footer re-render so "just now" → "1m ago"
  // without requiring the user to interact. 30s is short enough that the
  // first transition feels live and long enough not to thrash other listeners.
  const [, setSavedTick] = useState(0);
  useEffect(() => {
    if (lastSavedAt == null) return;
    const id = window.setInterval(() => setSavedTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  // Cleared on unmount so a navigation away mid-confirm doesn't leave the
  // setTimeout dangling.
  const copyTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimerRef.current != null) {
      window.clearTimeout(copyTimerRef.current);
    }
  }, []);

  const handleCopyLink = useCallback(() => {
    const url = window.location.href;
    // clipboard.writeText is async but the visual confirmation should fire
    // regardless — if the browser later rejects (insecure context, denied
    // permission) the badge would lie, but that's a rare enough case that
    // adding a failure UI here would cost more than it saves.
    void navigator.clipboard?.writeText(url);
    setCopyConfirmed(true);
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyConfirmed(false), 1500);
  }, []);

  // beforeunload — guards browser tab close / refresh / external nav while dirty.
  // Skipped during isSaving so the in-flight POST/PATCH isn't interrupted by
  // a confirm prompt the user can't act on.
  useEffect(() => {
    if (!dirty || isSaving) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Modern browsers ignore the message but still show their native dialog
      // when preventDefault is called and returnValue is set.
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, isSaving]);

  // Ctrl/Cmd+S — save while dirty. ADR-0052 precedent (task modal).
  useEffect(() => {
    if (!dirty) return;
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void triggerSave();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, triggerSave]);

  // Intercept an in-app navigation: stash the target, open the confirm dialog.
  // Returns true when nav should be blocked (caller calls preventDefault).
  const guardedNavigate = useCallback(
    (to: string): boolean => {
      if (!dirty || isSaving) return false;
      setPendingNav(to);
      return true;
    },
    [dirty, isSaving],
  );

  const handleKeepEditing = useCallback(() => {
    setPendingNav(null);
  }, []);

  const handleDiscardAndGo = useCallback(() => {
    const target = pendingNav;
    setPendingNav(null);
    // Reset page state synchronously so the user doesn't briefly see the
    // dirty values flash before navigating.
    triggerDiscard();
    if (target) {
      void navigate(target);
    }
  }, [pendingNav, navigate, triggerDiscard]);

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left rail ── */}
      <aside
        className="w-60 shrink-0 flex flex-col bg-neutral-surface-raised border-r border-neutral-border overflow-hidden"
        aria-label="Settings navigation"
      >
        {/* Scope switcher */}
        <div className="px-3.5 pt-3 pb-2 shrink-0">
          <p className="text-xs font-semibold tracking-[.1em] uppercase text-neutral-text-secondary mb-1.5">
            Scope
          </p>
          <div className="grid grid-cols-3 bg-neutral-surface-sunken rounded p-0.5 gap-0">
            {scopeLinks.map((sl) => (
              <button
                key={sl.scope}
                type="button"
                onClick={() => {
                  if (guardedNavigate(sl.to)) return;
                  void navigate(sl.to);
                }}
                className={[
                  'py-1.5 px-1 rounded text-xs font-medium text-center transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  scope === sl.scope
                    ? 'bg-neutral-surface text-neutral-text-primary'
                    : 'text-neutral-text-secondary hover:text-neutral-text-primary',
                ].join(' ')}
              >
                {sl.label}
              </button>
            ))}
          </div>

          {/* Context selector */}
          <div className="mt-2 px-2 py-1.5 rounded flex items-center gap-1.5 bg-neutral-surface-sunken border border-neutral-border/55 text-xs min-w-0">
            {contextHealth ? (
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${HEALTH_COLOR[contextHealth] ?? 'bg-neutral-text-disabled'}`}
                aria-hidden="true"
              />
            ) : (
              <span
                className="w-3.5 h-3.5 rounded bg-brand-primary shrink-0 inline-flex items-center justify-center text-white text-[10px] font-bold"
                aria-hidden="true"
              >
                tP
              </span>
            )}
            <span className="flex-1 truncate text-neutral-text-primary font-medium">{contextName}</span>
            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Copy link to settings"
              className="shrink-0 inline-flex items-center justify-center w-6 h-6 -my-1 rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {copyConfirmed ? (
                <svg width="12" height="12" viewBox="0 0 16 16" className="text-semantic-on-track" aria-hidden="true">
                  <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M7 4H4.5A1.5 1.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13H10a1.5 1.5 0 0 0 1.5-1.5V9 M9 12h2.5A1.5 1.5 0 0 0 13 10.5v-6A1.5 1.5 0 0 0 11.5 3H6a1.5 1.5 0 0 0-1.5 1.5V7"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              )}
            </button>
            {copyConfirmed && (
              <span className="sr-only" role="status" aria-live="polite">
                Link copied to clipboard
              </span>
            )}
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="shrink-0 text-neutral-text-disabled"
              aria-hidden="true"
            >
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto px-2 py-1" aria-label="Settings sections">
          {navGroups.map((group) => (
            <div key={group.label} className="mb-2">
              <h2 className="px-2 py-1.5 text-xs font-semibold tracking-[.08em] uppercase text-neutral-text-secondary">
                {group.label}
              </h2>
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  to={item.to}
                  end
                  onClick={(e) => {
                    if (guardedNavigate(item.to)) {
                      e.preventDefault();
                    }
                  }}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-2 px-2.5 py-[7px] rounded text-[13px] transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                      isActive
                        ? 'font-semibold text-neutral-text-primary bg-neutral-surface-sunken -ml-0.5 pl-[9px] border-l-2 border-brand-primary'
                        : 'text-neutral-text-secondary hover:text-neutral-text-primary',
                    ].join(' ')
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                        aria-hidden="true"
                      >
                        {item.icon}
                      </span>
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Right content area ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Page content */}
        <div className="flex-1 overflow-y-auto bg-neutral-surface">
          <Outlet />
        </div>

        {/* Saved [time] footer — visible when not dirty and a save landed this page mount.
            Hidden while dirty because the save bar takes the same slot. */}
        {!dirty && lastSavedAt != null && (
          <div
            className="shrink-0 flex items-center justify-end gap-2 px-6 py-2 bg-neutral-surface-raised border-t border-neutral-border/55"
            data-testid="settings-saved-footer"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" className="text-semantic-on-track shrink-0" aria-hidden="true">
              <path d="M3 8l3.5 3.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span className="text-[12px] text-neutral-text-secondary">
              Saved{' '}
              <span className="tppm-mono">{formatRelative(new Date(lastSavedAt))}</span>
            </span>
          </div>
        )}

        {/* Save bar — armed when an apiReady page reports dirty=true. */}
        {dirty && (
          <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 bg-brand-primary border-t border-brand-primary-dark">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="text-white/80 shrink-0"
              aria-hidden="true"
            >
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </svg>
            <span className="text-[13px] font-medium text-white" role="status">
              {saveError ?? 'You have unsaved changes'}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={triggerDiscard}
              disabled={isSaving}
              className="text-[13px] text-white/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void triggerSave()}
              disabled={isSaving}
              aria-keyshortcuts="Meta+S Control+S"
              className="px-3.5 py-1.5 rounded bg-white text-brand-primary-dark text-[13px] font-semibold hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
            >
              {isSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </div>

      {pendingNav !== null && (
        <ConfirmDiscardDialog
          onKeepEditing={handleKeepEditing}
          onDiscard={handleDiscardAndGo}
        />
      )}
    </div>
  );
}

/* ── Shared page-level primitives used by all settings pages ── */

interface SettingsPageTitleProps {
  title: string;
  subtitle?: string;
  count?: string | number;
  action?: ReactNode;
}

/** Standardised page title strip with optional count and action button. */
export function SettingsPageTitle({ title, subtitle, count, action }: SettingsPageTitleProps) {
  return (
    <div className="px-6 pt-5 pb-3.5 flex items-end gap-3.5 border-b border-neutral-border/55">
      <div className="flex-1 min-w-0">
        <h1 className="text-[22px] font-bold tracking-tight text-neutral-text-primary leading-none flex items-center gap-2.5">
          {title}
          {count != null && (
            <span className="text-[13px] font-medium text-neutral-text-secondary">{count}</span>
          )}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[13px] text-neutral-text-secondary">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface FieldRowProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

/** Two-column form row: 240px label+hint on left, content on right. */
export function FieldRow({ label, hint, children }: FieldRowProps) {
  return (
    <div className="grid gap-6 py-3.5 border-b border-neutral-border/55 items-start" style={{ gridTemplateColumns: '240px 1fr' }}>
      <div>
        <div className="text-[13px] font-medium text-neutral-text-primary">{label}</div>
        {hint && (
          <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">{hint}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

interface SettingsCardProps {
  children: ReactNode;
  className?: string;
}

/** Raised card used in settings pages. */
export function SettingsCard({ children, className = '' }: SettingsCardProps) {
  return (
    <div className={`bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden ${className}`}>
      {children}
    </div>
  );
}
