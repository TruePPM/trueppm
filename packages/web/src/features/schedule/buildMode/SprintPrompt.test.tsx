import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SprintPrompt } from './SprintPrompt';
import type { ApiProjectDetail } from '@/hooks/useProject';

function wrap(ui: React.ReactElement, qc?: QueryClient) {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function agileProjectClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const project: ApiProjectDetail = {
    id: 'p1', server_version: 1, name: 'Test Project', description: '',
    start_date: '2026-01-01', calendar: null, estimation_mode: 'open',
    agile_features: true, methodology: 'AGILE',
  };
  qc.setQueryData(['project', 'p1'], project);
  return qc;
}

describe('SprintPrompt', () => {
  it('renders nothing when open=false', () => {
    const { container } = wrap(
      <SprintPrompt open={false} projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when projectId is null', () => {
    const { container } = wrap(
      <SprintPrompt open projectId={null} onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when project data has not loaded yet (no agile_features)', () => {
    const { container } = wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the prompt for an agile project', () => {
    wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    expect(screen.getByRole('dialog', { name: 'Assign to sprint' })).toBeInTheDocument();
    expect(screen.getByText('Add to sprint?')).toBeInTheDocument();
  });

  it('calls onDismiss when the Later button is clicked', () => {
    const onDismiss = vi.fn();
    wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={onDismiss} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText(/Later/));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('always shows Backlog option for agile projects', () => {
    wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    expect(screen.getByText('Backlog')).toBeInTheDocument();
  });

  it('calls onSelect(null) when Backlog option is clicked', () => {
    const onSelect = vi.fn();
    wrap(
      <SprintPrompt open projectId="p1" onSelect={onSelect} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText('Backlog'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
