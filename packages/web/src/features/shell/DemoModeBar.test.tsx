import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders as render } from '@/test/utils';
import { DemoModeBar } from './DemoModeBar';

const demoMode = vi.hoisted(() => ({
  value: { isDemoReadOnly: false, loginHint: null, isLoading: false },
}));
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode.value }));

describe('DemoModeBar', () => {
  beforeEach(() => {
    demoMode.value = { isDemoReadOnly: false, loginHint: null, isLoading: false };
  });

  it('renders nothing on a normal install', () => {
    const { container } = render(<DemoModeBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the edition query is unsettled', () => {
    // No flash of a banner the next tick takes back.
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: true };
    const { container } = render(<DemoModeBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('states the mode with its exact base sentence', () => {
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('Read-only demo — nothing you change here is saved.');
    // The pitch half is in the SAME text node, hidden below md visually only, so
    // assistive technology reads the whole sentence at every width.
    expect(bar).toHaveTextContent(
      'Drag a task on the Schedule to watch the critical path recompute.',
    );
  });

  it('carries no live region — the bar never changes during a session', () => {
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar.tagName).toBe('ASIDE');
    expect(bar).not.toHaveAttribute('aria-live');
    expect(bar).not.toHaveAttribute('role');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('discloses the OSS community edition and names the Enterprise features it omits', () => {
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    render(<DemoModeBar />);
    const bar = screen.getByRole('complementary', { name: 'Demo mode' });
    expect(bar).toHaveTextContent('This is the community edition.');
    // Same "hidden below md, always in the accessibility tree" technique as the
    // pitch sentence — present in the DOM text content at every width.
    expect(bar).toHaveTextContent(
      'Portfolio dashboard, audit trail, and cross-program governance are part of Enterprise.',
    );
  });

  it('links the disclosure to the docs page that explains the open-core split, opened in a new tab', () => {
    demoMode.value = { isDemoReadOnly: true, loginHint: null, isLoading: false };
    render(<DemoModeBar />);
    const link = screen.getByRole('link', { name: "See what's included" });
    expect(link).toHaveAttribute('href', 'https://docs.trueppm.com/overview/#open-core-model');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders no edition disclosure on a normal install', () => {
    // Redundant with the top-level "renders nothing" test, but states the specific
    // invariant this issue is about: the disclosure can only ever render in demo mode.
    render(<DemoModeBar />);
    expect(screen.queryByRole('link', { name: "See what's included" })).toBeNull();
  });
});
