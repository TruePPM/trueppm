import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProjectGuardrailsPage } from './ProjectGuardrailsPage';
import type { ProjectGuardrailPolicy } from '@/hooks/useProjectGuardrailPolicy';
import { ROLE_MEMBER, ROLE_OWNER } from '@/lib/roles';

const useProjectId = vi.fn();
const useProjectGuardrailPolicy = vi.fn();
const useCurrentUserRole = vi.fn();

vi.mock('@/hooks/useProjectId', () => ({
  useProjectId: () => useProjectId() as string | undefined,
}));

vi.mock('@/hooks/useCurrentUserRole', () => ({
  useCurrentUserRole: (id: string | undefined) => useCurrentUserRole(id) as unknown,
}));

vi.mock('@/hooks/useProjectGuardrailPolicy', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/useProjectGuardrailPolicy')
  >('@/hooks/useProjectGuardrailPolicy');
  return {
    ...actual,
    useProjectGuardrailPolicy: (id: string | null | undefined) =>
      useProjectGuardrailPolicy(id) as unknown,
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/projects/p-1/settings/guardrails']}>
        <Routes>
          <Route
            path="/projects/:projectId/settings/guardrails"
            element={<ProjectGuardrailsPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ALL_WARN: ProjectGuardrailPolicy = {
  levels: {},
  effectiveLevels: {
    summary_in_sprint: 'warn',
    phase_in_sprint: 'warn',
    task_outside_sprint_window: 'warn',
    recurring_in_sprint: 'warn',
    subtasks_split: 'warn',
  },
  source: 'owner',
  sourceLabel: '',
  acknowledgedByTeam: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProjectId.mockReturnValue('p-1');
});

describe('ProjectGuardrailsPage', () => {
  it('shows loading state', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_OWNER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: undefined,
      isLoading: true,
      error: null,
      update: { mutate: vi.fn(), isPending: false },
    });
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders the rule matrix with outcome-language copy (no WBS jargon)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_OWNER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: ALL_WARN,
      isLoading: false,
      error: null,
      update: { mutate: vi.fn(), isPending: false },
    });
    renderPage();
    // Outcome-language strings from RULE_LABEL — no "WBS L1 root" or similar jargon
    expect(screen.getByText(/Double-counts in velocity/)).toBeInTheDocument();
    expect(screen.getByText(/Phases group work/)).toBeInTheDocument();
    expect(screen.getByText(/won't complete in the sprint/)).toBeInTheDocument();
  });

  it('Owner sees enabled Block buttons for composition rules', () => {
    const mutate = vi.fn();
    useCurrentUserRole.mockReturnValue({ role: ROLE_OWNER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: ALL_WARN,
      isLoading: false,
      error: null,
      update: { mutate, isPending: false },
    });
    renderPage();
    const blockBtns = screen.getAllByRole('button', { name: /block \(no override\)/i });
    expect(blockBtns.length).toBe(4); // 4 composition rules
    expect(blockBtns[0]).not.toBeDisabled();
    fireEvent.click(blockBtns[0]);
    expect(mutate).toHaveBeenCalledWith({ levels: { summary_in_sprint: 'block' } });
  });

  it('non-Owner sees disabled Block buttons + helper text (sprint sovereignty)', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: ALL_WARN,
      isLoading: false,
      error: null,
      update: { mutate: vi.fn(), isPending: false },
    });
    renderPage();
    const blockBtns = screen.getAllByRole('button', { name: /block \(no override\)/i });
    blockBtns.forEach((b) => expect(b).toBeDisabled());
    expect(
      screen.getByText(/Only a project Owner can change a sprint-composition rule/),
    ).toBeInTheDocument();
  });

  it('subtasks_split rule shows a fixed advisory pill, no Block path', () => {
    useCurrentUserRole.mockReturnValue({ role: ROLE_OWNER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: ALL_WARN,
      isLoading: false,
      error: null,
      update: { mutate: vi.fn(), isPending: false },
    });
    renderPage();
    // Advisory rule is in the matrix...
    expect(screen.getByText('Subtasks split across sprints')).toBeInTheDocument();
    // ...with a "Warn (advisory)" pill, not a pair of Warn/Block buttons.
    expect(screen.getByText('Warn (advisory)')).toBeInTheDocument();
  });

  it('renders external-policy banner with team-ack toggle when source is external', () => {
    const mutate = vi.fn();
    useCurrentUserRole.mockReturnValue({ role: ROLE_MEMBER });
    useProjectGuardrailPolicy.mockReturnValue({
      policy: {
        ...ALL_WARN,
        source: 'external',
        sourceLabel: 'PMO',
        // Configured block (raw), but inert until ack — effectiveLevels reads as warn
        levels: { summary_in_sprint: 'block' },
        effectiveLevels: { ...ALL_WARN.effectiveLevels },
      },
      isLoading: false,
      error: null,
      update: { mutate, isPending: false },
    });
    renderPage();
    expect(screen.getByText(/Policy set by PMO/)).toBeInTheDocument();
    expect(screen.getByText(/inert until the team acknowledges/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Acknowledge$/ }));
    expect(mutate).toHaveBeenCalledWith({ acknowledgedByTeam: true });
  });
});
