/**
 * Tests for <RiskForm> — the create/edit form behind the risk drawer. Covers
 * the create-vs-edit branch (payload shape, which mutation fires), title
 * validation, the live severity computation, the collapsible Advanced section
 * (auto-open when framework fields are pre-filled), the pending/disabled state,
 * and the DRF error-formatting branches (detail vs field-array vs plain
 * message).
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RiskForm } from './RiskForm';
import type { Risk } from '@/api/types';
import type { CreateRiskPayload } from '@/hooks/useRisks';

type CreateRiskVars = { projectId: string; data: CreateRiskPayload };
type UpdateRiskVars = { projectId: string; id: string; data: Partial<CreateRiskPayload> };
type MutateOpts = { onSuccess: () => void };

const { createMutate, createReset, updateMutate, updateReset, useCreateRiskMock, useUpdateRiskMock } =
  vi.hoisted(() => ({
    createMutate: vi.fn<(vars: CreateRiskVars, opts: MutateOpts) => void>(),
    createReset: vi.fn(),
    updateMutate: vi.fn<(vars: UpdateRiskVars, opts: MutateOpts) => void>(),
    updateReset: vi.fn(),
    useCreateRiskMock: vi.fn(),
    useUpdateRiskMock: vi.fn(),
  }));

vi.mock('@/hooks/useRisks', () => ({
  useCreateRisk: useCreateRiskMock,
  useUpdateRisk: useUpdateRiskMock,
}));

interface MutationState {
  isPending?: boolean;
  error?: Error | null;
}

function setMutations(create: MutationState = {}, update: MutationState = {}) {
  useCreateRiskMock.mockReturnValue({
    mutate: createMutate,
    reset: createReset,
    isPending: create.isPending ?? false,
    error: create.error ?? null,
  });
  useUpdateRiskMock.mockReturnValue({
    mutate: updateMutate,
    reset: updateReset,
    isPending: update.isPending ?? false,
    error: update.error ?? null,
  });
}

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeRisk(over: Partial<Risk> = {}): Risk {
  return {
    id: 'risk-1',
    short_id: '7',
    short_id_display: 'R-007',
    qualified_id: 'R-007',
    server_version: 1,
    project: 'p1',
    title: 'Existing risk',
    description: 'desc',
    status: 'MITIGATING',
    probability: 4,
    impact: 5,
    severity: 20,
    owner: null,
    created_by: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-02',
    tasks: [],
    notes: '',
    ...over,
  } as Risk;
}

function renderForm(risk?: Risk) {
  const onSuccess = vi.fn();
  const onCancel = vi.fn();
  render(wrapper(<RiskForm projectId="p1" risk={risk} onSuccess={onSuccess} onCancel={onCancel} />));
  return { onSuccess, onCancel };
}

beforeEach(() => {
  vi.clearAllMocks();
  setMutations();
});

describe('<RiskForm> create mode', () => {
  it('defaults to severity 9 (probability 3 × impact 3) and shows the Medium chip', () => {
    renderForm();
    // Severity read-out shows the computed product.
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('recomputes severity live when probability and impact change', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/probability/i), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/impact/i), { target: { value: '5' } });
    // 5 × 5 = 25 → Critical band.
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Critical')).toBeInTheDocument();
  });

  it('blocks submit and shows a title error when the title is empty', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required.');
    expect(createMutate).not.toHaveBeenCalled();
    // The input is flagged invalid for AT.
    expect(screen.getByLabelText(/title/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not submit a whitespace-only title', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('calls createRisk (not updateRisk) with a trimmed title and null framework fields', () => {
    const { onSuccess } = renderForm();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: '  Server outage  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(createMutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = createMutate.mock.calls[0];
    expect(vars.projectId).toBe('p1');
    expect(vars.data).toEqual(
      expect.objectContaining({
        title: 'Server outage',
        probability: 3,
        impact: 3,
        status: 'OPEN',
        owner: null,
        tasks: [],
        category: null,
        response: null,
        mitigation_due_date: null,
      }),
    );
    // onSuccess is forwarded to the mutation so the drawer closes on success.
    expect(opts.onSuccess).toBe(onSuccess);
  });

  it('resets both mutations before validating (clears a stale error banner)', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(createReset).toHaveBeenCalled();
    expect(updateReset).toHaveBeenCalled();
  });

  it('clears a previous title error once a valid title is submitted', () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Title is required.');
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Real title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText('Title is required.')).not.toBeInTheDocument();
  });

  it('carries edited status, description and every advanced field into the create payload', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Vendor delay' } });
    fireEvent.change(screen.getByLabelText(/status/i), { target: { value: 'MITIGATING' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Long-lead part' } });

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'EXTERNAL' } });
    fireEvent.change(screen.getByLabelText('Response'), { target: { value: 'TRANSFER' } });
    fireEvent.change(screen.getByLabelText(/mitigation due date/i), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('Contingency'), { target: { value: 'Second source' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const [vars] = createMutate.mock.calls[0];
    expect(vars.data).toEqual(
      expect.objectContaining({
        status: 'MITIGATING',
        description: 'Long-lead part',
        category: 'EXTERNAL',
        response: 'TRANSFER',
        mitigation_due_date: '2026-09-01',
        contingency: 'Second source',
      }),
    );
  });

  it('sends null category/response when Advanced fields are cleared back to "none"', () => {
    // Edit a risk that had a category set, then clear it to the empty option.
    renderForm(makeRisk({ category: 'TECHNICAL', response: 'MITIGATE' }));
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Response'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const [vars] = updateMutate.mock.calls[0];
    expect(vars.data).toEqual(
      expect.objectContaining({ category: null, response: null }),
    );
  });

  it('calls onCancel when Cancel is clicked', () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('<RiskForm> Advanced section', () => {
  it('starts collapsed in create mode and toggles open on click', () => {
    renderForm();
    const toggle = screen.getByRole('button', { name: 'Advanced' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Category')).toBeInTheDocument();
  });

  it('auto-opens when an existing risk already has framework data', () => {
    renderForm(makeRisk({ category: 'TECHNICAL' }));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Category')).toHaveValue('TECHNICAL');
  });

  it('includes edited framework fields in the update payload', () => {
    renderForm(makeRisk({ category: 'TECHNICAL' }));
    fireEvent.change(screen.getByLabelText('Response'), { target: { value: 'MITIGATE' } });
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'SLA breach' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const [vars] = updateMutate.mock.calls[0];
    expect(vars.data).toEqual(
      expect.objectContaining({
        category: 'TECHNICAL',
        response: 'MITIGATE',
        trigger: 'SLA breach',
      }),
    );
  });
});

describe('<RiskForm> edit mode', () => {
  it('pre-fills fields and calls updateRisk with the risk id', () => {
    renderForm(makeRisk({ id: 'risk-42', title: 'DB failover', status: 'MITIGATING' }));
    expect(screen.getByLabelText(/title/i)).toHaveValue('DB failover');
    expect(screen.getByLabelText(/status/i)).toHaveValue('MITIGATING');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(createMutate).not.toHaveBeenCalled();
    const [vars] = updateMutate.mock.calls[0];
    expect(vars).toEqual(
      expect.objectContaining({ projectId: 'p1', id: 'risk-42' }),
    );
  });
});

describe('<RiskForm> pending + error states', () => {
  it('disables both buttons and shows "Saving…" while a mutation is pending', () => {
    setMutations({ isPending: true });
    renderForm();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('renders the DRF detail message when the error carries a detail string', () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { detail: 'You do not have permission.' } },
    });
    setMutations({ error: err });
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have permission.');
  });

  it('formats field-level DRF validation errors (array + string values)', () => {
    const err = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { data: { title: ['This field may not be blank.'], impact: 'Too high' } },
    });
    setMutations({ error: err });
    renderForm();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('title: This field may not be blank.');
    expect(alert).toHaveTextContent('impact: Too high');
  });

  it('falls back to the error message for a non-axios error', () => {
    setMutations({ error: new Error('Network down') });
    renderForm();
    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
  });
});
