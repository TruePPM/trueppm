/**
 * Tests for the program label view (#2333, ADR-0638).
 *
 * The assertions that matter are the ones protecting decisions a future change
 * could quietly undo: the withheld-projects disclosure, the per-project chip
 * colors, and the fact that no label means no request.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramLabelsPage } from './ProgramLabelsPage';

// Hoisted standalone mock (the WorkspaceGroupsPage pattern): pulling `get` off
// the mocked client afterwards would detach the method from its object and trip
// @typescript-eslint/unbound-method.
const { mockedGet } = vi.hoisted(() => ({ mockedGet: vi.fn() }));

vi.mock('@/api/client', () => ({
  apiClient: { get: mockedGet },
}));

const CATALOG = {
  results: [
    { name: 'security-review', project_count: 2 },
    { name: 'performance', project_count: 1 },
  ],
  withheld_project_count: 0,
};

const TASKS = {
  count: 2,
  next: null,
  previous: null,
  withheld_project_count: 0,
  results: [
    {
      id: 't1',
      short_id: '0001',
      name: 'Threat model',
      wbs_path: '1.1',
      status: 'NOT_STARTED',
      percent_complete: 0,
      early_finish: '2026-03-04',
      is_milestone: false,
      project: { id: 'p1', name: 'Ares Platform', code: 'APL' },
      labels: [{ id: 'l1', name: 'security-review', color: 'teal' }],
    },
    {
      id: 't2',
      short_id: '0002',
      name: 'Auth review',
      wbs_path: '2.1',
      status: 'NOT_STARTED',
      percent_complete: 0,
      early_finish: '2026-03-06',
      is_milestone: false,
      project: { id: 'p2', name: 'Beacon API', code: 'BCN' },
      labels: [{ id: 'l2', name: 'Security-Review', color: 'amber' }],
    },
  ],
};

function renderPage(initialPath = '/programs/prog-1/labels') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/programs/:programId/labels" element={<ProgramLabelsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function respond(overrides: { catalog?: unknown; tasks?: unknown } = {}) {
  mockedGet.mockImplementation((url: string) => {
    if (url.includes('label-catalog')) {
      return Promise.resolve({ data: overrides.catalog ?? CATALOG });
    }
    return Promise.resolve({ data: overrides.tasks ?? TASKS });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProgramLabelsPage', () => {
  it('prompts for a label and issues no task request until one is chosen', async () => {
    respond();
    renderPage();

    expect(await screen.findByText('Pick a label to see its work')).toBeInTheDocument();
    // The endpoint fails closed on a missing label, so firing without one would
    // only ever produce a guaranteed 400.
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet.mock.calls.every(([url]) => !String(url).includes('label-tasks'))).toBe(
      true,
    );
  });

  it('labels catalog counts as projects, not tasks', async () => {
    respond();
    renderPage();

    expect(await screen.findByRole('option', { name: /security-review — in 2 projects/ }))
      .toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /performance — in 1 project$/ }),
    ).toBeInTheDocument();
  });

  it('groups results by project and shows each project code', async () => {
    respond();
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(await screen.findByRole('heading', { name: /Ares Platform/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Beacon API/ })).toBeInTheDocument();
    expect(screen.getByText('APL')).toBeInTheDocument();
    expect(screen.getByText('BCN')).toBeInTheDocument();
  });

  it('explains per-project colors only when the results actually differ in color', async () => {
    respond();
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(
      await screen.findByText(/Label colors are set per project/),
    ).toBeInTheDocument();
  });

  it('stays quiet about colors when every match shares one', async () => {
    const oneColor = {
      ...TASKS,
      results: [TASKS.results[0]],
      count: 1,
    };
    respond({ tasks: oneColor });
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(await screen.findByRole('heading', { name: /Ares Platform/ })).toBeInTheDocument();
    expect(screen.queryByText(/Label colors are set per project/)).not.toBeInTheDocument();
  });

  it('discloses withheld projects rather than showing a silently partial list', async () => {
    respond({
      tasks: { ...TASKS, withheld_project_count: 2 },
    });
    renderPage('/programs/prog-1/labels?fl=security-review');

    const note = await screen.findByTestId('withheld-note');
    expect(note).toHaveTextContent(
      "2 projects in this program aren't shown — you're not a member of them.",
    );
  });

  it('uses the singular form for one withheld project', async () => {
    respond({ tasks: { ...TASKS, withheld_project_count: 1 } });
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(await screen.findByTestId('withheld-note')).toHaveTextContent(
      "1 project in this program isn't shown — you're not a member of it.",
    );
  });

  it('never renders the disclosure at zero', async () => {
    respond();
    renderPage('/programs/prog-1/labels?fl=security-review');

    await screen.findByRole('heading', { name: /Ares Platform/ });
    expect(screen.queryByTestId('withheld-note')).not.toBeInTheDocument();
  });

  it('shows the withheld note on an empty result, where it is the likely explanation', async () => {
    respond({
      tasks: { count: 0, next: null, previous: null, withheld_project_count: 3, results: [] },
    });
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(await screen.findByText(/No tasks carry/)).toBeInTheDocument();
    expect(screen.getByTestId('withheld-note')).toBeInTheDocument();
  });

  it('selecting a label drives the fl param and fetches that label', async () => {
    respond();
    const user = userEvent.setup();
    renderPage();

    // Wait for the catalog to populate the control — selecting before its
    // options exist fails on a select that only holds the placeholder.
    await screen.findByRole('option', { name: /performance/ });
    await user.selectOptions(screen.getByLabelText('Label'), 'performance');

    await waitFor(() =>
      expect(
        mockedGet.mock.calls.some(([url]) =>
          String(url).includes('label-tasks/?label=performance'),
        ),
      ).toBe(true),
    );
  });

  it('offers a retry on error', async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url.includes('label-catalog')) return Promise.resolve({ data: CATALOG });
      return Promise.reject(new Error('boom'));
    });
    renderPage('/programs/prog-1/labels?fl=security-review');

    expect(await screen.findByText(/Couldn't load tasks for this label/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
