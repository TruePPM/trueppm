import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSettingsSaveStore } from './hooks/useSettingsSaveStore';
import { useScrollSpy } from './hooks/useScrollSpy';
import { ConfirmDiscardDialog } from './components/ConfirmDiscardDialog';
import { SettingsContextSwitcher, type SettingsContextOption } from './SettingsContextSwitcher';
import { SettingsSectionContext } from './SettingsSectionContext';
import { SettingsSectionErrorBoundary } from './SettingsSectionErrorBoundary';
import { formatRelative } from '../../lib/formatRelative';

export type { SettingsContextOption } from './SettingsContextSwitcher';

export interface SettingsNavItem {
  /** Stable id — also the section anchor (`…/settings#<id>`) for inline sections. */
  id: string;
  label: string;
  icon: ReactNode;
  /**
   * When set, the item is a route link (System Health tools, redirect shims):
   * clicking navigates (through the dirty guard) instead of scroll-spying to an
   * in-page section. Inline sections omit this.
   */
  to?: string;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export interface SettingsScopeLink {
  scope: 'workspace' | 'project' | 'program';
  label: string;
  /** Target settings route, or null when unavailable (still loading, or no such
      entity exists) — the segment renders disabled rather than navigating to a
      blank/irrelevant page (issue 776). */
  to: string | null;
  /** Tooltip shown on the disabled segment when `to` is null, e.g. "No programs yet". */
  disabledReason?: string;
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
  /** Sibling entities in the current scope; renders the context-switcher when >= 2 (issue 776). */
  contextOptions?: SettingsContextOption[];
  /** The current entity's id within `contextOptions` (gets the checkmark). */
  contextActiveId?: string;
  /** Nav groups for the left rail */
  navGroups: SettingsNavGroup[];
  /**
   * The consolidated page body — all `<SettingsSection>` regions for this entity,
   * rendered at once on one mounted page (ADR-0146). The shell stays mounted;
   * the left rail scroll-spies across these sections.
   */
  children: ReactNode;
}

const HEALTH_COLOR: Record<string, string> = {
  onTrack: 'bg-semantic-on-track',
  atRisk: 'bg-semantic-at-risk',
  critical: 'bg-semantic-critical',
};

/**
 * Shared settings layout: scroll-spy left rail + one scrolling page + save bar
 * (ADR-0146, issue 1248).
 *
 * The page body (`children`) renders every `<SettingsSection>` for the entity at
 * once on a single mounted page. The rail is a scroll-spy: clicking an inline
 * item smooth-scrolls to its anchor and updates the hash (no route change);
 * scrolling updates the active item. Items with a `to` are real route links
 * (System Health tools) and route through the dirty guard.
 *
 * Reads the aggregate dirty / save state from `useSettingsSaveStore`, which each
 * section's `useDirtyForm` populates. Owns the navigation guard: `beforeunload`
 * for browser-level navigation and an interceptor on each route link / scope
 * button for in-app navigation. Both route through `ConfirmDiscardDialog`.
 */
export function SettingsShell({
  scope,
  scopeLinks,
  contextName,
  contextHealth,
  contextOptions,
  contextActiveId,
  navGroups,
  children,
}: SettingsShellProps) {
  const navigate = useNavigate();
  const { hash } = useLocation();

  const dirty = useSettingsSaveStore((s) => s.dirty);
  const isSaving = useSettingsSaveStore((s) => s.isSaving);
  const saveError = useSettingsSaveStore((s) => s.saveError);
  const lastSavedAt = useSettingsSaveStore((s) => s.lastSavedAt);
  const triggerSave = useSettingsSaveStore((s) => s.triggerSave);
  const triggerDiscard = useSettingsSaveStore((s) => s.triggerDiscard);

  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [copyConfirmed, setCopyConfirmed] = useState(false);

  // Inline (scroll-spy) section ids in document order — the items WITHOUT a `to`.
  const inlineIds = navGroups.flatMap((g) => g.items.filter((i) => !i.to).map((i) => i.id));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { activeId, scrollTo } = useScrollSpy({ sectionIds: inlineIds, scrollRef });

  // Deep link: on first mount, if the URL carries `#<section>` scroll to it.
  // Runs once per hash change so an in-app hash update from a nav click (which
  // already scrolled) doesn't double-scroll.
  const lastHandledHashRef = useRef<string | null>(null);
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (!id || !inlineIds.includes(id)) return;
    if (lastHandledHashRef.current === hash) return;
    lastHandledHashRef.current = hash;
    // Defer so the section markup is laid out before we measure/scroll.
    const raf = requestAnimationFrame(() => scrollTo(id));
    return () => cancelAnimationFrame(raf);
    // inlineIds is derived from navGroups each render; depend on its join to
    // avoid re-running on every identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, inlineIds.join(','), scrollTo]);

  // Ticker drives the "Saved [time]" footer re-render so "just now" → "1m ago".
  const [, setSavedTick] = useState(0);
  useEffect(() => {
    if (lastSavedAt == null) return;
    const id = window.setInterval(() => setSavedTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [lastSavedAt]);

  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current != null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const handleCopyLink = useCallback(() => {
    const url = window.location.href;
    void navigator.clipboard?.writeText(url);
    setCopyConfirmed(true);
    if (copyTimerRef.current != null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyConfirmed(false), 1500);
  }, []);

  // beforeunload — guards browser tab close / refresh / external nav while dirty.
  // Skipped during isSaving so the in-flight POST/PATCH isn't interrupted.
  useEffect(() => {
    if (!dirty || isSaving) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
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
    triggerDiscard();
    if (target) {
      void navigate(target);
    }
  }, [pendingNav, navigate, triggerDiscard]);

  // Inline nav click: scroll-spy to the section and reflect the hash in the URL
  // (deep-linkable) WITHOUT a route remount. Never blocked by the dirty guard —
  // staying on the same mounted page can't lose edits.
  const handleSectionNav = useCallback(
    (id: string) => {
      scrollTo(id);
      void navigate({ hash: `#${id}` }, { replace: true });
    },
    [scrollTo, navigate],
  );

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
            {scopeLinks.map((sl) => {
              const isActive = scope === sl.scope;
              const isDisabled = !isActive && sl.to == null;
              return (
                <button
                  key={sl.scope}
                  type="button"
                  disabled={isDisabled}
                  aria-disabled={isDisabled || undefined}
                  title={isDisabled ? sl.disabledReason : undefined}
                  onClick={() => {
                    if (sl.to == null) return;
                    if (guardedNavigate(sl.to)) return;
                    void navigate(sl.to);
                  }}
                  className={[
                    'py-1.5 px-1 rounded text-xs font-medium text-center transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                    isActive
                      ? 'bg-neutral-surface text-neutral-text-primary'
                      : isDisabled
                        ? 'text-neutral-text-disabled cursor-not-allowed'
                        : 'text-neutral-text-secondary hover:text-neutral-text-primary',
                  ].join(' ')}
                >
                  {sl.label}
                </button>
              );
            })}
          </div>

          {/* Context selector — switcher when >= 2 siblings (issue 776), else identity row. */}
          <div className="mt-2 px-2 py-1.5 rounded flex items-center gap-1.5 bg-neutral-surface-sunken border border-neutral-border/55 text-xs min-w-0">
            {contextOptions && contextOptions.length >= 2 ? (
              <SettingsContextSwitcher
                contextName={contextName}
                contextHealth={contextHealth}
                options={contextOptions}
                activeId={contextActiveId}
                entityLabel={scope}
                onSelect={(to) => {
                  if (guardedNavigate(to)) return;
                  void navigate(to);
                }}
              />
            ) : (
              <>
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
                <span className="flex-1 truncate text-neutral-text-primary font-medium">
                  {contextName}
                </span>
              </>
            )}
            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Copy link to settings"
              className="shrink-0 inline-flex items-center justify-center w-6 h-6 -my-1 rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {copyConfirmed ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  className="text-semantic-on-track"
                  aria-hidden="true"
                >
                  <path
                    d="M3 8l3.5 3.5L13 5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
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
          </div>
        </div>

        {/* Scroll-spy nav. Inline items scroll to their section; `to` items navigate. */}
        <nav
          className="flex-1 overflow-y-auto [scrollbar-gutter:stable] px-2 py-1"
          aria-label="Settings sections"
        >
          {navGroups.map((group) => (
            <div key={group.label} className="mb-2">
              <h2 className="px-2 py-1.5 text-xs font-semibold tracking-[.08em] uppercase text-neutral-text-secondary">
                {group.label}
              </h2>
              {group.items.map((item) => {
                const isInline = !item.to;
                const isActive = isInline && activeId === item.id;
                const className = [
                  'w-full flex items-center gap-2 px-2.5 py-[7px] rounded text-[13px] text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                  isActive
                    ? 'font-semibold text-neutral-text-primary bg-neutral-surface-sunken -ml-0.5 pl-[9px] border-l-2 border-brand-primary'
                    : 'text-neutral-text-secondary hover:text-neutral-text-primary',
                ].join(' ');
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => {
                      if (item.to) {
                        if (guardedNavigate(item.to)) return;
                        void navigate(item.to);
                      } else {
                        handleSectionNav(item.id);
                      }
                    }}
                    className={className}
                  >
                    <span
                      className={isActive ? 'text-brand-primary' : 'text-neutral-text-disabled'}
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* ── Right content area ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* The single scrolling page. scrollbar-gutter:stable keeps the track
            reserved so growing/shrinking sections never shift the panel (issue 776). */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto [scrollbar-gutter:stable] bg-neutral-surface scroll-smooth motion-reduce:scroll-auto"
          data-testid="settings-content-scroll"
        >
          {children}
        </div>

        {/* Saved [time] footer — visible when not dirty and a save landed this mount. */}
        {!dirty && lastSavedAt != null && (
          <div
            className="shrink-0 flex items-center justify-end gap-2 px-6 py-2 bg-neutral-surface-raised border-t border-neutral-border/55"
            data-testid="settings-saved-footer"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              className="text-semantic-on-track shrink-0"
              aria-hidden="true"
            >
              <path
                d="M3 8l3.5 3.5L13 5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            <span className="text-[12px] text-neutral-text-secondary">
              Saved <span className="tppm-mono">{formatRelative(new Date(lastSavedAt))}</span>
            </span>
          </div>
        )}

        {/* Save bar — armed when any section reports dirty=true. */}
        {dirty && (
          <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 bg-brand-primary border-t border-brand-primary-dark motion-safe:animate-save-bar-slide">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="text-white/80 shrink-0"
              aria-hidden="true"
            >
              <path
                d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a1 1 0 0 1 0 2 1 1 0 0 1 0-2zm0 3.5v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
            <span className="text-[13px] font-medium text-white" role="status">
              {saveError ?? 'You have unsaved changes'}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={triggerDiscard}
              disabled={isSaving}
              className="text-[13px] text-white/85 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
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
        <ConfirmDiscardDialog onKeepEditing={handleKeepEditing} onDiscard={handleDiscardAndGo} />
      )}
    </div>
  );
}

/* ── Anchored section wrapper (ADR-0146) ── */

interface SettingsSectionProps {
  /** Anchor id — matches the nav item id and the old route slug. */
  id: string;
  children: ReactNode;
}

/**
 * One anchored region on the consolidated settings page. Provides its `id` to
 * `useDirtyForm` (via context) so the section registers its own dirty entry, and
 * exposes a `data-settings-section` hook the scroll-spy observes. The first
 * focusable target inside is the section heading rendered by `SettingsPageTitle`.
 */
export function SettingsSection({ id, children }: SettingsSectionProps) {
  return (
    <SettingsSectionContext.Provider value={id}>
      <section
        data-settings-section={id}
        aria-label={id}
        // Anchor offset so a scrolled-to heading isn't flush against the top edge.
        className="scroll-mt-4"
      >
        {/* Contain a section render failure to this region — on the consolidated
            page (ADR-0146) an unguarded throw would reach the root boundary and
            replace the whole app. */}
        <SettingsSectionErrorBoundary sectionId={id}>{children}</SettingsSectionErrorBoundary>
      </section>
    </SettingsSectionContext.Provider>
  );
}

/* ── Shared page-level primitives used by all settings sections ── */

interface SettingsPageTitleProps {
  title: string;
  subtitle?: string;
  count?: string | number;
  action?: ReactNode;
}

/** Standardised section title strip with optional count and action button. */
export function SettingsPageTitle({ title, subtitle, count, action }: SettingsPageTitleProps) {
  return (
    <div className="px-6 pt-5 pb-3.5 flex items-end gap-3.5 border-b border-neutral-border/55">
      <div className="flex-1 min-w-0">
        <h1
          // Focus target for scroll-spy keyboard nav (ADR-0146): activating a rail
          // item moves focus here so keyboard / SR users land in the section.
          data-settings-section-heading
          tabIndex={-1}
          className="text-[22px] font-bold tracking-tight text-neutral-text-primary leading-none flex items-center gap-2.5 focus-visible:outline-none"
        >
          {title}
          {count != null && (
            <span className="text-[13px] font-medium text-neutral-text-secondary">{count}</span>
          )}
        </h1>
        {subtitle && <p className="mt-1 text-[13px] text-neutral-text-secondary">{subtitle}</p>}
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
    <div
      className="grid gap-6 py-3.5 border-b border-neutral-border/55 items-start"
      style={{ gridTemplateColumns: '240px 1fr' }}
    >
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

/** Raised card used in settings sections. */
export function SettingsCard({ children, className = '' }: SettingsCardProps) {
  return (
    <div
      className={`bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}
