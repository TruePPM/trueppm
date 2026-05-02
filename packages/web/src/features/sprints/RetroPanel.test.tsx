import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { RetroPanel } from './RetroPanel';

const useSprintRetroMock = vi.fn();
const saveMutateMock = vi.fn();
const useSaveSprintRetroMock = vi.fn(() => ({
  mutate: saveMutateMock,
  isPending: false,
  isError: false,
  isSuccess: false,
}));

vi.mock('@/hooks/useSprints', () => ({
  useSprintRetro: () => useSprintRetroMock(),
  useSaveSprintRetro: () => useSaveSprintRetroMock(),
}));

beforeEach(() => {
  saveMutateMock.mockReset();
  useSaveSprintRetroMock.mockReturnValue({
    mutate: saveMutateMock,
    isPending: false,
    isError: false,
    isSuccess: false,
  });
});

describe('RetroPanel', () => {
  it('renders the section heading and helper copy when a retro is missing', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId="sp-next" />,
    );
    expect(
      screen.getByRole('heading', { level: 2, name: /Retrospective/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/promotion happens on save/i)).toBeInTheDocument();
    expect(screen.getByText(/No action items yet/i)).toBeInTheDocument();
  });

  it('hydrates the form from the existing retro', async () => {
    useSprintRetroMock.mockReturnValue({
      data: {
        id: 'r1',
        sprint: 'sp-1',
        notes: 'Burndown skewed',
        created_by: null,
        created_at: '2026-04-15T00:00:00Z',
        updated_at: '2026-04-15T00:00:00Z',
        action_items: [
          {
            id: 'ai1',
            text: 'Add deploy gate',
            assignee: null,
            assignee_username: null,
            story_points: 3,
            promoted_task_id: 'task-uuid-aaaaaa',
            created_at: '2026-04-15T00:00:00Z',
          },
        ],
      },
      isLoading: false,
      error: null,
    });

    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={true} promoteToSprintId={null} />,
    );

    expect(await screen.findByDisplayValue('Burndown skewed')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Add deploy gate')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    // The promoted task chip should appear with a truncated UUID prefix.
    expect(screen.getByText(/T-task-u/i)).toBeInTheDocument();
  });

  it('shows the closed-sprint helper copy when isClosed', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={true} promoteToSprintId={null} />,
    );
    expect(screen.getByText(/can be amended after close/i)).toBeInTheDocument();
  });

  it('adds and removes action items via the toolbar', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId={null} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    expect(screen.getByLabelText(/Action item 1 text/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Remove action item 1/i }));
    expect(screen.queryByLabelText(/Action item 1 text/i)).not.toBeInTheDocument();
  });

  it('saves with trimmed text and includes the promote-to id', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId="sp-next" />,
    );
    await userEvent.type(screen.getByRole('textbox', { name: /Notes/i }), '  team unblocked  ');
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.type(screen.getByLabelText(/Action item 1 text/i), '  Add deploy gate  ');
    await userEvent.type(screen.getByLabelText(/Action item 1 story points/i), '3');
    await userEvent.click(screen.getByRole('button', { name: /Save retro/i }));

    expect(saveMutateMock).toHaveBeenCalledOnce();
    const payload = saveMutateMock.mock.calls[0][0];
    expect(payload.notes).toBe('team unblocked');
    expect(payload.action_items).toEqual([
      { text: 'Add deploy gate', promote: true, story_points: 3 },
    ]);
    expect(payload.promote_to_sprint_id).toBe('sp-next');
  });

  it('drops blank action items at save time', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId={null} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.click(screen.getByRole('button', { name: /\+ Add item/i }));
    await userEvent.type(screen.getByLabelText(/Action item 2 text/i), 'kept');
    await userEvent.click(screen.getByRole('button', { name: /Save retro/i }));

    const payload = saveMutateMock.mock.calls[0][0];
    expect(payload.action_items).toEqual([
      { text: 'kept', promote: true, story_points: null },
    ]);
  });

  it('shows the saving state while mutation pending', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    useSaveSprintRetroMock.mockReturnValue({
      mutate: saveMutateMock,
      isPending: true,
      isError: false,
      isSuccess: false,
    });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId={null} />,
    );
    expect(screen.getByRole('button', { name: /Saving/i })).toBeInTheDocument();
  });

  it('shows error alert when save mutation fails', () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    useSaveSprintRetroMock.mockReturnValue({
      mutate: saveMutateMock,
      isPending: false,
      isError: true,
      isSuccess: false,
    });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId={null} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/Failed to save retro/i);
  });

  it('shows success message after save resolves', async () => {
    useSprintRetroMock.mockReturnValue({ data: null, isLoading: false, error: null });
    useSaveSprintRetroMock.mockReturnValue({
      mutate: saveMutateMock,
      isPending: false,
      isError: false,
      isSuccess: true,
    });
    renderWithProviders(
      <RetroPanel sprintId="sp-1" isClosed={false} promoteToSprintId={null} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/Retro saved/i),
    );
  });
});
