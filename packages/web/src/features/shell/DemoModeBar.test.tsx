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
});
