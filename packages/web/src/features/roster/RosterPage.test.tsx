/**
 * RosterPage add-member dismissal tests (#2164).
 *
 * The mobile bottom sheet could not be dismissed by touch (no scrim tap, no
 * Cancel button — Escape is unavailable on a phone) and the desktop popover had
 * no outside-click dismiss. These cover the restored dismissal paths.
 *
 * The mobile sheet and the desktop popover share one open-state but are gated by
 * viewport (the desktop popover portals to <body>, escaping CSS containment, so
 * it is JS-gated by useBreakpoint). Each test pins the viewport so it exercises a
 * single surface, matching what renders on a real phone / desktop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RosterPage } from './RosterPage';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/hooks/useProjectId', () => ({ useProjectId: () => 'p1' }));
vi.mock('@/hooks/useProjectResourcePool', () => ({
  useProjectResourcePool: () => ({ data: [], isLoading: false }),
  useAddProjectResource: () => ({ mutate: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** Pin useBreakpoint's viewport tier: 'lg' → desktop, 'sm' → phone. */
function setViewport(tier: 'sm' | 'lg') {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: tier === 'lg' && /^\(min-width:/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { results: [] } });
  postMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: 'Add team member' }));
}

describe('RosterPage — mobile add sheet dismissal (#2164)', () => {
  beforeEach(() => setViewport('sm'));

  it('dismisses the sheet when Cancel is tapped', () => {
    render(<RosterPage />, { wrapper });
    openSheet();
    expect(screen.getByRole('dialog', { name: 'Add team member' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Add team member' })).not.toBeInTheDocument();
  });

  it('dismisses on a scrim tap, but not on a tap inside the sheet body', () => {
    render(<RosterPage />, { wrapper });
    openSheet();
    const dialog = screen.getByRole('dialog', { name: 'Add team member' });

    // The scrim is a sibling of the sheet, so a tap inside the sheet cannot
    // reach it — the sheet stays open.
    fireEvent.pointerDown(dialog);
    expect(screen.getByRole('dialog', { name: 'Add team member' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByTestId('bottom-sheet-scrim'));
    expect(screen.queryByRole('dialog', { name: 'Add team member' })).not.toBeInTheDocument();
  });
});

describe('RosterPage — desktop add popover dismissal (#2164)', () => {
  beforeEach(() => setViewport('lg'));

  it('dismisses on an outside pointerdown (useAnchoredPopover, rule 260)', () => {
    render(<RosterPage />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /add to project/i }));
    // The search combobox is present once the popover opens (jsdom applies no
    // CSS, so the md:hidden mobile sheet's combobox is also in the tree — assert
    // on presence, not exact count).
    expect(screen.getAllByRole('combobox', { name: /search by name/i }).length).toBeGreaterThan(0);

    // useAnchoredPopover's outside-pointerdown dismiss closes the shared open
    // state, unmounting the popover.
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('combobox', { name: /search by name/i })).not.toBeInTheDocument();
  });

  it('reflects open-state in aria-expanded on the desktop trigger', () => {
    render(<RosterPage />, { wrapper });
    const trigger = screen.getByRole('button', { name: /add to project/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
