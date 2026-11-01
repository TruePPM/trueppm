/**
 * Tests for the program decision log page (#4772, ADR-1310).
 *
 * The states that carry the design's risk: a failed load must not read as an
 * empty log, a Viewer and a closed program must not be offered writes, and a
 * refused write must say what the server said in a sibling alert.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramDecisionsPage } from './ProgramDecisionsPage';
import type { ProgramDecision } from './decisionListModel';

const { mockedGet, mockedPost, mockedPatch } = vi.hoisted(() => ({
  mockedGet: vi.fn(),
  mockedPost: vi.fn(),
  mockedPatch: vi.fn(),
}));

vi.mock('@/api/client', () => ({
  apiClient: { get: mockedGet, post: mockedPost, patch: mockedPatch },
}));

const PROGRAM_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';

function program(over: { my_role?: number | null; is_closed?: boolean } = {}) {
  return {
    id: PROGRAM_ID,
    name: 'Apollo',
    code: 'APOLLO',
    my_role: 400,
    is_closed: false,
    ...over,
  };
}

function decision(over: Partial<ProgramDecision> = {}): ProgramDecision {
  return {
    id: 'd1',
    server_version: 1,
    program: PROGRAM_ID,
    title: 'Pick a vendor',
    owner: 7,
    owner_detail: { id: 7, username: 'dana', display_name: 'Dana Ruiz' },
    due_date: null,
    status: 'awaiting',
    decided_at: null,
    linked_task: null,
    linked_risk: null,
    link: null,
    impact_note: '',
    created_by: 7,
    created_at: '2026-10-01T12:00:00Z',
    updated_at: '2026-10-28T12:00:00Z',
    ...over,
  };
}

const page = (results: ProgramDecision[]) => ({
  data: { count: results.length, next: null, previous: null, results },
});

interface Respond {
  prog?: ReturnType<typeof program>;
  awaiting?: ProgramDecision[];
  made?: ProgramDecision[];
  failDecisions?: boolean;
  pendingDecisions?: boolean;
}

function respond(opts: Respond = {}) {
  mockedGet.mockImplementation((url: string, config?: { params?: { status?: string } }) => {
    if (url === `/programs/${PROGRAM_ID}/`)
      return Promise.resolve({ data: opts.prog ?? program() });
    if (url === `/programs/${PROGRAM_ID}/members/`) return Promise.resolve({ data: [] });
    if (url === `/programs/${PROGRAM_ID}/decisions/`) {
      if (opts.pendingDecisions) return new Promise(() => {});
      if (opts.failDecisions) return Promise.reject(new Error('boom'));
      const status = config?.params?.status;
      return Promise.resolve(page(status === 'made' ? (opts.made ?? []) : (opts.awaiting ?? [])));
    }
    return Promise.resolve({ data: {} });
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/programs/${PROGRAM_ID}/decisions`]}>
        <Routes>
          <Route path="/programs/:programId/decisions" element={<ProgramDecisionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedPost.mockReset();
  mockedPatch.mockReset();
});

describe('ProgramDecisionsPage', () => {
  it('shows a loading state while the lists are in flight', () => {
    respond({ pendingDecisions: true });
    renderPage();
    expect(screen.getByLabelText('Loading decisions')).toBeInTheDocument();
  });

  it('shows "No decisions logged" when both lists are empty', async () => {
    respond();
    renderPage();
    expect(await screen.findByText('No decisions logged')).toBeInTheDocument();
  });

  it('a failed load says so, with a retry, instead of an empty log', async () => {
    respond({ failDecisions: true });
    renderPage();
    expect(await screen.findByText("Couldn't load decisions.")).toBeInTheDocument();
    expect(screen.queryByText('No decisions logged')).not.toBeInTheDocument();

    respond({ awaiting: [decision()] });
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Pick a vendor')).toBeInTheDocument();
  });

  it('lists awaiting and made decisions in their own sections', async () => {
    respond({
      awaiting: [decision({ impact_note: 'recovers 2 days' })],
      made: [
        decision({
          id: 'd2',
          title: 'Freeze scope',
          status: 'made',
          decided_at: '2026-10-29T09:00:00Z',
        }),
      ],
    });
    renderPage();
    const awaiting = await screen.findByRole('region', { name: /Awaiting/ });
    expect(within(awaiting).getByText('Pick a vendor')).toBeInTheDocument();
    expect(within(awaiting).getByText('recovers 2 days')).toBeInTheDocument();
    expect(within(awaiting).getByText(/Owner's estimate · as of/)).toBeInTheDocument();
    expect(within(awaiting).getByRole('button', { name: 'Mark made' })).toBeInTheDocument();

    const made = screen.getByRole('region', { name: /Made/ });
    expect(within(made).getByText('Freeze scope')).toBeInTheDocument();
    expect(within(made).getByText(/^Decided /)).toBeInTheDocument();
    expect(within(made).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('offers a Viewer no write controls', async () => {
    respond({ prog: program({ my_role: 1 }), awaiting: [decision()] });
    renderPage();
    expect(await screen.findByText('Pick a vendor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log a decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark made' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('decisions-closed-note')).not.toBeInTheDocument();
  });

  it('shows a closed program read-only, with no write controls', async () => {
    respond({ prog: program({ is_closed: true }), awaiting: [decision()] });
    renderPage();
    expect(await screen.findByTestId('decisions-closed-note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log a decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it("renders a refused write's reason as a sibling alert and keeps the verb", async () => {
    respond({ awaiting: [decision()] });
    const reason = 'This program is closed and cannot be modified. Reopen it first.';
    mockedPatch.mockRejectedValue(
      Object.assign(new Error('Forbidden'), {
        isAxiosError: true,
        response: { status: 403, data: { detail: reason } },
      }),
    );
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark made' }));
    const alert = await screen.findByTestId('decision-row-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent(reason);
    expect(alert.closest('[role="status"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark made' })).toBeInTheDocument();
    expect(mockedPatch).toHaveBeenCalledWith(`/programs/${PROGRAM_ID}/decisions/d1/`, {
      status: 'made',
    });
  });

  it('logs a new decision with the form', async () => {
    respond();
    mockedPost.mockResolvedValue({ data: decision() });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Log a decision' }));
    const form = screen.getByRole('form', { name: 'Log a decision' });
    await userEvent.type(within(form).getByLabelText('Decision'), '  Go or no-go  ');
    await userEvent.type(within(form).getByLabelText("Owner's impact estimate"), 'saves a week');
    await userEvent.click(within(form).getByRole('button', { name: 'Save decision' }));
    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith(`/programs/${PROGRAM_ID}/decisions/`, {
        title: 'Go or no-go',
        owner: null,
        due_date: null,
        impact_note: 'saves a week',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Log a decision' })).not.toBeInTheDocument(),
    );
  });
});
