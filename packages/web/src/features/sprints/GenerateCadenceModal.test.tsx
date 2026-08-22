import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { GenerateCadenceModal } from './GenerateCadenceModal';
import type { GenerateSprintsResponse } from '@/hooks/useSprints';

const mutateMock = vi.fn();
const mockMutation = { mutate: mutateMock, isPending: false, isError: false };

vi.mock('@/hooks/useSprints', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useSprints')>();
  return {
    ...actual,
    useGenerateSprints: () => mockMutation,
  };
});

function preview(over: Partial<GenerateSprintsResponse> = {}): GenerateSprintsResponse {
  return {
    dry_run: true,
    sprints: [
      {
        name: 'Sprint 1',
        start_date: '2026-04-06',
        finish_date: '2026-04-17',
        working_days: 10,
        non_working_days_skipped: 4,
        status: 'new',
        id: null,
      },
      {
        name: 'Sprint 2',
        start_date: '2026-04-20',
        finish_date: '2026-05-01',
        working_days: 10,
        non_working_days_skipped: 4,
        status: 'new',
        id: null,
      },
    ],
    created_count: 2,
    skipped_count: 0,
    capacity_hint: {
      points: 24,
      basis: 'velocity_average',
      sprints_sampled: 3,
      note: 'A starting point drawn from this team’s own closed iterations — not a limit.',
    },
    ...over,
  };
}

/** Drive the setup step to the preview step with a canned server response. */
async function advanceToPreview(
  user: ReturnType<typeof userEvent.setup>,
  data: GenerateSprintsResponse = preview(),
) {
  mutateMock.mockImplementation(
    (_payload: unknown, opts?: { onSuccess?: (d: GenerateSprintsResponse) => void }) => {
      opts?.onSuccess?.(data);
    },
  );
  await user.click(screen.getByRole('button', { name: /^Preview$/i }));
}

beforeEach(() => {
  mutateMock.mockReset();
  mockMutation.isPending = false;
  mockMutation.isError = false;
});

describe('GenerateCadenceModal', () => {
  it('opens on the setup step with an accessible dialog name', () => {
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    expect(screen.getByRole('dialog', { name: /Generate sprints/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Preview$/i })).toBeInTheDocument();
  });

  it('asks the server for a dry run before showing anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );

    await advanceToPreview(user);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0][0]).toMatchObject({ dry_run: true, count: 6 });
  });

  it('blocks Preview until the name pattern carries the {n} token', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );

    const pattern = screen.getByLabelText(/Name pattern/i);
    await user.clear(pattern);
    await user.type(pattern, 'Sprint');

    expect(screen.getByRole('button', { name: /^Preview$/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('{n}');
  });

  it('renders the preview rows with their calendar read-out', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );

    await advanceToPreview(user);

    expect(screen.getByDisplayValue('Sprint 1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sprint 2')).toBeInTheDocument();
    expect(screen.getByLabelText(/Start date for row 1/i)).toHaveValue('2026-04-06');
    expect(
      screen.getByRole('button', { name: /Generate 2 sprints/i }),
    ).toBeInTheDocument();
  });

  it('commits the operator’s edits, not the original parameters', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    await advanceToPreview(user);

    const nameField = screen.getByDisplayValue('Sprint 1');
    await user.clear(nameField);
    await user.type(nameField, 'Hardening');

    mutateMock.mockReset();
    mutateMock.mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: /Generate 2 sprints/i }));

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const payload = mutateMock.mock.calls[0][0] as { sprints: { name: string }[] };
    expect(payload.sprints.map((row) => row.name)).toEqual(['Hardening', 'Sprint 2']);
  });

  it('refuses to commit two rows with the same name', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    await advanceToPreview(user);

    const second = screen.getByDisplayValue('Sprint 2');
    await user.clear(second);
    await user.type(second, 'Sprint 1');

    expect(screen.getByRole('button', { name: /Generate 2 sprints/i })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/unique name/i);
  });

  it('leaves rows that already exist alone and says so', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );

    const data = preview();
    data.sprints[0].status = 'exists';
    await advanceToPreview(user, data);

    expect(screen.getByDisplayValue('Sprint 1')).toBeDisabled();
    expect(screen.getByText(/already exist and will be left alone/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate 1 sprint$/i }),
    ).toBeInTheDocument();
  });

  // The sovereignty rule, asserted rather than assumed: the number is offered,
  // it is off by default, and the sentence that bounds it is always rendered.
  it('offers the suggested capacity as an opt-in, never applied by default', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    await advanceToPreview(user);

    const optIn = screen.getByRole('checkbox');
    expect(optIn).not.toBeChecked();
    expect(screen.getByText(/not a limit/i)).toBeInTheDocument();

    mutateMock.mockReset();
    mutateMock.mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: /Generate 2 sprints/i }));

    const payload = mutateMock.mock.calls[0][0] as {
      first_sprint_capacity_points?: number | null;
    };
    expect(payload.first_sprint_capacity_points).toBeUndefined();
  });

  it('sends the capacity only once the operator ticks it on', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    await advanceToPreview(user);

    await user.click(screen.getByRole('checkbox'));
    mutateMock.mockReset();
    mutateMock.mockImplementation(() => undefined);
    await user.click(screen.getByRole('button', { name: /Generate 2 sprints/i }));

    const payload = mutateMock.mock.calls[0][0] as {
      first_sprint_capacity_points?: number | null;
    };
    expect(payload.first_sprint_capacity_points).toBe(24);
  });

  it('offers no capacity control when the team has no closed iterations', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );

    await advanceToPreview(
      user,
      preview({
        capacity_hint: {
          points: null,
          basis: 'no_history',
          sprints_sampled: 0,
          note: 'No closed iterations to draw from yet.',
        },
      }),
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/No closed iterations to draw from yet/i)).toBeInTheDocument();
  });

  it('Back returns to setup without committing anything', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GenerateCadenceModal projectId="p1" onClose={() => undefined} />,
    );
    await advanceToPreview(user);

    mutateMock.mockReset();
    await user.click(screen.getByRole('button', { name: /^Back$/i }));

    expect(screen.getByRole('button', { name: /^Preview$/i })).toBeInTheDocument();
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
