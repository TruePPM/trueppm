import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { App } from './App';

// createCpmWorker uses `new Worker(new URL(..., import.meta.url))` which triggers
// Vite's worker bundling pipeline — unsupported in jsdom. Mock the factory so
// App-level smoke tests render without hanging.
vi.mock('@/workers/createCpmWorker', () => ({
  createCpmWorker: () => ({
    onmessage: null,
    postMessage: () => {},
    terminate: () => {},
  }),
}));

describe('App', () => {
  it('renders the application shell landmark regions', () => {
    render(<App />);
    // Shell renders header, navigations (view tabs + bottom rail + sidebar), and main
    expect(screen.getByRole('banner')).toBeInTheDocument(); // <header>
    // Both ViewTabs and BottomNav are aria-label="View" (one hidden per breakpoint in real browser)
    expect(screen.getAllByRole('navigation', { name: /view/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('renders the TruePPM logo text', () => {
    render(<App />);
    expect(screen.getByText('TruePPM')).toBeInTheDocument();
  });
});
