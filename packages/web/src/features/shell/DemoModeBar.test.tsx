import { screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProvidersAndRouter as render } from '@/test/utils';
import { DemoModeBar } from './DemoModeBar';
import { useDemoTipsStore } from '@/stores/demoTipsStore';
import { DEMO_TIPS_KEY } from './demoTips';

const demoMode = vi.hoisted(() => ({
  value: {
    isDemoReadOnly: false,
    loginHint: null as { username: string; password: string } | null,
    resetSchedule: null as string | null,
    isLoading: false,
  },
}));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode.value }));

// The switcher and the forecast chip are route- and data-driven and have their
// own coverage; this file is about the BAR — its single row, its height, its
// disclosure, and the hint. Stubbing them keeps a failure here pointing at the
// bar rather than at a project fixture.
vi.mock('./DemoProjectSwitcher', () => ({
  DemoProjectSwitcher: () => <span data-testid="switcher-stub" />,
}));
vi.mock('./DemoForecastChip', () => ({
  DemoForecastChip: () => <span data-testid="forecast-stub" />,
}));

function asDemo() {
  demoMode.value = { isDemoReadOnly: true, loginHint: null, resetSchedule: null, isLoading: false };
}

describe('DemoModeBar', () => {
  beforeEach(() => {
    demoMode.value = {
      isDemoReadOnly: false,
      loginHint: null,
      resetSchedule: null,
      isLoading: false,
    };
    window.localStorage.clear();
    useDemoTipsStore.setState({ state: 'step1', target: null, authorRequest: 0 });
  });

  it('renders nothing on a normal install', () => {
    const { container } = render(<DemoModeBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the edition query is unsettled', () => {
    // No flash of a banner the next tick takes back.
    demoMode.value = { isDemoReadOnly: true, loginHint: null, resetSchedule: null, isLoading: true };
    const { container } = render(<DemoModeBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the mode, and carries the consequence without spending a line on it', () => {
    asDemo();
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('Read-only demo');
    // The sentence that used to occupy a whole second line of chrome. It is not
    // deleted — it is one hover or focus away, which is the trade #4050 makes.
    expect(screen.getByTitle(/nothing you change here is saved/i)).toBeInTheDocument();
  });

  it('is one row — the five strips are gone, not stacked inside it', () => {
    asDemo();
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    // 44px desktop / 48px phone, and `flex-nowrap` so the hint truncates rather
    // than wrapping the bar onto a second line and moving the Gantt under the
    // pointer. Asserted as classes because jsdom has no layout.
    expect(bar.className).toContain('h-11');
    expect(bar.className).toContain('flex-nowrap');
  });

  it('carries no live region — the bar never changes during a session', () => {
    asDemo();
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar.tagName).toBe('ASIDE');
    expect(bar).not.toHaveAttribute('aria-live');
    expect(bar).not.toHaveAttribute('role');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the edition disclosure and drops the Enterprise feature list (#3968, #4050)', () => {
    asDemo();
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('Community edition');
    const link = screen.getByRole('link', { name: "What's included" });
    expect(link).toHaveAttribute('href', 'https://docs.trueppm.com/overview/#open-core-model');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    // The sell is gone: naming the paid features on a landing screen is the
    // premature-upsell CLAUDE.md rules out, and the link answers the same
    // question without making the claim.
    expect(bar).not.toHaveTextContent(/Portfolio dashboard/);
    expect(bar).not.toHaveTextContent(/Enterprise/);
  });

  it('renders no edition disclosure on a normal install', () => {
    render(<DemoModeBar />);
    expect(screen.queryByRole('link', { name: "What's included" })).toBeNull();
  });
});

describe('DemoModeBar — reset schedule (#4152)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useDemoTipsStore.setState({ state: 'step1', target: null, authorRequest: 0 });
  });

  it('shows nothing about the reset when the server sends no schedule', () => {
    demoMode.value = {
      isDemoReadOnly: true,
      loginHint: null,
      resetSchedule: null,
      isLoading: false,
    };
    render(<DemoModeBar />);
    expect(screen.queryByText(/resets/i)).toBeNull();
  });

  it('states a simple daily cadence', () => {
    demoMode.value = {
      isDemoReadOnly: true,
      loginHint: null,
      resetSchedule: '0 8 * * *',
      isLoading: false,
    };
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('Sample data · resets daily at 08:00 UTC');
  });

  it('falls back to "resets periodically" for a non-daily cron', () => {
    demoMode.value = {
      isDemoReadOnly: true,
      loginHint: null,
      resetSchedule: '0 */6 * * *',
      isLoading: false,
    };
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('Sample data · resets periodically');
  });
});

