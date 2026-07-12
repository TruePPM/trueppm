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
    program: null,
    board_cadence: 'sprint',
    estimation_mode: 'open',
    default_member_role: 100,
    default_member_role_label: 'Team Member',
    agile_features: true,
    methodology: 'AGILE',
    effective_methodology: 'AGILE',
    inherited_methodology: 'AGILE',
    code: '',
    health: 'AUTO',
    visibility: 'WORKSPACE',
    timezone: '',
    default_view: 'SCHEDULE',
    lead: null,
    lead_detail: null,
    iteration_label: null,
    effective_iteration_label: 'Sprint',
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    task_duration_change_percent_policy: null,
    effective_task_duration_change_percent_policy: 'keep',
    inherited_task_duration_change_percent_policy: 'keep',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    show_reporting: null,
    show_time_tracking: null,
    show_baselines: null,
    show_monte_carlo: null,
    effective_surface_visibility: { reporting: true, time_tracking: true, baselines: false, monte_carlo: false },
    inherited_surface_visibility: { reporting: true, time_tracking: true, baselines: false, monte_carlo: false },
    is_archived: false,
    archived_at: null,
    archived_by: null,
    recalculated_at: '2026-01-02T00:00:00Z',
    is_sample: false,
    program_detail: null,
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
