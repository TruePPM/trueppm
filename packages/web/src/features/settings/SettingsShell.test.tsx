import { render, screen, fireEvent, act, within, createEvent } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import {
  SettingsShell,
  SettingsSection,
  SettingsPageTitle,
  SettingsCard,
  FieldRow,
  type SettingsNavGroup,
  type SettingsScopeLink,
} from './SettingsShell';
import { useSettingsSaveStore, DEFAULT_SECTION_KEY } from './hooks/useSettingsSaveStore';

// jsdom has no matchMedia, so the real useBreakpoint always reports 'lg'. Mock it
// with a mutable tier so most tests exercise the desktop rail and the mobile
// header block can be tested at 'sm' (issue 539).
let mockBreakpoint: 'sm' | 'md' | 'lg' = 'lg';
vi.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => mockBreakpoint,
}));

// Inline scroll-spy sections (no `to`) plus one route-link item (System Health
// style) that still routes through the dirty guard.
const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Setup',
    items: [
      { id: 'general', label: 'General', icon: <span /> },
      { id: 'access', label: 'Access', keywords: 'permissions rbac roles', icon: <span /> },
    ],
  },
  {
    label: 'System',
    items: [
      // Real System tool items are `external` — route departures, not scroll
      // anchors — which drives the "Opens a separate page" rail treatment (#2291).
      {
        id: 'health',
        label: 'System health',
        to: '/settings/health',
        external: true,
        icon: <span />,
      },
    ],
  },
];

