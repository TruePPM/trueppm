import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useLocation, useMatch, useNavigate } from 'react-router';
import { useProjectId } from '@/hooks/useProjectId';
import { useProjects } from '@/hooks/useProjects';

/**
 * Route segment immediately after `:projectId` — the active view (defaults to
 * `overview`). Mirrors `ViewTabs`' currentView derivation so a switch preserves
 * the view the user is looking at rather than always dumping them on Overview.
 */
function currentViewSegment(pathname: string, projectId: string): string {
  const segments = pathname.split('/');
  const idx = segments.indexOf(projectId);
  return (idx >= 0 ? segments[idx + 1] : undefined) ?? 'overview';
}

interface SwitcherOption {
  id: string;
  name: string;
  to: string;
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className="shrink-0 text-brand-primary"
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
  );
}

/**
 * In-chrome project switcher (issue 1478). A compact searchable dropdown at the left
 * edge of the view-tab bar that lets the current user jump between the projects
 * they are a MEMBER of without leaving the project chrome — no round-trip out to
 * a listing/portfolio view and back.
 *
 * Self-gates exactly like `ViewTabs` / `ViewsMenu`: renders only on project routes
 * (the `useProjectId()` null path covers My Work / Program / workspace routes) and
 * never on project settings routes (the SettingsShell owns its own context
 * switcher there — rule 123 / rule 124). Desktop only (`hidden md:*`), matching the
 * view-tab bar it anchors; on mobile the sidebar drawer is the switch affordance.
 *
 * Renders nothing when the member-project list has fewer than two entries — with
 * one project there is nothing to switch to, and a chevron that opens an empty
 * list is a dead affordance (rule 124 precedent).
 *
 * Selecting a project preserves the active view segment (`…/schedule` → the same
 * `…/schedule` on the target project); the route is always reachable because
 * methodology hides tabs, never routes (ADR-0041, hide-only). Data comes from the
 * existing member-scoped `useProjects()` hook — no new endpoint. Per the issue's
 * non-goals this is deliberately identity-only: no health dots, no status scoring,
 * no program/portfolio grouping (those are the Enterprise governance overlay).
 *
 * Implements the rule-124 searchable-listbox contract: a `combobox` search input +
 * `role="listbox"` of `role="option"` rows, case-insensitive substring filter,
 * `aria-activedescendant` highlight, arrows/Home/End/Enter, two-stage Escape,
 * `role="status"` empty row, click-outside dismiss, and focus that returns to the
 * trigger on close.
 */
export function ProjectSwitcher() {
  const projectId = useProjectId();
  const onSettingsRoute = useMatch('/projects/:projectId/settings/*');
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects } = useProjects();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Preserve the active view on switch; recomputed per render so a later view
  // change is reflected the next time the switcher opens.
  const view = projectId ? currentViewSegment(location.pathname, projectId) : 'overview';

  const options: SwitcherOption[] = useMemo(
    () => (projects ?? []).map((p) => ({ id: p.id, name: p.name, to: `/projects/${p.id}/${view}` })),
    [projects, view],
  );

  const activeName = useMemo(
    () => options.find((o) => o.id === projectId)?.name ?? null,
    [options, projectId],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click-outside dismiss (no focus return — the user looked elsewhere).
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  // On open: focus the search input and seed the highlight to the current project.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const idx = options.findIndex((o) => o.id === projectId);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [open, options, projectId]);

  // Keep the highlight in range as the filtered set shrinks; scroll it into view.
  useEffect(() => {
    if (!open) return;
    if (activeIndex > filtered.length - 1) {
      setActiveIndex(filtered.length > 0 ? filtered.length - 1 : 0);
    } else {
      // Optional-call: scrollIntoView is unimplemented in jsdom (unit tests).
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex, filtered.length]);

  const handleSelect = useCallback(
    (opt: SwitcherOption) => {
      // Choosing the current project is a no-op beyond closing the menu.
      if (opt.id !== projectId) void navigate(opt.to);
      close(true);
    },
    [projectId, navigate, close],
  );

  function handleInputKeyDown(e: KeyboardEvent) {
    const n = filtered.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (n) setActiveIndex((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (n) setActiveIndex((i) => (i - 1 + n) % n);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(Math.max(0, n - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) handleSelect(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Two-stage: clear a non-empty query first, then close.
      if (query) {
        setQuery('');
        setActiveIndex(0);
      } else {
        close(true);
      }
    }
  }

  // Self-gate (mirrors ViewTabs): project routes only, never on settings routes.
  // Nothing to switch to with a single project → render no affordance.
  if (!projectId || onSettingsRoute || options.length < 2) return null;

  return (
    <div className="relative hidden md:block shrink-0" ref={popoverRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          activeName ? `Current project: ${activeName}. Switch project.` : 'Switch project'
        }
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[11rem] items-center gap-1.5 h-8 px-2 rounded-control text-sm font-medium text-chrome-text-secondary hover:text-chrome-text-primary hover:bg-neutral-text-primary/5 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:ring-offset-chrome-surface"
      >
        {/* Switch/stack glyph — the affordance that this label is switchable. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
          aria-hidden="true"
        >
          <path d="M2 5l6-3 6 3-6 3-6-3Z" />
          <path d="M2 11l6 3 6-3" />
          <path d="M2 8l6 3 6-3" />
        </svg>
        {activeName && <span className="hidden truncate lg:inline">{activeName}</span>}
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          className={`shrink-0 text-neutral-text-disabled transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-card border border-neutral-border bg-chrome-surface">
          {/* Search box — always present (no scan-then-search gap). focus-within
              (not focus-visible) so the programmatic open-focus shows a ring too. */}
          <div className="flex items-center gap-1.5 px-2 h-8 border-b border-neutral-border focus-within:ring-2 focus-within:ring-inset focus-within:ring-brand-primary">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              className="shrink-0 text-neutral-text-disabled"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={filtered[activeIndex] ? optionId(activeIndex) : undefined}
              aria-label="Find a project"
              placeholder="Find a project…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              className="flex-1 min-w-0 bg-transparent text-xs text-neutral-text-primary placeholder:text-neutral-text-disabled focus:outline-none"
            />
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-label="Switch project"
            className="max-h-64 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center px-2 h-8 text-xs text-neutral-text-secondary"
              >
                No projects match
              </div>
            ) : (
              filtered.map((opt, i) => {
                const isCurrent = opt.id === projectId;
                const isHighlighted = i === activeIndex;
                return (
                  <button
                    key={opt.id}
                    id={optionId(i)}
                    ref={(el) => {
                      optionRefs.current[i] = el;
                    }}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => handleSelect(opt)}
                    className={`w-full flex items-center gap-1.5 px-2 h-8 text-xs text-left text-neutral-text-primary ${isHighlighted ? 'bg-neutral-surface-sunken' : ''}`}
                  >
                    <span className="flex-1 truncate">{opt.name}</span>
                    {isCurrent && <CheckIcon />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
