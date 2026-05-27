import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SettingsShell, type SettingsNavGroup, type SettingsScopeLink } from './SettingsShell';
import { useSettingsSaveStore } from './hooks/useSettingsSaveStore';

const NAV_GROUPS: SettingsNavGroup[] = [
  {
    label: 'Setup',
    items: [
      { id: 'general', label: 'General', to: '/projects/p1/settings/general', icon: <span /> },
      { id: 'access',  label: 'Access',  to: '/projects/p1/settings/access',  icon: <span /> },
    ],
  },
];

const SCOPE_LINKS: SettingsScopeLink[] = [
  { scope: 'workspace', label: 'Workspace', to: '/settings/general' },
  { scope: 'project',   label: 'Project',   to: '/projects/p1/settings/general' },
  { scope: 'program',   label: 'Program',   to: '/programs/x/settings/general' },
];

function renderShell(initialEntries: string[] = ['/projects/p1/settings/general']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route
          path="/projects/p1/settings/*"
          element={
            <SettingsShell
              scope="project"
              scopeLinks={SCOPE_LINKS}
              contextName="Project Atlas"
              navGroups={NAV_GROUPS}
            />
          }
        >
          <Route path="general" element={<div>GENERAL_PAGE</div>} />
          <Route path="access"  element={<div>ACCESS_PAGE</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('<SettingsShell>', () => {
  beforeEach(() => {
    useSettingsSaveStore.getState().reset();
  });

  it('reserves the scrollbar gutter on the content panel to prevent layout shift (#776)', () => {
    renderShell();
    // The shared shell swaps only the <Outlet> content between sub-pages; the
    // scroll container persists. scrollbar-gutter:stable keeps the scrollbar
    // track reserved so a tall page (General) and a short page (Projects) render
    // at the same width — no horizontal jump on navigation. jsdom applies no CSS,
    // so we assert the utility is present rather than the computed style (the
    // computed-style check lives in the Playwright e2e spec).
    const scroll = screen.getByTestId('settings-content-scroll');
    expect(scroll.className).toContain('[scrollbar-gutter:stable]');
  });

  it('hides the save bar when not dirty', () => {
    renderShell();
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });

  it('renders the save bar when dirty', () => {
    renderShell();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset: vi.fn(),
      });
    });
    expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
  });

  it('clicking Save triggers the registered onSave', async () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave,
        onReset: vi.fn(),
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      // Yield to the microtask queue so the store's `triggerSave` promise settles
      // before we assert. Without an explicit await the linter (correctly) flags
      // the async arrow as redundant; the await is needed for the assertion timing.
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('clicking Discard triggers the registered onReset', () => {
    renderShell();
    const onReset = vi.fn();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows the save error in place of the unsaved-changes label when saveError is set', () => {
    renderShell();
    act(() => {
      useSettingsSaveStore.setState({
        dirty: true,
        apiReady: true,
        onSave: vi.fn(),
        onReset: vi.fn(),
        saveError: 'Network down',
      });
    });
    expect(screen.getByText('Network down')).toBeInTheDocument();
    expect(screen.queryByText('You have unsaved changes')).not.toBeInTheDocument();
  });

  it('clicking a nav item with no dirty state navigates immediately', () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /access/i }));
    expect(screen.getByText('ACCESS_PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('clicking a nav item while dirty opens the confirm-discard dialog', () => {
    renderShell();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset: vi.fn(),
      });
    });
    fireEvent.click(screen.getByRole('link', { name: /access/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // Page has NOT navigated yet
    expect(screen.getByText('GENERAL_PAGE')).toBeInTheDocument();
  });

  it('"Keep editing" closes the dialog without navigating', () => {
    renderShell();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset: vi.fn(),
      });
    });
    fireEvent.click(screen.getByRole('link', { name: /access/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('GENERAL_PAGE')).toBeInTheDocument();
  });

  it('"Discard changes" closes the dialog, calls onReset, and navigates', () => {
    renderShell();
    const onReset = vi.fn();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset,
      });
    });
    fireEvent.click(screen.getByRole('link', { name: /access/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ACCESS_PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('scope switcher button while dirty also triggers the dialog', () => {
    renderShell();
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave: vi.fn().mockResolvedValue(undefined),
        onReset: vi.fn(),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('Ctrl+S triggers save when dirty', async () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: true,
        apiReady: true,
        onSave,
        onReset: vi.fn(),
      });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S is a noop when not dirty', () => {
    renderShell();
    const onSave = vi.fn().mockResolvedValue(undefined);
    // Note: register with dirty=false means the keydown effect is skipped
    act(() => {
      useSettingsSaveStore.getState().register({
        dirty: false,
        apiReady: true,
        onSave,
        onReset: vi.fn(),
      });
    });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(onSave).not.toHaveBeenCalled();
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
      act(() => {
        useSettingsSaveStore.getState().register({
          dirty: true,
          apiReady: true,
          onSave,
          onReset: vi.fn(),
        });
      });
      // Trigger save → store stamps lastSavedAt. Then simulate the page going
      // clean by re-registering with dirty=false (mirrors useDirtyForm after
      // the parent component refreshes its initialValues snapshot).
      await act(async () => {
        await useSettingsSaveStore.getState().triggerSave();
      });
      act(() => {
        useSettingsSaveStore.getState().register({
          dirty: false,
          apiReady: true,
          onSave,
          onReset: vi.fn(),
        });
      });
      expect(screen.getByTestId('settings-saved-footer')).toBeInTheDocument();
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('is hidden while dirty (save bar takes the slot)', () => {
      renderShell();
      act(() => {
        useSettingsSaveStore.setState({
          dirty: true,
          apiReady: true,
          onSave: vi.fn(),
          onReset: vi.fn(),
          lastSavedAt: Date.now(),
        });
      });
      expect(screen.queryByTestId('settings-saved-footer')).not.toBeInTheDocument();
      expect(screen.getByText('You have unsaved changes')).toBeInTheDocument();
    });
  });
});