const SCOPE_LINKS: SettingsScopeLink[] = [
  { scope: 'workspace', label: 'Workspace', to: '/settings' },
  { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
  { scope: 'program', label: 'Program', to: '/programs/x/settings' },
];

function registerSection(
  opts: Partial<{
    dirty: boolean;
    apiReady: boolean;
    onSave: () => Promise<void> | void;
    onReset: () => void;
  }> = {},
) {
  useSettingsSaveStore.getState().register(DEFAULT_SECTION_KEY, {
    dirty: opts.dirty ?? true,
    apiReady: opts.apiReady ?? true,
    onSave: opts.onSave ?? vi.fn().mockResolvedValue(undefined),
    onReset: opts.onReset ?? vi.fn(),
  });
}

function renderShell(initialEntries: string[] = ['/projects/p1/settings']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/projects/p1/settings"
          element={
            <SettingsShell
              scope="project"
              scopeLinks={SCOPE_LINKS}
              contextName="Project Atlas"
              navGroups={NAV_GROUPS}
              exitTo="/projects/p1/overview"
              exitLabel="Overview"
            >
              <SettingsSection id="general">
                <SettingsPageTitle title="General" />
                <div>GENERAL_SECTION</div>
              </SettingsSection>
              <SettingsSection id="access">
                <SettingsPageTitle title="Access" />
                <div>ACCESS_SECTION</div>
              </SettingsSection>
            </SettingsShell>
          }
        />
        <Route path="/settings/health" element={<div>HEALTH_ROUTE</div>} />
        <Route path="/settings" element={<div>WORKSPACE_ROUTE</div>} />
        <Route path="/projects/p1/overview" element={<div>OVERVIEW_ROUTE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('<SettingsShell>', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  it('mounts every section at once on one scrolling page', () => {
    renderShell();
    // Both sections are present simultaneously — no route swap between them.
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
    expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
  });

  it('ranks adjacent sections by air + a 2px rule, suppressed on the first (issues 1986/2007)', () => {
    renderShell();
    const sections = Array.from(document.querySelectorAll<HTMLElement>('[data-settings-section]'));
    expect(sections.length).toBeGreaterThanOrEqual(2);
    // Every section ranks by negative space (32px gap both sides of the rule via
    // mt-8 + pt-8) and a 2px rule that out-weighs the 1px `/55` field-row lines;
    // `first:` suppresses the gap/rule on the leading section (flush under the
    // header) via CSS — assert the classes are present so the boundary treatment
    // can't silently regress back to a near-invisible hairline.
    for (const s of sections) {
      expect(s.className).toContain('border-t-2');
      expect(s.className).toContain('border-neutral-border');
      expect(s.className).toContain('mt-8');
      expect(s.className).toContain('pt-8');
      expect(s.className).toContain('first:mt-0');
      expect(s.className).toContain('first:pt-0');
      expect(s.className).toContain('first:border-t-0');
    }
  });

  it('reserves the scrollbar gutter on the content panel to prevent layout shift (#776)', () => {
    renderShell();
    const scroll = screen.getByTestId('settings-content-scroll');
    expect(scroll.className).toContain('[scrollbar-gutter:stable]');
  });

  it('constrains the content panel with min-h-0 so it never over-scrolls past content (#1618)', () => {
    // Without min-h-0 the flex-1 scroll child keeps its content-height min and
    // overflows the height chain, letting <main> scroll into empty canvas.
    renderShell();
    const scroll = screen.getByTestId('settings-content-scroll');
    expect(scroll.className).toContain('min-h-0');
    expect(scroll.className).toContain('overflow-y-auto');
  });

  it('constrains the rail nav with min-h-0 so the SYSTEM group stays reachable (#2252)', () => {
    // The aside is overflow-hidden; without min-h-0 the flex-1 nav keeps its
    // content-height min, overflows the aside, and the last group (SYSTEM) is
    // clipped with no scrollbar — you can never scroll the rail to it.
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(nav.className).toContain('min-h-0');
    expect(nav.className).toContain('overflow-y-auto');
  });

  it('sets off a route-departure tool group with a divider + "Opens a separate page" caption (#2291)', () => {
    // The System group's items are `external` (they navigate away), so the rail
    // must read as a distinct "tool pages you open" cluster — a top divider plus
    // a caption — so users don't mistake it for another scroll-spy section and try
    // (and fail) to scroll to it.
    renderShell();
    const caption = screen.getByText('Opens a separate page');
    // Caption sits inside the System group container, which carries the divider.
    const systemGroup = caption.closest('div');
    expect(systemGroup?.className).toContain('border-t');
    // The tool button is described by the caption, so AT announces the
    // route-departure context on direct focus (not only linear reading).
    expect(caption.id).toBeTruthy();
    expect(screen.getByRole('button', { name: 'System health' })).toHaveAttribute(
      'aria-describedby',
      caption.id,
    );
    // A scroll-spy config button carries no such description.
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute('aria-describedby');
    // The scroll-spy config group ('Setup') gets neither the caption nor a divider.
    const setupHeading = screen.getByRole('heading', { name: 'Setup' });
    const setupGroup = setupHeading.closest('div');
    expect(setupGroup?.className).not.toContain('border-t');
    expect(within(setupGroup as HTMLElement).queryByText('Opens a separate page')).toBeNull();
  });

  it('renders inline sections as scroll-spy buttons, not links', () => {
    renderShell();
    // Inline sections are buttons (scroll-spy), not anchor links — no route swap.
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'General' })).not.toBeInTheDocument();
    // Exactly one inline item is marked current (scroll-spy active). jsdom has no
    // layout, so which one is geometry-dependent — assert the count, not the id.
    const current = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
  });

  it('clicking an inline nav item scrolls to its section without a route change', () => {
    renderShell();
    const access = screen.getByRole('button', { name: 'Access' });
    act(() => {
      fireEvent.click(access);
    });
    // Same mounted page — both sections still rendered, no confirm dialog.
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
    expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it("inline nav click does NOT trip the dirty guard (same page can't lose edits)", () => {
    renderShell();
    registerSection({ dirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Access' }));
    // Scroll-spy stays on the page; no discard prompt.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('hides the save bar when not dirty', () => {
    renderShell();
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });

  it('renders the save bar when any section is dirty', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('clicking Save triggers the registered onSave', async () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => registerSection({ dirty: true, onSave }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('clicking Discard triggers the registered onReset', () => {
    renderShell();
    const onReset = vi.fn();
    act(() => registerSection({ dirty: true, onReset }));
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows the save error in place of the unsaved-changes label when saveError is set', () => {
    renderShell();
    act(() => {
      registerSection({ dirty: true });
      useSettingsSaveStore.setState({ saveError: 'Network down' });
    });
    expect(screen.getByText('Network down')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
  });

  it('clicking a route-link nav item with no dirty state navigates immediately', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'System health' }));
    expect(screen.getByText('HEALTH_ROUTE')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('clicking a route-link nav item while dirty opens the confirm-discard dialog', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    fireEvent.click(screen.getByRole('button', { name: 'System health' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // Page has NOT navigated yet — sections still mounted.
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
  });

  // ── Route-link items get the active highlight from the URL (#2230) ──
  // A route-link rail item (System Health tools, Trash) is not a scroll-spy
  // section, so it must derive its "you are here" state from the pathname.
  describe('route-link active highlight (#2230)', () => {
    // Nav with two nested route links so longest-prefix matching is exercised.
    const ROUTE_NAV: SettingsNavGroup[] = [
      { label: 'Setup', items: [{ id: 'general', label: 'General', icon: <span /> }] },
      {
        label: 'System',
        items: [
          { id: 'health', label: 'System health', to: '/settings/health', icon: <span /> },
          {
            id: 'retention',
            label: 'Retention & purge',
            to: '/settings/health/retention',
            icon: <span />,
          },
          { id: 'trash', label: 'Trash', to: '/settings/trash', icon: <span /> },
        ],
      },
    ];

    function renderAt(pathname: string) {
      return render(
        <MemoryRouter initialEntries={[pathname]}>
          <SettingsShell
            scope="workspace"
            scopeLinks={SCOPE_LINKS}
            contextName="Acme"
            navGroups={ROUTE_NAV}
            exitTo="/"
            exitLabel="Home"
          >
            <div>ROUTE_PAGE</div>
          </SettingsShell>
        </MemoryRouter>,
      );
    }

    it('marks the route-link item for the current path with aria-current="page"', () => {
      renderAt('/settings/trash');
      expect(screen.getByRole('button', { name: 'Trash' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('button', { name: 'System health' })).not.toHaveAttribute(
        'aria-current',
      );
    });

    it('longest-prefix wins: /settings/health/retention activates Retention, not System health', () => {
      renderAt('/settings/health/retention');
      expect(screen.getByRole('button', { name: 'Retention & purge' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(screen.getByRole('button', { name: 'System health' })).not.toHaveAttribute(
        'aria-current',
      );
    });

    it('the mobile jump-to-section select reflects the active route item', () => {
      mockBreakpoint = 'sm';
      renderAt('/settings/trash');
      expect(screen.getByLabelText('Jump to section')).toHaveValue('trash');
      mockBreakpoint = 'lg';
    });
  });

  it('"Keep editing" closes the dialog without navigating', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    fireEvent.click(screen.getByRole('button', { name: 'System health' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
  });

  it('"Discard changes" closes the dialog, calls onReset, and navigates', () => {
    renderShell();
    const onReset = vi.fn();
    act(() => registerSection({ dirty: true, onReset }));
    fireEvent.click(screen.getByRole('button', { name: 'System health' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('HEALTH_ROUTE')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('scope switcher button while dirty also triggers the dialog', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Ctrl+S triggers save when dirty', async () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => registerSection({ dirty: true, onSave }));
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S is a noop when not dirty', () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => registerSection({ dirty: false, onSave }));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
  });

  describe('deep-link (#1248)', () => {
    it('renders the section the URL hash points at', () => {
      // The deep-link effect scroll-spies to #access on mount; both sections are
      // mounted regardless, so we assert the section exists (scroll is a no-op in jsdom).
      renderShell(['/projects/p1/settings#access']);
      expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
    });
  });

  describe('context switcher (#776)', () => {
    const CONTEXT_OPTIONS = [
      { id: 'p1', name: 'test', health: 'onTrack' as const, to: '/projects/p1/settings' },
      { id: 'p2', name: 'test2', health: 'critical' as const, to: '/projects/p2/settings' },
    ];

    function renderWithOptions(options = CONTEXT_OPTIONS) {
      return render(
        <MemoryRouter initialEntries={['/projects/p1/settings']}>
          <Routes>
            <Route
              path="/projects/p1/settings"
              element={
                <SettingsShell
                  scope="project"
                  scopeLinks={SCOPE_LINKS}
                  contextName="test"
                  contextHealth="onTrack"
                  contextOptions={options}
                  contextActiveId="p1"
                  navGroups={NAV_GROUPS}
                  exitTo="/projects/p1/overview"
                  exitLabel="Overview"
                >
                  <SettingsSection id="general">
                    <SettingsPageTitle title="General" />
                    <div>GENERAL_SECTION</div>
                  </SettingsSection>
                </SettingsShell>
              }
            />
            <Route path="/projects/p2/settings" element={<div>P2_PAGE</div>} />
          </Routes>
        </MemoryRouter>,
      );
    }

    it('renders the switcher trigger when 2+ options are provided', () => {
      renderWithOptions();
      expect(screen.getByRole('button', { name: /Switch project/ })).toBeInTheDocument();
    });

    it('renders a static context name (no switcher) with fewer than 2 options', () => {
      renderWithOptions([CONTEXT_OPTIONS[0]]);
      expect(screen.queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument();
      expect(screen.getByText('test')).toBeInTheDocument();
    });

    it('disables a scope segment whose target is unavailable, instead of navigating to a blank page (#776)', () => {
      render(
        <MemoryRouter initialEntries={['/projects/p1/settings']}>
          <Routes>
            <Route
              path="/projects/p1/settings"
              element={
                <SettingsShell
                  scope="project"
                  scopeLinks={[
                    { scope: 'workspace', label: 'Workspace', to: '/settings' },
                    {
                      scope: 'program',
                      label: 'Program',
                      to: null,
                      disabledReason: 'No programs yet',
                    },
                    { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
                  ]}
                  contextName="P1"
                  navGroups={NAV_GROUPS}
                  exitTo="/projects/p1/overview"
                  exitLabel="Overview"
                >
                  <SettingsSection id="general">
                    <SettingsPageTitle title="General" />
                    <div>GENERAL_SECTION</div>
                  </SettingsSection>
                </SettingsShell>
              }
            />
          </Routes>
        </MemoryRouter>,
      );
      const program = screen.getByRole('button', { name: 'Program' });
      expect(program).toBeDisabled();
      expect(program).toHaveAttribute('title', 'No programs yet');
      fireEvent.click(program);
      expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
    });

    it('switching context while dirty routes through the confirm-discard guard', () => {
      renderWithOptions();
      act(() => registerSection({ dirty: true }));
      fireEvent.click(screen.getByRole('button', { name: /Switch project/ }));
      fireEvent.click(screen.getByRole('option', { name: /test2/ }));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });

  describe('copy-link affordance (#595)', () => {
    function withClipboard(write: ReturnType<typeof vi.fn>) {
      const original = navigator.clipboard;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: write },
      });
      return () => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: original,
        });
      };
    }

    it('renders a button with aria-label="Copy link to settings"', () => {
      renderShell();
      expect(screen.getByRole('button', { name: 'Copy link to settings' })).toBeInTheDocument();
    });

    it('clicking copies the current URL to clipboard', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const restore = withClipboard(writeText);
      try {
        renderShell();
        fireEvent.click(screen.getByRole('button', { name: 'Copy link to settings' }));
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(window.location.href);
      } finally {
        restore();
      }
    });

    it('shows a transient confirmation after click', () => {
      vi.useFakeTimers();
      const restore = withClipboard(vi.fn().mockResolvedValue(undefined));
      try {
        renderShell();
        act(() => {
          fireEvent.click(screen.getByRole('button', { name: 'Copy link to settings' }));
        });
        expect(screen.getByText('Link copied to clipboard')).toBeInTheDocument();
        act(() => {
          vi.advanceTimersByTime(1600);
        });
        expect(screen.queryByText('Link copied to clipboard')).not.toBeInTheDocument();
      } finally {
        restore();
        vi.useRealTimers();
      }
    });
  });

  describe('mobile header (#539)', () => {
    beforeEach(() => {
      mockBreakpoint = 'sm';
    });

    it('replaces the rail nav buttons with a "Jump to section" select below md:', () => {
      renderShell();
      // The rail's scroll-spy buttons are gone; sections live in the select instead.
      expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
      const jump = screen.getByLabelText('Jump to section');
      expect(jump).toBeInTheDocument();
      // The select reflects the scroll-spy active section. jsdom has no layout so
      // which inline section is active is geometry-dependent — assert it is one of
      // them, not a specific id (mirrors the "assert the count, not the id" note above).
      expect(['general', 'access']).toContain((jump as HTMLSelectElement).value);
      // Every section (inline + route-link) is reachable as an option.
      expect(screen.getByRole('option', { name: 'Access' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'System health' })).toBeInTheDocument();
    });

    it('still renders the scope switcher and copy-link exactly once', () => {
      renderShell();
      // The extracted controls render in the mobile header only — not duplicated
      // with a hidden rail (they are conditionally rendered, not CSS-hidden).
      expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy link to settings' })).toBeInTheDocument();
    });

    it('selecting an inline section scroll-spies without a route change or dirty prompt', () => {
      renderShell();
      act(() => registerSection({ dirty: true }));
      fireEvent.change(screen.getByLabelText('Jump to section'), { target: { value: 'access' } });
      // Same mounted page — no discard dialog, both sections still rendered.
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
    });

    it('selecting a route-link section while dirty routes through the confirm-discard guard', () => {
      renderShell();
      act(() => registerSection({ dirty: true }));
      fireEvent.change(screen.getByLabelText('Jump to section'), { target: { value: 'health' } });
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
    });

    // The mobile header is the only clear way out of settings on a phone — the
    // desktop Sidebar is a hidden drawer and BottomNav self-suppresses off-project
    // (issue 1709).
    it('renders a "Back to {exitLabel}" exit button in the mobile header', () => {
      renderShell();
      const exit = screen.getByRole('button', { name: 'Back to Overview' });
      expect(exit).toBeInTheDocument();
      // 44px touch target (rule 5) + rule-4/214 focus ring. Standalone trigger
      // uses focus: (not focus-visible:) so a pointer click still paints a ring
      // in Firefox/desktop Safari (WCAG 2.4.7).
      expect(exit.className).toContain('min-h-[44px]');
      expect(exit.className).toContain('focus:ring-brand-primary');
    });

    it('clicking the exit button leaves settings for the entity surface', () => {
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: 'Back to Overview' }));
      expect(screen.getByText('OVERVIEW_ROUTE')).toBeInTheDocument();
    });

    it('clicking the exit button while dirty routes through the confirm-discard guard', () => {
      renderShell();
      act(() => registerSection({ dirty: true }));
      fireEvent.click(screen.getByRole('button', { name: 'Back to Overview' }));
      // Dirty form is guarded — the discard dialog opens, no navigation yet.
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(screen.queryByText('OVERVIEW_ROUTE')).not.toBeInTheDocument();
    });

    it('does not render the exit button on desktop (rule 123 — Sidebar is the exit)', () => {
      mockBreakpoint = 'lg';
      renderShell();
      expect(screen.queryByRole('button', { name: 'Back to Overview' })).not.toBeInTheDocument();
    });
  });

  describe('saved-time footer (#596)', () => {
    it('is hidden when lastSavedAt is null', () => {
      renderShell();
      expect(screen.queryByTestId('settings-saved-footer')).not.toBeInTheDocument();
    });

    it('renders "Saved just now" right after a successful save', async () => {
      renderShell();
      const onSave = vi.fn().mockResolvedValue(undefined);
      act(() => registerSection({ dirty: true, onSave }));
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });
      act(() => registerSection({ dirty: false, onSave }));
      expect(screen.getByTestId('settings-saved-footer')).toBeInTheDocument();
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('is hidden while dirty (save bar takes the slot)', () => {
      renderShell();
      act(() => {
        registerSection({ dirty: true });
        useSettingsSaveStore.setState({ lastSavedAt: Date.now() });
      });
      expect(screen.queryByTestId('settings-saved-footer')).not.toBeInTheDocument();
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    });
  });
});

describe('section-level context-sensitive help (#2487, ADR-0682)', () => {
  it('renders a docs link for each section, resolved from the shell scope', () => {
    renderShell();

    // Neither <SettingsPageTitle> in renderShell() passes a docsHref — the shell
    // publishes scope="project" and each <SettingsSection> resolves its own slug
    // out of SETTINGS_DOCS. That indirection is the whole point of ADR-0682, so
    // asserting it here is asserting the mechanism, not just the markup.
    const general = screen.getByRole('link', { name: /Learn more about General/i });
    expect(general).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/administration/project-settings/#general',
    );

    const access = screen.getByRole('link', { name: /Learn more about Access/i });
    expect(access).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/features/settings/project-members/',
    );
  });

  it('names each link by its section so 44 links are distinguishable to a screen reader', () => {
    renderShell();

    // WCAG 2.4.4 (Link Purpose): the visible text is a terse "Learn more" on every
    // section, so the accessible name must carry the section to stay unambiguous.
    expect(
      screen.getByRole('link', { name: 'Learn more about General (opens in a new tab)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Learn more about Access (opens in a new tab)' }),
    ).toBeInTheDocument();
  });

  it('opens in a new tab without leaking the opener (rule 212)', () => {
    renderShell();

    const link = screen.getByRole('link', { name: /Learn more about General/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the link after the subtitle, inside the same paragraph', () => {
    render(
      <MemoryRouter>
        <SettingsShell
          scope="project"
          scopeLinks={SCOPE_LINKS}
          contextName="Project Atlas"
          navGroups={NAV_GROUPS}
          exitTo="/x"
          exitLabel="Overview"
        >
          <SettingsSection id="general">
            <SettingsPageTitle title="General" subtitle="Identity and defaults." />
          </SettingsSection>
        </SettingsShell>
      </MemoryRouter>,
    );

    // The link extends the descriptive sentence rather than sitting in the action
    // slot, which is what keeps 44 of them reading as prose instead of chrome.
    const link = screen.getByRole('link', { name: /Learn more about General/i });
    const para = link.closest('p');
    expect(para).not.toBeNull();
    expect(para?.textContent).toMatch(/^Identity and defaults\. Learn more/);
  });

  it('renders no link for a section with no docs mapping', () => {
    render(
      <MemoryRouter>
        <SettingsShell
          scope="project"
          scopeLinks={SCOPE_LINKS}
          contextName="Project Atlas"
          navGroups={NAV_GROUPS}
          exitTo="/x"
          exitLabel="Overview"
        >
          <SettingsSection id="not-a-real-section">
            <SettingsPageTitle title="Mystery" />
          </SettingsSection>
        </SettingsShell>
      </MemoryRouter>,
    );

    // Degrades to no affordance rather than a dead href. The coverage test in
    // settingsDocs.test.ts is what stops a real section reaching this state.
    expect(screen.queryByRole('link', { name: /Learn more about Mystery/i })).toBeNull();
  });

  it('lets a standalone tool page pass docsHref explicitly, outside any section', () => {
    render(
      <MemoryRouter>
        <SettingsPageTitle
          title="System health"
          subtitle="Component status."
          docsHref="administration/system-health/"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Learn more about System health/i })).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/administration/system-health/',
    );
  });

  it('prefers an explicit docsHref over the one resolved from context', () => {
    render(
      <MemoryRouter>
        <SettingsShell
          scope="project"
          scopeLinks={SCOPE_LINKS}
          contextName="Project Atlas"
          navGroups={NAV_GROUPS}
          exitTo="/x"
          exitLabel="Overview"
        >
          <SettingsSection id="general">
            <SettingsPageTitle title="General" docsHref="features/labels/" />
          </SettingsSection>
        </SettingsShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Learn more about General/i })).toHaveAttribute(
      'href',
      'https://docs.trueppm.com/features/labels/',
    );
  });
});

describe('<SettingsShell> rail filter (#2320)', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function filterInput() {
    return screen.getByRole('searchbox', { name: 'Filter settings sections' });
  }

  it('narrows the rail to matching sections and hides now-empty groups', () => {
    renderShell();
    fireEvent.change(filterInput(), { target: { value: 'access' } });
    expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    // The System group has no match, so its heading drops out entirely.
    expect(screen.queryByRole('button', { name: 'System health' })).not.toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
  });

  it('matches on keywords, not just the visible label', () => {
    renderShell();
    // "rbac" is a keyword on Access, not in its label.
    fireEvent.change(filterInput(), { target: { value: 'rbac' } });
    expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', () => {
    renderShell();
    fireEvent.change(filterInput(), { target: { value: 'zzzznope' } });
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
  });

  it('clears via the ✕ button and restores the full rail', () => {
    renderShell();
    fireEvent.change(filterInput(), { target: { value: 'access' } });
    expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Access' })).toBeInTheDocument();
  });

  it('Escape clears the query while it is non-empty', () => {
    renderShell();
    const input = filterInput();
    fireEvent.change(input, { target: { value: 'access' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
  });

  it('Enter jumps to the first match and clears the filter (inline section)', () => {
    renderShell();
    const input = filterInput();
    fireEvent.change(input, { target: { value: 'access' } });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    // Same mounted page (scroll-spy), filter cleared so the rail is ready again.
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('has no clear button until a query is entered', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).not.toBeInTheDocument();
    fireEvent.change(filterInput(), { target: { value: 'a' } });
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeInTheDocument();
  });

  it('is not rendered on mobile (the native jump-to-section select serves findability)', () => {
    mockBreakpoint = 'sm';
    renderShell();
    expect(
      screen.queryByRole('searchbox', { name: 'Filter settings sections' }),
    ).not.toBeInTheDocument();
  });
});

describe('<SettingsShell> route-departure affordance & scope hiding', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function renderWithNav(
    navGroups: SettingsNavGroup[],
    scopeLinks: SettingsScopeLink[],
    scope: 'workspace' | 'project' | 'program' = 'workspace',
  ) {
    return render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <SettingsShell
                scope={scope}
                scopeLinks={scopeLinks}
                contextName="Acme Inc"
                navGroups={navGroups}
                exitTo="/"
                exitLabel="Home"
              >
                <SettingsSection id="general">
                  <SettingsPageTitle title="General" />
                </SettingsSection>
              </SettingsShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  const NAV_WITH_EXTERNAL: SettingsNavGroup[] = [
    { label: 'Org', items: [{ id: 'general', label: 'General', icon: <span /> }] },
    {
      label: 'System',
      items: [
        {
          id: 'health',
          label: 'System health',
          to: '/settings/health',
          external: true,
          icon: <span />,
        },
      ],
    },
  ];

  it('renders a ↗ affordance on a route-departure (external) rail item but not on an inline item (#2252)', () => {
    renderWithNav(NAV_WITH_EXTERNAL, [{ scope: 'workspace', label: 'Workspace', to: '/settings' }]);
    // The inline section button has only its (span) icon — no svg.
    const inline = screen.getByRole('button', { name: 'General' });
    expect(inline.querySelector('svg')).toBeNull();
    // The external tool-page button carries the trailing ↗ svg (aria-hidden, so
    // the accessible name is unchanged — still just "System health").
    const external = screen.getByRole('button', { name: 'System health' });
    expect(external.querySelector('svg')).not.toBeNull();
  });

  it('hides scope segments flagged hidden and collapses a sole scope to a static label (#2251)', () => {
    renderWithNav(NAV_WITH_EXTERNAL, [
      { scope: 'workspace', label: 'Workspace', to: '/settings' },
      { scope: 'program', label: 'Program', to: null, hidden: true },
      { scope: 'project', label: 'Project', to: null, hidden: true },
    ]);
    // The inapplicable scopes are gone entirely — not rendered disabled.
    expect(screen.queryByRole('button', { name: 'Program' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument();
    // The lone remaining scope is a static label, not a one-item tablist button.
    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('keeps a not-yet scope disabled (with its reason) rather than hiding it (#2251)', () => {
    renderWithNav(NAV_WITH_EXTERNAL, [
      { scope: 'workspace', label: 'Workspace', to: '/settings' },
      {
        scope: 'program',
        label: 'Program',
        to: null,
        disabledReason: 'Scoped settings appear once you create a program',
      },
      { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
    ]);
    const program = screen.getByRole('button', { name: 'Program' });
    expect(program).toBeDisabled();
    expect(program).toHaveAttribute('title', 'Scoped settings appear once you create a program');
    // Three visible segments still render (workspace static-active, program disabled, project enabled).
    expect(screen.getByRole('button', { name: 'Project' })).toBeEnabled();
  });
});

describe('<SettingsShell> heading & region structure (#2204)', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  it('renders exactly one page <h1> — the shell owns it (WCAG 1.3.1 / 2.4.6)', () => {
    // The consolidated page previously rendered one <h1> per section; the shell now
    // owns the single page heading and each section title is an <h2>.
    renderShell();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('demotes each section title strip to <h2>', () => {
    renderShell();
    const h2Text = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(h2Text).toContain('General');
    expect(h2Text).toContain('Access');
    // The old per-section <h1> title strips must be gone.
    const h1Text = screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent);
    expect(h1Text).not.toContain('General');
  });

  it('names each section region by its heading, not the raw slug', () => {
    renderShell();
    // aria-labelledby points at the <h2>, so the region announces "General", never
    // the verbatim slug "general".
    expect(screen.getByRole('region', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Access' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'general' })).not.toBeInTheDocument();
  });
});

describe('<FieldRow> aria-describedby wiring (web-rule 269, #2266)', () => {
  it('gives the hint a stable id and forwards it so the control describes by it', () => {
    render(
      <FieldRow label="Default timezone" hint="Used for due dates.">
        {({ describedBy }) => (
          <input aria-label="Default timezone" aria-describedby={describedBy} />
        )}
      </FieldRow>,
    );
    const input = screen.getByLabelText('Default timezone');
    const hint = screen.getByText('Used for due dates.');
    // The generated hint id must be present and be exactly what the control
    // points its aria-describedby at — otherwise the hint is orphaned text.
    expect(hint.id).toBeTruthy();
    expect(input).toHaveAttribute('aria-describedby', hint.id);
  });

  it('joins hint and error ids into describedBy, in that order', () => {
    render(
      <FieldRow label="Port" hint="Usually 587." error="Port is required">
        {({ describedBy }) => <input aria-label="Port" aria-describedby={describedBy} />}
      </FieldRow>,
    );
    const input = screen.getByLabelText('Port');
    const hint = screen.getByText('Usually 587.');
    const error = screen.getByRole('alert');
    expect(input).toHaveAttribute('aria-describedby', `${hint.id} ${error.id}`);
  });

  it('leaves describedBy undefined when the row has neither hint nor error', () => {
    render(
      <FieldRow label="Bare">
        {({ describedBy }) => <input aria-label="Bare" aria-describedby={describedBy} />}
      </FieldRow>,
    );
    // No hint, no error → nothing to describe by; the attribute must be absent,
    // never an empty string that points a screen reader at nothing.
    expect(screen.getByLabelText('Bare')).not.toHaveAttribute('aria-describedby');
  });

  it('honors an explicit errorId prop over the generated one', () => {
    render(
      <FieldRow label="Host" error="Host is required" errorId="host-err">
        {({ errorId }) => <input aria-label="Host" aria-describedby={errorId} />}
      </FieldRow>,
    );
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'host-err');
    expect(screen.getByLabelText('Host')).toHaveAttribute('aria-describedby', 'host-err');
  });

  it('still renders a plain-node child unchanged (backward compatible)', () => {
    render(
      <FieldRow label="Name" hint="Shown everywhere.">
        <input aria-label="Name" />
      </FieldRow>,
    );
    // Legacy callers pass JSX, not a function — the row must render it as-is.
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByText('Shown everywhere.')).toBeInTheDocument();
  });

  it('renders an optional help slot in the label row (#2266)', () => {
    render(
      <FieldRow label="Methodology" hint="Planning model." help={<button>ⓘ help</button>}>
        <input aria-label="Methodology" />
      </FieldRow>,
    );
    // The help affordance (a shared FieldHelp ⓘ, web-rule 263) sits beside the
    // label; the hint remains the aria-describedby target and is unaffected.
    expect(screen.getByRole('button', { name: 'ⓘ help' })).toBeInTheDocument();
    expect(screen.getByText('Planning model.')).toBeInTheDocument();
  });

  it('renders no help node when the slot is omitted (backward compatible)', () => {
    render(
      <FieldRow label="Name">
        <input aria-label="Name" />
      </FieldRow>,
    );
    // The ~100 existing call sites pass no `help` — the label row is unchanged.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});

describe('<SettingsShell> unload & keyboard guards', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  /** Dispatch a cancelable beforeunload and report whether the shell blocked it. */
  function unloadBlocked(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('blocks a browser unload only while a section is dirty', () => {
    renderShell();
    expect(unloadBlocked()).toBe(false);
    act(() => registerSection({ dirty: true }));
    expect(unloadBlocked()).toBe(true);
    // Going clean again releases the guard — no phantom "leave site?" prompt.
    act(() => registerSection({ dirty: false }));
    expect(unloadBlocked()).toBe(false);
  });

  it('releases the unload guard while a save is in flight', () => {
    // The leave prompt must not interrupt the in-flight PATCH (the save is what
    // resolves the dirty state, so prompting here would fight the fix).
    renderShell();
    act(() => {
      registerSection({ dirty: true });
      useSettingsSaveStore.setState({ isSaving: true });
    });
    expect(unloadBlocked()).toBe(false);
  });

  it('ignores keypresses that are not Ctrl/Cmd+S', () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => registerSection({ dirty: true, onSave }));
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    fireEvent.keyDown(window, { key: 's' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('accepts Cmd+Shift-style uppercase S with the meta modifier', () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => registerSection({ dirty: true, onSave }));
    act(() => {
      fireEvent.keyDown(window, { key: 'S', metaKey: true });
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('<SettingsShell> in-flight save state', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function startSaving() {
    act(() => {
      registerSection({ dirty: true });
      useSettingsSaveStore.setState({ isSaving: true });
    });
  }

  it('shows "Saving…" and disables both save-bar buttons while in flight', () => {
    renderShell();
    startSaving();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^discard$/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('navigates straight through the dirty guard while a save is in flight', () => {
    // The edits are already on their way to the server, so there is nothing to
    // lose — prompting here would strand the user mid-save.
    renderShell();
    startSaving();
    fireEvent.click(screen.getByRole('button', { name: 'System health' }));
    expect(screen.getByText('HEALTH_ROUTE')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe('<SettingsShell> discard with no navigation target', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  it('discards the edits and stays put when the guarded target is empty', () => {
    const onReset = vi.fn();
    render(
      <MemoryRouter initialEntries={['/projects/p1/settings']}>
        <Routes>
          <Route
            path="/projects/p1/settings"
            element={
              <SettingsShell
                scope="project"
                scopeLinks={[
                  // A scope link whose target has not resolved to a real path yet.
                  { scope: 'workspace', label: 'Workspace', to: '' },
                  { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
                ]}
                contextName="P1"
                navGroups={NAV_GROUPS}
                exitTo="/projects/p1/overview"
                exitLabel="Overview"
              >
                <SettingsSection id="general">
                  <SettingsPageTitle title="General" />
                  <div>GENERAL_SECTION</div>
                </SettingsSection>
              </SettingsShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    act(() => registerSection({ dirty: true, onReset }));
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    // No route to go to, so the page stays mounted rather than blanking out.
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
  });
});

describe('<SettingsShell> rail filter — route departures & no-match Enter', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function filterInput() {
    return screen.getByRole('searchbox', { name: 'Filter settings sections' });
  }

  it('Enter on a route-departure match navigates to the tool page', () => {
    renderShell();
    fireEvent.change(filterInput(), { target: { value: 'system health' } });
    act(() => {
      fireEvent.keyDown(filterInput(), { key: 'Enter' });
    });
    expect(screen.getByText('HEALTH_ROUTE')).toBeInTheDocument();
  });

  it('Enter on a route-departure match while dirty routes through the discard guard', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    fireEvent.change(filterInput(), { target: { value: 'system health' } });
    act(() => {
      fireEvent.keyDown(filterInput(), { key: 'Enter' });
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('HEALTH_ROUTE')).not.toBeInTheDocument();
  });

  it('Enter with no match is a no-op that keeps the query and the empty state', () => {
    renderShell();
    fireEvent.change(filterInput(), { target: { value: 'zzzznope' } });
    act(() => {
      fireEvent.keyDown(filterInput(), { key: 'Enter' });
    });
    expect(screen.getByLabelText<HTMLInputElement>('Filter settings sections').value).toBe(
      'zzzznope',
    );
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('lets Escape bubble when the filter is already empty (nothing to clear)', () => {
    renderShell();
    const escape = createEvent.keyDown(filterInput(), { key: 'Escape' });
    fireEvent(filterInput(), escape);
    // An empty field must not swallow Escape — a parent dismiss handler owns it.
    expect(escape.defaultPrevented).toBe(false);
  });

  it('leaves other keys alone so normal typing still reaches the field', () => {
    renderShell();
    const arrow = createEvent.keyDown(filterInput(), { key: 'ArrowDown' });
    fireEvent(filterInput(), arrow);
    expect(arrow.defaultPrevented).toBe(false);
  });
});

describe('<SettingsShell> scope switcher edge states', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function renderScope(
    scope: 'workspace' | 'project' | 'program',
    scopeLinks: SettingsScopeLink[],
    contextName = 'Acme Inc',
  ) {
    return render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path="/settings"
            element={
              <SettingsShell
                scope={scope}
                scopeLinks={scopeLinks}
                contextName={contextName}
                navGroups={NAV_GROUPS}
                exitTo="/"
                exitLabel="Home"
              >
                <SettingsSection id="general">
                  <SettingsPageTitle title="General" />
                  <div>GENERAL_SECTION</div>
                </SettingsSection>
              </SettingsShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('falls back to the current scope as a static label when every segment is hidden', () => {
    renderScope('workspace', [
      { scope: 'workspace', label: 'Workspace', to: '/settings', hidden: true },
      { scope: 'project', label: 'Project', to: null, hidden: true },
      { scope: 'program', label: 'Program', to: null, hidden: true },
    ]);
    // Nothing is navigable, so the switcher degrades to an identity label rather
    // than rendering an empty control.
    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('does nothing when the active scope segment has no target of its own', () => {
    renderScope('program', [
      { scope: 'workspace', label: 'Workspace', to: '/settings' },
      // The scope you are already on, with no self-link.
      { scope: 'program', label: 'Program', to: null },
      { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
    ]);
    const program = screen.getByRole('button', { name: 'Program' });
    // Active segments are never disabled, so the click must be a safe no-op.
    expect(program).toBeEnabled();
    fireEvent.click(program);
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
  });

  it('falls back to the bare scope heading when there is no context name', () => {
    renderScope('program', [{ scope: 'program', label: 'Program', to: '/settings' }], '');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Program settings');
  });

  it('prefixes the scope heading with the context name when there is one', () => {
    renderScope('program', [{ scope: 'program', label: 'Program', to: '/settings' }], 'Apollo');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Program settings: Apollo');
  });
});

describe('<SettingsShell> mobile jump-to-section edges (#539)', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'sm';
  });

  it('ignores a change to an id that is not in the nav', () => {
    renderShell();
    act(() => registerSection({ dirty: true }));
    fireEvent.change(screen.getByLabelText('Jump to section'), { target: { value: '' } });
    // No section matched, so nothing navigates and the dirty guard stays quiet.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
  });

  it('still renders a usable select on a tool page with no inline sections', () => {
    render(
      <MemoryRouter initialEntries={['/settings/elsewhere']}>
        <Routes>
          <Route
            path="/settings/elsewhere"
            element={
              <SettingsShell
                scope="workspace"
                scopeLinks={SCOPE_LINKS}
                contextName="Acme"
                navGroups={[
                  {
                    label: 'System',
                    items: [
                      {
                        id: 'health',
                        label: 'System health',
                        to: '/settings/health',
                        external: true,
                        icon: <span />,
                      },
                      {
                        id: 'trash',
                        label: 'Trash',
                        to: '/settings/trash',
                        external: true,
                        icon: <span />,
                      },
                    ],
                  },
                ]}
                exitTo="/"
                exitLabel="Home"
              >
                <div>TOOL_PAGE</div>
              </SettingsShell>
            }
          />
          <Route path="/settings/trash" element={<div>TRASH_ROUTE</div>} />
        </Routes>
      </MemoryRouter>,
    );
    // Neither scroll-spy (there are no inline sections) nor the pathname (which
    // matches no route item) names an active item, so the select falls back to
    // the native first-option default — and every tool stays reachable from it.
    const jump = screen.getByLabelText<HTMLSelectElement>('Jump to section');
    expect(jump.value).toBe('health');
    fireEvent.change(jump, { target: { value: 'trash' } });
    expect(screen.getByText('TRASH_ROUTE')).toBeInTheDocument();
  });
});

describe('<SettingsShell> deferred effects', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  /** Single-section shell so the deep-link frame is not pre-empted by a re-render. */
  function renderSingleSection(hash: string) {
    return render(
      <MemoryRouter initialEntries={[`/projects/p1/settings${hash}`]}>
        <Routes>
          <Route
            path="/projects/p1/settings"
            element={
              <SettingsShell
                scope="project"
                scopeLinks={SCOPE_LINKS}
                contextName="Project Atlas"
                navGroups={[
                  { label: 'Setup', items: [{ id: 'general', label: 'General', icon: <span /> }] },
                ]}
                exitTo="/projects/p1/overview"
                exitLabel="Overview"
              >
                <SettingsSection id="general">
                  <SettingsPageTitle title="General" />
                  <div>GENERAL_SECTION</div>
                </SettingsSection>
              </SettingsShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('scrolls to the hash section on mount and moves focus into its heading', async () => {
    renderSingleSection('#general');
    // The deep-link scroll is deferred to the next frame so the sections are laid
    // out before it measures; focus lands on the heading so keyboard/SR users
    // arrive inside the section, not at the top of the page.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'General' }));
  });

  it('does not move focus when the URL carries no hash at all', async () => {
    renderSingleSection('');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('does not move focus for a hash that names no inline section', async () => {
    renderShell(['/projects/p1/settings#not-a-section']);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(document.activeElement).toBe(document.body);
  });

  it('re-renders the saved footer as the elapsed time grows', () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date('2026-07-27T10:00:00Z').getTime();
      vi.setSystemTime(t0);
      renderShell();
      act(() => {
        useSettingsSaveStore.setState({ lastSavedAt: t0 });
      });
      expect(screen.getByText('just now')).toBeInTheDocument();
      act(() => {
        vi.setSystemTime(t0 + 120_000);
        vi.advanceTimersByTime(30_000);
      });
      // Without the ticker the footer would still read "just now" two minutes on.
      expect(screen.getByText('2m ago')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts the copy confirmation timer on a second click', () => {
    vi.useFakeTimers();
    const original = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined) },
    });
    try {
      renderShell();
      const copy = () => {
        act(() => {
          fireEvent.click(screen.getByRole('button', { name: 'Copy link to settings' }));
        });
      };
      const tick = (ms: number) => {
        act(() => {
          vi.advanceTimersByTime(ms);
        });
      };
      copy();
      tick(1000);
      copy();
      // 2000ms after the first click the original 1500ms timer would have fired;
      // the second click must have cleared it rather than letting it win.
      tick(1000);
      expect(screen.getByText('Link copied to clipboard')).toBeInTheDocument();
      tick(600);
      expect(screen.queryByText('Link copied to clipboard')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: original });
      vi.useRealTimers();
    }
  });
});

describe('<SettingsPageTitle>', () => {
  it('renders the count, subtitle and action slots when supplied', () => {
    render(
      <SettingsPageTitle
        title="Members"
        subtitle="Who can see this project."
        count={12}
        action={<button type="button">Invite</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Members12');
    expect(screen.getByText('Who can see this project.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });

  it('renders a bare title strip when the optional slots are omitted', () => {
    render(<SettingsPageTitle title="Retention" />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Retention');
    expect(screen.queryByRole('button')).toBeNull();
    // Outside a <SettingsSection> there is no region to label, so no id is stamped.
    expect(heading).not.toHaveAttribute('id');
  });

  it('stamps the region heading id when mounted inside a <SettingsSection>', () => {
    render(
      <SettingsSection id="general">
        <SettingsPageTitle title="General" />
      </SettingsSection>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'General' });
    expect(heading).toHaveAttribute('id', 'settings-heading-general');
    // …and the region really is named by it, not by the raw slug.
    expect(screen.getByRole('region', { name: 'General' })).toBeInTheDocument();
  });
});

describe('<SettingsPageTitle> embedded blocks (#2969)', () => {
  it('drops to an h3 and claims neither the region heading id nor its docs slug', () => {
    // The failure this locks out is a duplicate DOM id, which nothing else sees:
    // `settingsHeadingId()` is minted from the SECTION id, so a second unqualified
    // title strip under one section stamps the same id twice and the region's
    // aria-labelledby silently resolves to whichever the parser met first.
    render(
      <SettingsSection id="how-this-team-works">
        <SettingsPageTitle title="How this team works" />
        <SettingsPageTitle embedded title="Methodology" />
        <SettingsPageTitle embedded title="Workflow & fields" />
      </SettingsSection>,
    );

    const section = screen.getByRole('heading', { level: 2, name: 'How this team works' });
    expect(section).toHaveAttribute('id', 'settings-heading-how-this-team-works');

    const blocks = screen.getAllByRole('heading', { level: 3 });
    expect(blocks.map((h) => h.textContent)).toEqual(['Methodology', 'Workflow & fields']);
    for (const h of blocks) expect(h).not.toHaveAttribute('id');

    // Exactly one node carries the id, so the region is unambiguously named.
    expect(
      document.querySelectorAll('#settings-heading-how-this-team-works'),
    ).toHaveLength(1);
    // And exactly one scroll-spy focus target, or keyboard rail nav lands on a
    // block instead of the section it activated.
    expect(document.querySelectorAll('[data-settings-section-heading]')).toHaveLength(1);
  });
});

describe('<SettingsShell> retired anchor aliases (#2969)', () => {
  function HashProbe() {
    const { hash } = useLocation();
    return <div data-testid="probe-hash">{hash}</div>;
  }

  function renderAliased(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/projects/p1/settings"
            element={
              <SettingsShell
                scope="project"
                scopeLinks={SCOPE_LINKS}
                contextName="Project Atlas"
                navGroups={NAV_GROUPS}
                anchorAliases={{ methodology: 'general', workflow: 'general' }}
                exitTo="/projects/p1/overview"
                exitLabel="Overview"
              >
                <HashProbe />
                <SettingsSection id="general">
                  <SettingsPageTitle title="General" />
                </SettingsSection>
                <SettingsSection id="access">
                  <SettingsPageTitle title="Access" />
                </SettingsSection>
              </SettingsShell>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('rewrites a retired hash to the section that absorbed it', () => {
    renderAliased('/projects/p1/settings#methodology');
    expect(screen.getByTestId('probe-hash')).toHaveTextContent('#general');
  });

  it('leaves a live hash alone', () => {
    renderAliased('/projects/p1/settings#access');
    expect(screen.getByTestId('probe-hash')).toHaveTextContent('#access');
  });

  it('leaves an unmapped unknown hash alone rather than guessing a destination', () => {
    // A hash nobody declared is not the same as a retired one. Sending it
    // somewhere plausible would make a typo look like a working deep link.
    renderAliased('/projects/p1/settings#not-a-section');
    expect(screen.getByTestId('probe-hash')).toHaveTextContent('#not-a-section');
  });
});

describe('<SettingsCard>', () => {
  it('renders its children inside a raised card', () => {
    render(
      <SettingsCard>
        <p>CARD_BODY</p>
      </SettingsCard>,
    );
    const card = screen.getByText('CARD_BODY').parentElement;
    expect(card?.className).toContain('bg-neutral-surface-raised');
    expect(card?.className).toContain('rounded-card');
  });

  it('appends a caller className without dropping the base card styling', () => {
    render(
      <SettingsCard className="mt-4">
        <p>CARD_BODY</p>
      </SettingsCard>,
    );
    const card = screen.getByText('CARD_BODY').parentElement;
    expect(card?.className).toContain('mt-4');
    expect(card?.className).toContain('rounded-card');
  });
});
