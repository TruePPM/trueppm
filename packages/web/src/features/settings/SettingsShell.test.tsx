import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import {
  SettingsShell,
  SettingsSection,
  SettingsPageTitle,
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
      { id: 'access', label: 'Access', icon: <span /> },
    ],
  },
  {
    label: 'System',
    items: [{ id: 'health', label: 'System health', to: '/settings/health', icon: <span /> }],
  },
];

const SCOPE_LINKS: SettingsScopeLink[] = [
  { scope: 'workspace', label: 'Workspace', to: '/settings' },
  { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
  { scope: 'program', label: 'Program', to: '/programs/x/settings' },
];

function registerSection(
  opts: Partial<{ dirty: boolean; apiReady: boolean; onSave: () => Promise<void> | void; onReset: () => void }> = {},
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
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('[data-settings-section]'),
    );
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

  it('inline nav click does NOT trip the dirty guard (same page can\'t lose edits)', () => {
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
      expect(screen.getByRole('button', { name: 'Trash' })).toHaveAttribute(
        'aria-current',
        'page',
      );
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
                    { scope: 'program', label: 'Program', to: null, disabledReason: 'No programs yet' },
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
      // 44px touch target (rule 5) + rule-4 focus ring.
      expect(exit.className).toContain('min-h-[44px]');
      expect(exit.className).toContain('focus-visible:ring-brand-primary');
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

describe('<SettingsShell> route-departure affordance & scope hiding', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
    mockBreakpoint = 'lg';
  });

  function renderWithNav(navGroups: SettingsNavGroup[], scopeLinks: SettingsScopeLink[], scope: 'workspace' | 'project' | 'program' = 'workspace') {
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
      items: [{ id: 'health', label: 'System health', to: '/settings/health', external: true, icon: <span /> }],
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
      { scope: 'program', label: 'Program', to: null, disabledReason: 'Scoped settings appear once you create a program' },
      { scope: 'project', label: 'Project', to: '/projects/p1/settings' },
    ]);
    const program = screen.getByRole('button', { name: 'Program' });
    expect(program).toBeDisabled();
    expect(program).toHaveAttribute('title', 'Scoped settings appear once you create a program');
    // Three visible segments still render (workspace static-active, program disabled, project enabled).
    expect(screen.getByRole('button', { name: 'Project' })).toBeEnabled();
  });
});