describe('DemoModeBar — landing hint', () => {
  beforeEach(() => {
    asDemo();
    window.localStorage.clear();
    useDemoTipsStore.setState({ state: 'step1', target: null, authorRequest: 0 });
  });

  it('is a note, never focusable, and never a live region', () => {
    render(<DemoModeBar />);
    const note = screen.getByRole('note', { name: 'Demo tips' });
    expect(note).not.toHaveAttribute('tabindex');
    expect(note).not.toHaveAttribute('aria-live');
  });

  it('names the task the Schedule published, and says to switch to Author first', () => {
    useDemoTipsStore.setState({ target: { id: 't1', name: 'Performance tuning' } });
    render(<DemoModeBar />);
    const note = screen.getByRole('note', { name: 'Demo tips' });
    // The copy resolves A6's conflict: the demo lands in Read, so "Drag ‹task›"
    // alone would be an instruction the landing state refuses.
    expect(note).toHaveTextContent('Switch to Author and drag Performance tuning 2 days right');
    expect(screen.getByTestId('demo-tips-try')).toBeInTheDocument();
  });

  it('"Try it" raises a request for the Schedule rather than flipping a mode itself', () => {
    render(<DemoModeBar />);
    fireEvent.click(screen.getByTestId('demo-tips-try'));
    expect(useDemoTipsStore.getState().authorRequest).toBe(1);
    // Twice must re-fire — the second press re-scrolls to the bar.
    fireEvent.click(screen.getByTestId('demo-tips-try'));
    expect(useDemoTipsStore.getState().authorRequest).toBe(2);
  });

  it('× dismisses both steps, Tips restores them, and the bar keeps its height', () => {
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    const before = bar.className;

    fireEvent.click(screen.getByTestId('demo-tips-dismiss'));
    expect(screen.queryByRole('note', { name: 'Demo tips' })).toBeNull();
    expect(window.localStorage.getItem(DEMO_TIPS_KEY)).toBe('dismissed');
    expect(bar.className).toBe(before);

    fireEvent.click(screen.getByTestId('demo-tips-restore'));
    expect(screen.getByRole('note', { name: 'Demo tips' })).toHaveAttribute('data-step', '1');
    expect(bar.className).toBe(before);
  });

  it('shows step 2 once a real drag has advanced it', () => {
    useDemoTipsStore.getState().advanceAfterDrag();
    render(<DemoModeBar />);
    const note = screen.getByRole('note', { name: 'Demo tips' });
    expect(note).toHaveAttribute('data-step', '2');
    expect(note).toHaveTextContent('Open Forecast');
    // Step 2 has no "Try it" — the chip beside it IS the affordance.
    expect(screen.queryByTestId('demo-tips-try')).toBeNull();
  });

  it('a visitor who finished step 2 and dismissed does not get step 1 back next load', () => {
    useDemoTipsStore.getState().advanceAfterDrag();
    useDemoTipsStore.getState().dismiss();
    // `done`, not `dismissed`: restoring later must not re-run a walkthrough
    // somebody completed.
    expect(window.localStorage.getItem(DEMO_TIPS_KEY)).toBe('done');
  });
});
