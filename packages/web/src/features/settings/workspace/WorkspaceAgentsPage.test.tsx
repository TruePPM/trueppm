import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceAgentsPage } from './WorkspaceAgentsPage';

const mockState: {
  ws: { mcpEnabled: boolean } | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = { ws: { mcpEnabled: true }, isLoading: false, isError: false, refetch: vi.fn() };
const mutateAsync = vi.fn();
let dirtyArgs: { onSave: () => Promise<void> } | undefined;

vi.mock('../hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({
    data: mockState.ws,
    isLoading: mockState.isLoading,
    isError: mockState.isError,
    error: null,
    refetch: mockState.refetch,
  }),
}));
vi.mock('../hooks/useUpdateWorkspaceSettings', () => ({
  useUpdateWorkspaceSettings: () => ({ mutateAsync }),
}));
vi.mock('../hooks/useDirtyForm', () => ({
  useDirtyForm: (args: { onSave: () => Promise<void> }) => {
    dirtyArgs = args;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  dirtyArgs = undefined;
  mockState.ws = { mcpEnabled: true };
  mockState.isLoading = false;
  mockState.isError = false;
});

describe('WorkspaceAgentsPage', () => {
  it('is a two-state switch (no Inherit — the workspace is the root)', () => {
    render(<WorkspaceAgentsPage />);
    expect(screen.getByRole('switch', { name: 'Agent read access' })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /inherit/i })).toBeNull();
    expect(screen.getByTestId('agent-access-workspace-note')).toHaveTextContent(/still block/i);
  });

  it('seeds Blocked from the server and says lower scopes cannot re-enable', () => {
    mockState.ws = { mcpEnabled: false };
    render(<WorkspaceAgentsPage />);
    expect(screen.getByRole('switch', { name: 'Agent read access' })).not.toBeChecked();
    expect(screen.getByTestId('agent-access-workspace-note')).toHaveTextContent(
      /cannot re-enable/i,
    );
  });

  it('keeps a dirty unsaved toggle when the workspace data refetches', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkspaceAgentsPage />);
    await user.click(screen.getByRole('switch', { name: 'Agent read access' }));
    expect(screen.getByRole('switch', { name: 'Agent read access' })).not.toBeChecked();
    mockState.ws = { mcpEnabled: true }; // fresh object, as a background refetch yields
    rerender(<WorkspaceAgentsPage />);
    expect(screen.getByRole('switch', { name: 'Agent read access' })).not.toBeChecked();
  });

  it('picks up a changed server value when the form is clean', () => {
    const { rerender } = render(<WorkspaceAgentsPage />);
    expect(screen.getByRole('switch', { name: 'Agent read access' })).toBeChecked();
    mockState.ws = { mcpEnabled: false }; // another admin changed it; refetch lands
    rerender(<WorkspaceAgentsPage />);
    expect(screen.getByRole('switch', { name: 'Agent read access' })).not.toBeChecked();
  });

  it('saves the toggled value as mcpEnabled', async () => {
    const user = userEvent.setup();
    render(<WorkspaceAgentsPage />);
    await user.click(screen.getByRole('switch', { name: 'Agent read access' }));
    await dirtyArgs?.onSave();
    expect(mutateAsync).toHaveBeenCalledWith({ mcpEnabled: false });
  });

  it('renders an error with Retry when the settings GET fails', async () => {
    mockState.ws = undefined;
    mockState.isError = true;
    render(<WorkspaceAgentsPage />);
    expect(screen.getByText("Couldn't load agent settings.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockState.refetch).toHaveBeenCalled();
  });
});
