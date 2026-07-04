import { type ComponentProps, type ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BoardViewDropdown } from './BoardViewDropdown';
import * as savedViewsHook from '@/hooks/useBoardSavedViews';
import type { BoardViewConfig } from '@/hooks/useBoardSavedViews';

const DEFAULT_CONFIG: BoardViewConfig = {
  sort: 'priority',
  showWip: true,
  showColTints: true,
  evmMode: 'off',
  showCost: false,
  riskLinkedOnly: false,
};

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderDropdown(overrides: Partial<ComponentProps<typeof BoardViewDropdown>> = {}) {
  const onApply = vi.fn();
  render(
    <BoardViewDropdown
      projectId="proj-1"
      currentConfig={DEFAULT_CONFIG}
      activeViewId={null}
      onApply={onApply}
      {...overrides}
    />,
    { wrapper },
  );
  return { onApply };
}

beforeEach(() => {
  vi.spyOn(savedViewsHook, 'useBoardSavedViews').mockReturnValue({
    views: [],
    isLoading: false,
    create: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['create'],
    update: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['update'],
    remove: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['remove'],
  });
});

describe('BoardViewDropdown', () => {
  it('renders "View" button when no view is active', () => {
    renderDropdown();
    expect(screen.getByRole('button', { name: /board view: view/i })).toBeInTheDocument();
  });

  it('shows active view name in button when a built-in is active', () => {
    renderDropdown({ activeViewId: 'at-risk' });
    expect(screen.getByRole('button', { name: /board view: ⚠ at risk/i })).toBeInTheDocument();
  });

  it('opens menu on button click', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('lists all four built-in views', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    expect(screen.getByText('⚠ At risk')).toBeInTheDocument();
    expect(screen.getByText('🔴 Critical path')).toBeInTheDocument();
    expect(screen.getByText('📅 This week')).toBeInTheDocument();
    expect(screen.getByText('👤 My work')).toBeInTheDocument();
  });

  it('calls onApply with correct config when a built-in view is clicked', () => {
    const { onApply } = renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('⚠ At risk'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ riskLinkedOnly: true }),
      'at-risk',
    );
  });

  it('calls onApply with cpOnly for critical path view', () => {
    const { onApply } = renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('🔴 Critical path'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ cpOnly: true }),
      'critical-path',
    );
  });

  it('calls onApply with null to clear active view', () => {
    const { onApply } = renderDropdown({ activeViewId: 'at-risk' });
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('Clear view'));
    expect(onApply).toHaveBeenCalledWith({}, null);
  });

  it('shows saved views when present', () => {
    vi.spyOn(savedViewsHook, 'useBoardSavedViews').mockReturnValue({
      views: [
        {
          id: 'sv-1',
          name: 'Sprint 7',
          config: DEFAULT_CONFIG,
          schemaVersion: 1,
          createdBy: 'user-1',
          serverVersion: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      create: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['create'],
      update: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['update'],
      remove: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['remove'],
    });
    renderDropdown({ currentUserId: 'user-1' });
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    expect(screen.getByText('Sprint 7')).toBeInTheDocument();
  });

  it('applies saved view on click', () => {
    vi.spyOn(savedViewsHook, 'useBoardSavedViews').mockReturnValue({
      views: [
        {
          id: 'sv-1',
          name: 'Sprint 7',
          config: { ...DEFAULT_CONFIG, showCost: true },
          schemaVersion: 1,
          createdBy: 'user-1',
          serverVersion: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      isLoading: false,
      create: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['create'],
      update: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['update'],
      remove: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['remove'],
    });
    const { onApply } = renderDropdown({ currentUserId: 'user-1' });
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('Sprint 7'));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ showCost: true }),
      'sv-1',
    );
  });

  it('shows save view input after clicking "Save current view…"', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('+ Save current view…'));
    expect(screen.getByRole('dialog', { name: /save current view/i })).toBeInTheDocument();
    expect(screen.getByLabelText('View name')).toBeInTheDocument();
  });

  it('saves a new view when name is entered and Save clicked', async () => {
    const mutateMock = vi.fn();
    vi.spyOn(savedViewsHook, 'useBoardSavedViews').mockReturnValue({
      views: [],
      isLoading: false,
      create: { mutate: mutateMock, isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['create'],
      update: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['update'],
      remove: { mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof savedViewsHook.useBoardSavedViews>['remove'],
    });
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /board view/i }));
    fireEvent.click(screen.getByText('+ Save current view…'));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'My new view' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith(
        { name: 'My new view', config: DEFAULT_CONFIG },
        expect.any(Object),
      );
    });
  });
});
