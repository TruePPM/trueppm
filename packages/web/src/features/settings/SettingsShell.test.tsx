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
      </Routes>
    </MemoryRouter>,
  );
}

describe('<SettingsShell>', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
  });

  it('mounts every section at once on one scrolling page', () => {
    renderShell();
    // Both sections are present simultaneously — no route swap between them.
    expect(screen.getByText('GENERAL_SECTION')).toBeInTheDocument();
    expect(screen.getByText('ACCESS_SECTION')).toBeInTheDocument();
  });

  it('reserves the scrollbar gutter on the content panel to prevent layout shift (#776)', () => {
    renderShell();
    const scroll = screen.getByTestId('settings-content-scroll');
    expect(scroll.className).toContain('[scrollbar-gutter:stable]');
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
