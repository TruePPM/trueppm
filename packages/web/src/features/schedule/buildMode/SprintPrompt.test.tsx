import React from 'react';
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
    id: 'p1',
    server_version: 1,
    name: 'Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: null,
    estimation_mode: 'open',
    agile_features: true,
    methodology: 'AGILE',
    code: '',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    timezone: '',
    default_view: 'SCHEDULE',
    lead: null,
    lead_detail: null,
    is_archived: false,
    archived_at: null,
    archived_by: null,
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

  it('renders the sprint step for an agile project', () => {
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

  it('advances to points step after sprint selection', () => {
    wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText('Backlog'));
    expect(screen.getByText('Story points?')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: /story points/i })).toBeInTheDocument();
  });

  it('calls onSelect(null, null) when Backlog is picked and Done clicked with no pts', () => {
    const onSelect = vi.fn();
    wrap(
      <SprintPrompt open projectId="p1" onSelect={onSelect} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText('Backlog'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSelect).toHaveBeenCalledWith(null, null);
  });

  it('calls onSelect(null, 5) when Backlog is picked and 5 pts entered', () => {
    const onSelect = vi.fn();
    wrap(
      <SprintPrompt open projectId="p1" onSelect={onSelect} onDismiss={vi.fn()} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText('Backlog'));
    fireEvent.change(screen.getByRole('spinbutton', { name: /story points/i }), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSelect).toHaveBeenCalledWith(null, 5);
  });

  it('goes back to sprint step when Esc pressed on points step', () => {
    const onDismiss = vi.fn();
    wrap(
      <SprintPrompt open projectId="p1" onSelect={vi.fn()} onDismiss={onDismiss} />,
      agileProjectClient(),
    );
    fireEvent.click(screen.getByText('Backlog'));
    expect(screen.getByText('Story points?')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(screen.getByText('Add to sprint?')).toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
