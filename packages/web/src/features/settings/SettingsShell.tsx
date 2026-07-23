import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSettingsSaveStore, DEFAULT_SECTION_KEY } from './hooks/useSettingsSaveStore';
import { useScrollSpy } from './hooks/useScrollSpy';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { ConfirmDiscardDialog } from './components/ConfirmDiscardDialog';
import { SettingsContextSwitcher, type SettingsContextOption } from './SettingsContextSwitcher';
import { SettingsSectionContext, useSettingsSectionId } from './SettingsSectionContext';
import { SettingsSectionErrorBoundary } from './SettingsSectionErrorBoundary';
import { formatRelative } from '../../lib/formatRelative';

export type { SettingsContextOption } from './SettingsContextSwitcher';

export interface SettingsNavItem {
  /** Stable id — also the section anchor (`…/settings#<id>`) for inline sections. */
  id: string;
  label: string;
  icon: ReactNode;
  /**
   * Extra synonyms folded into the rail filter (#2320) and the ⌘K settings-section
   * group (#2319) so a search for "smtp" finds "Email & SMTP" and "oidc" finds
   * "Single sign-on". Not rendered — the `label` is the accessible name. Optional:
   * an item with no keywords still matches on its label. Shared source of truth with
   * the palette (workspace entries derive from `buildWorkspaceNavGroups`), so a
   * keyword authored here is reused by both surfaces (ADR-0605).
   */
  keywords?: string;
  /**
   * When set, the item is a route link (System Health tools, redirect shims):
   * clicking navigates (through the dirty guard) instead of scroll-spying to an
   * in-page section. Inline sections omit this.
   */
  to?: string;
  /**
   * Marks a route-departure "tool page" item (System health, Observability,
   * Retention & purge, Trash) — rendered with a trailing ↗ affordance so it reads
   * as "opens a separate page", not a scroll-spy section (#2252). Distinct from
   * `to`: on the off-route shells the inline config items also carry a `to`
   * (a `/settings#slug` anchor) but are NOT tool-page departures, so we flag this
   * explicitly rather than infer it from `to`.
   */
  external?: boolean;
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
  /**
   * Hide this segment entirely instead of rendering it disabled. Used on the
   * workspace-only tool pages (System Health, Observability, Trash) where a
   * program/project scope can NEVER apply — a permanently-disabled tab reading
   * "Switch from the workspace page" is a false signifier and an imperative the
   * user can't obey (#2251). Contrast the not-yet case (general settings before a
   * program/project exists), which stays disabled with softened guiding copy so
   * the tri-scope model (rule 125) still teaches. When hiding collapses the
   * switcher to a single scope, it renders as a static label, not a lone tab.
   */
  hidden?: boolean;
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
   * Mobile-only: route that leaves settings for the entity's main surface
   * (project overview, program home, app root). Desktop exits via the always-
   * visible global Sidebar (rule 123); on mobile the Sidebar is a hidden drawer
   * and `BottomNav` self-suppresses on program/workspace scope, so the mobile
   * header carries the only clear way out (issue 1709).
   */
  exitTo: string;
  /** Mobile-only: short destination label, rendered as "Back to {exitLabel}". */
  exitLabel: string;
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

// The consolidated page's single <h1>. Each section's title strip is an <h2>
// (see SettingsPageTitle), so the shell owns the one page-level heading required
// by WCAG 1.3.1 / 2.4.6. Scope-derived so it never double-prints "settings" when
// a contextName fallback already reads "… settings".
const SCOPE_HEADING: Record<'workspace' | 'project' | 'program', string> = {
  workspace: 'Workspace settings',
  project: 'Project settings',
  program: 'Program settings',
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
  exitTo,
  exitLabel,
  children,
}: SettingsShellProps) {
  const navigate = useNavigate();
  const { hash, pathname } = useLocation();

  // Below md: the 240px rail eats 64% of a 375px phone. Render the rail on
  // md+/desktop and a compact mobile header (scope + context + section select)
  // below it — conditional render, not a CSS `hidden`, so only one set of scope
  // and context controls exists in the DOM at a time (issue 539).
  const isMobile = useBreakpoint() === 'sm';

  const dirty = useSettingsSaveStore((s) => s.dirty);
  const isSaving = useSettingsSaveStore((s) => s.isSaving);
  const saveError = useSettingsSaveStore((s) => s.saveError);
  const lastSavedAt = useSettingsSaveStore((s) => s.lastSavedAt);
  const triggerSave = useSettingsSaveStore((s) => s.triggerSave);
  const triggerDiscard = useSettingsSaveStore((s) => s.triggerDiscard);

  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [copyConfirmed, setCopyConfirmed] = useState(false);
  // Desktop rail filter (#2320). Narrows the visible rail sections by label +
  // keywords; the sections themselves stay mounted in the content panel, so this
  // is a pure view concern — scroll-spy (`inlineIds`, `activeId`) still runs over
  // the full `navGroups`. Reset when the scope changes (workspace→project) so a
  // stale query never hides the new scope's rail.
  const [railFilter, setRailFilter] = useState('');
  const railFilterInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setRailFilter(''), [scope]);
  // Base id for the per-tool-group "Opens a separate page" caption, so each tool
  // button can `aria-describedby` it (route-departure context reaches AT on direct
  // focus, not only on linear reading of the rail) (#2291).
  const railCaptionIdBase = useId();

  // Inline (scroll-spy) section ids in document order — the items WITHOUT a `to`.
  const inlineIds = navGroups.flatMap((g) => g.items.filter((i) => !i.to).map((i) => i.id));

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { activeId, scrollTo } = useScrollSpy({ sectionIds: inlineIds, scrollRef });

  // Route-link rail items (`to` is a real path — System Health tools, Trash) are
  // NOT scroll-spy sections, so `activeId` never marks them. Highlight the one
  // whose `to` matches the current pathname instead, or an off-route shell
  // (`/settings/trash`, `/settings/health`) shows no "you are here" cue at all.
  // Longest prefix wins so `/settings/health/retention` activates Retention, not
  // its `/settings/health` prefix; hash deep-links (`/settings#general`) are
  // excluded — they point at a different page, not this pathname.
  const activeRouteTo = useMemo(() => {
    const routeTos = navGroups
      .flatMap((g) => g.items)
      .map((i) => i.to)
      .filter((to): to is string => !!to && to.startsWith('/') && !to.includes('#'));
    const matches = routeTos.filter((to) => pathname === to || pathname.startsWith(`${to}/`));
    return matches.sort((a, b) => b.length - a.length)[0] ?? null;
  }, [navGroups, pathname]);

  // Id of the active route-link item, so the mobile "Jump to section" <select>
  // reflects the current route the same way the desktop rail highlights it.
  const activeRouteId = useMemo(
    () =>
      navGroups.flatMap((g) => g.items).find((i) => i.to === activeRouteTo)?.id ?? null,
    [navGroups, activeRouteTo],
  );

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

  // Route through the dirty guard, then navigate — shared by the scope switcher
  // and context switcher in both the desktop rail and the mobile header.
  const navGuarded = useCallback(
    (to: string) => {
      if (guardedNavigate(to)) return;
      void navigate(to);
    },
    [guardedNavigate, navigate],
  );

  // Mobile "jump to section" <select> onChange: an inline id scroll-spies; a
  // `to` id (System Health tools) routes through the dirty guard. Mirrors the
  // rail button behaviour so the collapsed mobile nav reaches every section.
  const handleSectionSelect = useCallback(
    (id: string) => {
      const item = navGroups.flatMap((g) => g.items).find((i) => i.id === id);
      if (!item) return;
      if (item.to) {
        navGuarded(item.to);
      } else {
        handleSectionNav(id);
      }
    },
    [navGroups, navGuarded, handleSectionNav],
  );

  // Activate a rail item the way a click would: route links go through the dirty
  // guard, inline sections scroll-spy. Shared by the rail buttons and the filter's
  // Enter shortcut so both branch identically (#2320).
  const activateItem = useCallback(
    (item: SettingsNavItem) => {
      if (item.to) {
        if (guardedNavigate(item.to)) return;
        void navigate(item.to);
      } else {
        handleSectionNav(item.id);
      }
    },
    [guardedNavigate, navigate, handleSectionNav],
  );

  // Rail filter (#2320): case-insensitive substring over label + keywords. Groups
  // with no surviving item are dropped whole (their heading too). An empty query
  // returns every group unchanged.
  const trimmedRailFilter = railFilter.trim().toLowerCase();
  const filteredNavGroups = useMemo(() => {
    if (!trimmedRailFilter) return navGroups;
    return navGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(trimmedRailFilter),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [navGroups, trimmedRailFilter]);

  const railFilterHasMatches = filteredNavGroups.length > 0;

  // Enter in the filter jumps to the first match. Inline sections scroll and the
  // filter clears (rail restored for the next hop); a route-departure just
  // navigates. No match → no-op.
  const handleRailFilterEnter = useCallback(() => {
    const first = filteredNavGroups[0]?.items[0];
    if (!first) return;
    activateItem(first);
    if (!first.to) {
      setRailFilter('');
      railFilterInputRef.current?.focus();
    }
  }, [filteredNavGroups, activateItem]);

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left rail (md+) — collapses to the mobile header below md: (issue 539) ── */}
      {!isMobile && (
      <aside
        className="w-60 shrink-0 flex flex-col bg-neutral-surface-raised border-r border-neutral-border overflow-hidden"
        aria-label="Settings navigation"
      >
        {/* Scope switcher + context selector */}
        <div className="px-3.5 pt-3 pb-2 shrink-0 space-y-2">
          <ScopeSwitcher scope={scope} scopeLinks={scopeLinks} onNavigate={navGuarded} />
          <ContextRow
            scope={scope}
            contextName={contextName}
            contextHealth={contextHealth}
            contextOptions={contextOptions}
            contextActiveId={contextActiveId}
            onNavigate={navGuarded}
            onCopyLink={handleCopyLink}
            copyConfirmed={copyConfirmed}
          />
        </div>

        {/* Rail filter (#2320). A form field, so it keeps focus-visible: (rule 214
            carves out shell-chrome buttons, not inputs). Narrows the list below by
            label + keywords; Enter jumps to the first match. */}
        <div className="px-3.5 pb-2 shrink-0">
          <div className="relative">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-text-disabled"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              ref={railFilterInputRef}
              type="text"
              role="searchbox"
              value={railFilter}
              onChange={(e) => setRailFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleRailFilterEnter();
                } else if (e.key === 'Escape' && railFilter) {
                  // Clear on Escape while there is a query; stop it reaching any
                  // global handler so the shell stays put. An empty field lets
                  // Escape bubble (nothing to clear here).
                  e.preventDefault();
                  e.stopPropagation();
                  setRailFilter('');
                }
              }}
              aria-label="Filter settings sections"
              aria-controls="settings-section-list"
              placeholder="Filter settings…"
              className="w-full h-8 pl-8 pr-7 rounded-control text-[13px] bg-neutral-surface-sunken border border-neutral-border text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            />
            {railFilter && (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => {
                  setRailFilter('');
                  railFilterInputRef.current?.focus();
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Polite count so a filter keystroke is announced without moving focus. */}
        <div className="sr-only" role="status" aria-live="polite">
          {trimmedRailFilter
            ? railFilterHasMatches
              ? `${filteredNavGroups.reduce((n, g) => n + g.items.length, 0)} settings sections`
              : 'No settings sections'
            : ''}
        </div>

        {/* Scroll-spy nav. Inline items scroll to their section; `to` items navigate.
            min-h-0 is load-bearing (same reason as the content panel below, #2252):
            a flex-1 child defaults to min-height:auto (its content height), so
            without it this nav refuses to shrink, the list overflows the aside's
            bounded height, and the aside's overflow-hidden clips the bottom group
            (SYSTEM) with no scrollbar — the rail can't reach System health/Trash. */}
        <nav
          id="settings-section-list"
          className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] px-2 py-1"
          aria-label="Settings sections"
        >
          {!railFilterHasMatches && (
            // Not role="status" — the sr-only live region above already announces
            // the empty state; a second polite region would double-announce it.
            <p className="px-3.5 py-3 text-[13px] text-neutral-text-secondary">
              No settings match “{railFilter.trim()}”
            </p>
          )}
          {filteredNavGroups.map((group, groupIdx) => {
            // A group whose every item is a route-departure tool page (System
            // health, Observability, Retention & purge, Trash — `external: true`)
            // is NOT part of the consolidated page's scroll-spy flow: clicking one
            // navigates away. Styled like the config groups above it, the rail
            // reads top-to-bottom as one scroll flow, so users try to scroll down
            // to it, never reach it (the last inline section is Danger), then
            // resort to clicking — which breaks the single-page feel (#2291). Set
            // it off with a top divider + an "Opens a separate page" caption so it
            // reads as a distinct "tool pages you open" cluster, reinforcing the
            // route-departure intent of ADR-0146/#2252 (which this does NOT
            // reverse). Inferred from `external` (not `to`): on the off-route tool
            // shells the config items also carry a `/settings#slug` `to`, but they
            // are scroll anchors, not departures — only `external` marks a tool.
            const isToolGroup = group.items.length > 0 && group.items.every((i) => i.external);
            const captionId = isToolGroup ? `${railCaptionIdBase}-${groupIdx}` : undefined;
            return (
            <div
              key={group.label}
              className={isToolGroup ? 'mb-2 mt-2 pt-2 border-t border-neutral-border' : 'mb-2'}
            >
              <h2
                className={`px-2 pt-1.5 ${isToolGroup ? 'pb-0' : 'pb-1.5'} text-xs font-semibold tracking-[.08em] uppercase text-neutral-text-secondary`}
              >
                {group.label}
              </h2>
              {isToolGroup && (
                // Settings density (rule 118) permits text-[11px]; text-secondary
                // clears WCAG 1.4.3 on the raised rail surface. This visible caption
                // carries the "these navigate away" context that the per-item ↗ (an
                // aria-hidden decoration) does not expose to screen readers.
                <p id={captionId} className="px-2 pb-1.5 text-[11px] font-normal text-neutral-text-secondary">
                  Opens a separate page
                </p>
              )}
              {group.items.map((item) => {
                const isInline = !item.to;
                // Inline sections track the scroll-spy; route links track the URL.
                // On a route-link page the scroll-spy sections aren't mounted (yet
                // `activeId` still seeds to the first section id), so suppress the
                // inline highlight there — only the matching route item is active.
                const isActive = isInline
                  ? activeRouteTo == null && activeId === item.id
                  : item.to === activeRouteTo;
                const className = [
                  'w-full flex items-center gap-2 px-2.5 py-[7px] rounded-control text-[13px] text-left transition-colors',
                  // a11y rule 214: standalone shell-chrome controls (rail items,
                  // save-bar, scope switcher, copy-link) use focus: not focus-visible:
                  // so a pointer click still paints a ring in Firefox/desktop Safari
                  // (WCAG 2.4.7). The mobile <select> jump-to-section and the heading
                  // scroll-target below keep focus-visible: (form field / a11y target).
                  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
                  isActive
                    ? 'font-semibold text-neutral-text-primary bg-neutral-surface-sunken -ml-0.5 pl-[9px] border-l-2 border-brand-primary'
                    : 'text-neutral-text-secondary hover:text-neutral-text-primary',
                ].join(' ');
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? (isInline ? 'true' : 'page') : undefined}
                    // Tool-page buttons point at the group's "Opens a separate page"
                    // caption so AT announces the route-departure context on direct
                    // focus, not only when reading the rail top-to-bottom (#2291).
                    aria-describedby={captionId}
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
                    {/* Route-departure tool page (#2252): a trailing ↗ signals
                        "opens a separate page" so these items don't read as
                        scroll-spy sections. aria-hidden — the label carries the
                        accessible name (rule 6). */}
                    {item.external && (
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 16 16"
                        aria-hidden="true"
                        // The ↗ is the sole visual "opens a separate page" signifier
                        // (#2252), so it must clear WCAG 1.4.11 3:1 — text-secondary,
                        // not text-disabled, which fails on the active item's sunken
                        // background (rule 87).
                        className="ml-auto shrink-0 text-neutral-text-secondary"
                      >
                        <path
                          d="M6 3.5h6.5V10 M12.5 3.5L4 12"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          fill="none"
                        />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
            );
          })}
        </nav>
      </aside>
      )}

      {/* ── Right content area ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* The one page-level heading for the consolidated settings page. Section
            title strips are <h2> under this, so the document has exactly one <h1>
            (WCAG 1.3.1 / 2.4.6). sr-only: the design surfaces each section's own
            <h2> visually; a duplicate visible page title would be redundant chrome. */}
        <h1 className="sr-only">
          {contextName ? `${SCOPE_HEADING[scope]}: ${contextName}` : SCOPE_HEADING[scope]}
        </h1>
        {/* Mobile settings header — stands in for the rail below md: (issue 539).
            Scope switcher + context row + a native "jump to section" select that
            mirrors the scroll-spy (value tracks activeId). Native <select> gives an
            OS-native, 44px, screen-reader-friendly picker with zero popover code. */}
        {isMobile && (
        <div className="shrink-0 bg-neutral-surface-raised border-b border-neutral-border px-3.5 py-3 space-y-2">
          {/* Exit affordance — mobile only. Desktop exit is the always-visible
              global Sidebar (rule 123); on mobile the Sidebar is a hidden drawer
              and BottomNav self-suppresses on program/workspace scope, so this is
              the only clear way out of settings (issue 1709). Routes through
              navGuarded so a dirty form still hits ConfirmDiscardDialog. */}
          <button
            type="button"
            onClick={() => navGuarded(exitTo)}
            className="inline-flex items-center gap-1.5 min-h-[44px] -my-1.5 px-1 rounded-control text-[13px] font-medium text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
              <path
                d="M10 3.5L5.5 8l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
            Back to {exitLabel}
          </button>
          <ScopeSwitcher scope={scope} scopeLinks={scopeLinks} onNavigate={navGuarded} />
          <ContextRow
            scope={scope}
            contextName={contextName}
            contextHealth={contextHealth}
            contextOptions={contextOptions}
            contextActiveId={contextActiveId}
            onNavigate={navGuarded}
            onCopyLink={handleCopyLink}
            copyConfirmed={copyConfirmed}
          />
          <label htmlFor="settings-section-jump" className="sr-only">
            Jump to section
          </label>
          <select
            id="settings-section-jump"
            value={activeRouteId ?? activeId ?? ''}
            onChange={(e) => handleSectionSelect(e.target.value)}
            className="w-full min-h-[44px] rounded-control border border-neutral-border bg-neutral-surface px-3 text-[13px] text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          >
            {navGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        )}

        {/* The single scrolling page. min-h-0 is load-bearing: a flex child
            defaults to min-height:auto (its content height), so without it this
            flex-1 item refuses to shrink, overflows the height chain, and lets
            <main> scroll past the content into empty canvas (issue 1618).
            scrollbar-gutter:stable keeps the track reserved so growing/shrinking
            sections never shift the panel (issue 776).
            `relative` makes this scroll authority the containing block for its
            absolutely-positioned descendants (issue 2008): the Inherit/Override
            chips and Visibility radios wrap a visually-hidden `sr-only`
            (position:absolute) radio, and clicking a label focuses it. Without a
            positioned ancestor here, that focused radio's containing block
            resolves to the initial containing block, so the browser scrolls the
            WINDOW — not this container — to reveal it, pushing the h-screen app
            up and exposing blank canvas below. Positioning the container keeps
            focus-scroll-into-view inside it (already at the right place → no
            visible jump). */}
        <div
          ref={scrollRef}
          className="relative flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] bg-app-canvas scroll-smooth motion-reduce:scroll-auto"
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
              className="text-neutral-text-inverse/80 shrink-0"
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
            <span className="text-[13px] font-medium text-neutral-text-inverse" role="status">
              {saveError ?? 'You have unsaved changes'}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={triggerDiscard}
              disabled={isSaving}
              className="text-[13px] text-neutral-text-inverse/85 hover:text-neutral-text-inverse focus:outline-none focus:ring-2 focus:ring-white disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void triggerSave()}
              disabled={isSaving}
              aria-keyshortcuts="Meta+S Control+S"
              className="px-3.5 py-1.5 rounded-control bg-white text-brand-primary-dark text-[13px] font-semibold hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-60"
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

/* ── Rail primitives shared by the desktop rail and the mobile header (issue 539) ── */

/** Workspace / Program / Project segmented control. */
function ScopeSwitcher({
  scope,
  scopeLinks,
  onNavigate,
}: {
  scope: 'workspace' | 'project' | 'program';
  scopeLinks: SettingsScopeLink[];
  onNavigate: (to: string) => void;
}) {
  // Segments a program/project scope can NEVER apply to (System Health,
  // Observability, Trash) are hidden, not shown disabled (#2251). If hiding
  // collapses the switcher to a single scope, render a static identity label
  // rather than a lone segmented "tab" (which reads as a broken control and, as
  // a one-item tablist, confuses screen readers).
  const visible = scopeLinks.filter((sl) => !sl.hidden);
  const soleScope = visible.length <= 1 ? (visible[0] ?? scopeLinks.find((sl) => sl.scope === scope)) : null;

  return (
    <div>
      <p className="text-xs font-semibold tracking-[.1em] uppercase text-neutral-text-secondary mb-1.5">
        Scope
      </p>
      {soleScope ? (
        <div className="bg-neutral-surface-sunken rounded-control p-0.5">
          <div className="py-1.5 px-1 rounded-control text-xs font-medium text-center bg-neutral-surface text-neutral-text-primary">
            {soleScope.label}
          </div>
        </div>
      ) : (
        <div
          className={[
            'grid bg-neutral-surface-sunken rounded-control p-0.5 gap-0',
            SCOPE_GRID_COLS[visible.length] ?? 'grid-cols-3',
          ].join(' ')}
        >
          {visible.map((sl) => {
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
                  onNavigate(sl.to);
                }}
                className={[
                  'py-1.5 px-1 rounded-control text-xs font-medium text-center transition-colors',
                  'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
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
      )}
    </div>
  );
}

// Tailwind can't interpolate a class from a runtime count, so map the visible
// scope-segment count to a static grid-cols class (#2251).
const SCOPE_GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
};

/** Context selector — switcher when >= 2 siblings (issue 776), else identity row. */
function ContextRow({
  scope,
  contextName,
  contextHealth,
  contextOptions,
  contextActiveId,
  onNavigate,
  onCopyLink,
  copyConfirmed,
}: {
  scope: 'workspace' | 'project' | 'program';
  contextName: string;
  contextHealth?: 'onTrack' | 'atRisk' | 'critical' | null;
  contextOptions?: SettingsContextOption[];
  contextActiveId?: string;
  onNavigate: (to: string) => void;
  onCopyLink: () => void;
  copyConfirmed: boolean;
}) {
  return (
    <div className="px-2 py-1.5 rounded-card flex items-center gap-1.5 bg-neutral-surface-sunken border border-neutral-border/55 text-xs min-w-0">
      {contextOptions && contextOptions.length >= 2 ? (
        <SettingsContextSwitcher
          contextName={contextName}
          contextHealth={contextHealth}
          options={contextOptions}
          activeId={contextActiveId}
          entityLabel={scope}
          onSelect={onNavigate}
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
              className="w-3.5 h-3.5 rounded-chip bg-brand-primary shrink-0 inline-flex items-center justify-center text-neutral-text-inverse text-[10px] font-bold"
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
        onClick={onCopyLink}
        aria-label="Copy link to settings"
        className="shrink-0 inline-flex items-center justify-center w-6 h-6 -my-1 rounded-control text-neutral-text-secondary hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
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
  );
}

/* ── Anchored section wrapper (ADR-0146) ── */

/**
 * DOM id for a section's heading node, minted from the section id. `SettingsSection`
 * points its `aria-labelledby` here and `SettingsPageTitle` stamps the matching id
 * on its `<h2>`, so a region is named by its real title instead of the raw slug.
 */
function settingsHeadingId(sectionId: string): string {
  return `settings-heading-${sectionId}`;
}

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
        // Name the region by its visible heading (the <h2> SettingsPageTitle
        // renders under this same section id) rather than the raw slug — a bare
        // `aria-label={id}` announced "signal-privacy" verbatim to SR users. The
        // heading id is minted from the section id below, so this always resolves.
        aria-labelledby={settingsHeadingId(id)}
        // Section-level break so adjacent sections are visually separable at a
        // glance (issues 1986/2007). `neutral-border` #E6E1D6 is only ~5% darker
        // than the warm canvas, so opacity alone can't rank a section boundary
        // above the `/55` intra-section field-row lines — negative space is the
        // reliable lever. Rank sections by *air* (32px of canvas gap both sides of
        // the rule via mt-8 + pt-8) and by *width* (a 2px rule vs the 1px field
        // rows); field rows and the title-strip underline stay 1px/55%. Suppressed
        // on the first section (flush under the header). scroll-mt clears the
        // heading below the sticky header + the section top padding when scroll-spy
        // jumps to it (ADR-0146).
        className="scroll-mt-6 mt-8 pt-8 border-t-2 border-neutral-border first:mt-0 first:pt-0 first:border-t-0"
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
  // Each section renders one of these on the consolidated page, so it must be an
  // <h2> under the shell's single page <h1> (WCAG 1.3.1 / 2.4.6). When mounted
  // inside a <SettingsSection>, stamp the id its region's aria-labelledby targets
  // so the region is named by this real title, not the slug; outside a section
  // (standalone tool pages) the context is the default key and we omit the id.
  const sectionId = useSettingsSectionId();
  const headingId = sectionId !== DEFAULT_SECTION_KEY ? settingsHeadingId(sectionId) : undefined;
  return (
    <div className="px-6 pt-5 pb-3.5 flex items-end gap-3.5 border-b border-neutral-border/55">
      <div className="flex-1 min-w-0">
        <h2
          id={headingId}
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
        </h2>
        {subtitle && <p className="mt-1 text-[13px] text-neutral-text-secondary">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * DOM ids a {@link FieldRow} generates for the nodes a control should point its
 * `aria-describedby` at — the visible hint and the inline error. Delivered to a
 * render-prop child; each is `undefined` when that node is absent, so
 * `describedBy` is `undefined` (not an empty string) when the row has neither.
 */
export interface FieldRowDescriptors {
  /** id of the hint node, or `undefined` when the row has no hint. */
  hintId?: string;
  /** id of the inline error node, or `undefined` when the row has no error. */
  errorId?: string;
  /**
   * Space-joined `hintId`+`errorId` ready to drop into `aria-describedby`, or
   * `undefined` when neither exists. Prefer this over composing the two by hand.
   */
  describedBy?: string;
}

interface FieldRowProps {
  label: string;
  hint?: ReactNode;
  /**
   * Optional contextual-help affordance rendered inline in the label row, to the
   * right of the label — the home for a shared {@link FieldHelp} ⓘ trigger
   * (web-rule 263). Kept distinct from `hint`: `hint` is the always-visible
   * explanatory line the control's `aria-describedby` points at, while `help` is
   * an on-demand popover trigger that is deliberately NOT part of that
   * association. Absent → the label renders exactly as before (~100 call sites
   * unaffected). Previously each FieldHelp field hand-rolled its label row (see
   * `WorkspaceEmailPage`), losing this row's responsive grid + describedby wiring.
   */
  help?: ReactNode;
  /**
   * Row content. Either a plain node, or a render function that receives the
   * {@link FieldRowDescriptors} for this row so the control can wire
   * `aria-describedby` to the visible hint (and inline error) without the caller
   * having to invent ids. The hint is a plain `<div>` with no implicit
   * association, so a control that omits this wiring announces as an unlabeled,
   * hint-less edit box to screen readers (web-rule 269, WCAG 1.3.1 / 4.1.2).
   */
  children: ReactNode | ((ids: FieldRowDescriptors) => ReactNode);
  /**
   * Server-side validation message for the control in this row. When set, an
   * inline `role="alert"` line is rendered under the control; point the
   * control's `aria-describedby`/`aria-invalid` at the error node so the
   * association is programmatic (WCAG 3.3.1 / 4.1.2). Use the render-prop
   * `errorId`, or pass an explicit `errorId` prop and reference it yourself.
   */
  error?: string;
  /**
   * DOM id for the inline error node — the control references it via
   * `aria-describedby`. Optional: when omitted the row generates one and hands
   * it back through the render-prop `errorId`.
   */
  errorId?: string;
}

/**
 * Two-column form row: 240px label+hint on left, content on right at >= md.
 * Below md the fixed 240px label column would leave a phone <140px for the
 * control, so the row stacks to a single column (label above content) — this is
 * the actual fix for settings-form overflow at 375px (issue 539).
 *
 * The hint is rendered with a generated `id`; pass a render-prop child to
 * receive that id (plus the error id) and point the control's
 * `aria-describedby` at it, so the hint and inline error are programmatically
 * associated with the control rather than being merely adjacent text.
 */
export function FieldRow({ label, hint, help, children, error, errorId }: FieldRowProps) {
  // Generate ids unconditionally (hooks can't be called conditionally), then
  // only surface the ones whose nodes actually render — a control must never
  // `aria-describedby` an id that isn't in the DOM.
  const generatedHintId = useId();
  const generatedErrorId = useId();
  // Truthy check (not `!= null`) mirrors the original `{hint && …}` render guard
  // so a falsy hint — `""`, or a `cond && "text"` that resolved to `false` —
  // renders no hint node and therefore surfaces no `hintId` to describe by.
  const hintId = hint ? generatedHintId : undefined;
  const resolvedErrorId = error ? (errorId ?? generatedErrorId) : undefined;
  const describedBy = [hintId, resolvedErrorId].filter(Boolean).join(' ') || undefined;

  const content =
    typeof children === 'function'
      ? children({ hintId, errorId: resolvedErrorId, describedBy })
      : children;

  return (
    <div className="grid grid-cols-1 gap-2 md:gap-6 md:grid-cols-[240px_1fr] py-3.5 border-b border-neutral-border/55 items-start">
      <div>
        <div className="flex items-center gap-1.5">
          <div className="text-[13px] font-medium text-neutral-text-primary">{label}</div>
          {help}
        </div>
        {hint && (
          <div
            id={hintId}
            className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug"
          >
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0">
        {content}
        {error && (
          <p id={resolvedErrorId} role="alert" className="mt-1 text-[12px] text-semantic-critical">
            {error}
          </p>
        )}
      </div>
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
      className={`bg-neutral-surface-raised border border-neutral-border rounded-card overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}
