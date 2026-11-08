import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProvidersAndRouter } from '@/test/utils';
import { QuickLogSheet } from './QuickLogSheet';

const { useMyWorkMock, mutateAsync, onlineMock, toastInfo, toastError } = vi.hoisted(() => ({
  useMyWorkMock: vi.fn(),
  mutateAsync: vi.fn(),
  onlineMock: vi.fn(() => true),
  toastInfo: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@/hooks/useMyWork', () => ({ useMyWork: useMyWorkMock }));
vi.mock('@/hooks/useCreateTimeEntry', () => ({
  useCreateTimeEntry: () => ({ mutateAsync }),
}));
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: onlineMock }));
vi.mock('@/components/Toast', () => ({ toast: { info: toastInfo, error: toastError } }));

const task = (id: string, name: string, group = 'today') => ({
  id,
  name,
  project_name: 'Atlas',
  group,
  is_phase: false,
});

function setTasks(results: ReturnType<typeof task>[], isError = false) {
  useMyWorkMock.mockReturnValue({ data: { pages: [{ results }] }, isError });
}

function renderSheet(onClose = vi.fn()) {
  renderWithProvidersAndRouter(<QuickLogSheet isOpen onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  onlineMock.mockReturnValue(true);
  mutateAsync.mockResolvedValue({});
});

describe('QuickLogSheet', () => {
  it('lists only tasks due today', () => {
    setTasks([task('a', 'Write spec'), task('b', 'Later thing', 'upcoming')]);
    renderSheet();
    expect(screen.getByText('Write spec')).toBeInTheDocument();
    expect(screen.queryByText('Later thing')).not.toBeInTheDocument();
  });

  it('steps by half an hour, announcing the changed value once per press', async () => {
    setTasks([task('a', 'Write spec')]);
    renderSheet();
    const inc = screen.getByRole('button', { name: 'Increase hours on Write spec' });
    await userEvent.click(inc);
    await userEvent.click(inc);
    expect(screen.getByTestId('quicklog-value-a')).toHaveTextContent('1h');
    expect(screen.getByRole('status')).toHaveTextContent('Write spec: 1 hour');
  });

  it('does not step below zero', async () => {
    setTasks([task('a', 'Write spec')]);
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Decrease hours on Write spec' }));
    expect(screen.getByTestId('quicklog-value-a')).toHaveTextContent('0h');
  });

  it('saves positive entries as minutes against today and closes', async () => {
    setTasks([task('a', 'Write spec'), task('b', 'Review')]);
    const onClose = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 1.5h' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'a', minutes: 90, taskLabel: 'Write spec' }),
    );
  });

  it('keeps the sheet open and renders a sibling alert when a write is refused', async () => {
    setTasks([task('a', 'Write spec')]);
    mutateAsync.mockRejectedValue(new Error('refused'));
    const onClose = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 0.5h' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Write spec');
    expect(alert.closest('[role="status"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('quicklog-value-a')).toHaveTextContent('0.5h');
  });

  it('offline: states it will send when online, queues without waiting, and closes', async () => {
    onlineMock.mockReturnValue(false);
    setTasks([task('a', 'Write spec')]);
    mutateAsync.mockReturnValue(new Promise(() => undefined)); // paused until reconnect
    const onClose = renderSheet();
    expect(screen.getByTestId('quicklog-offline')).toHaveTextContent('will send when online');
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 0.5h' }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('will send when online'));
    expect(onClose).toHaveBeenCalled();
  });

  it('offline: a queued entry refused on reconnect raises an error toast', async () => {
    onlineMock.mockReturnValue(false);
    setTasks([task('a', 'Write spec')]);
    mutateAsync.mockRejectedValue(new Error('refused'));
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 0.5h' }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('refused')),
    );
  });

  it('going offline mid-Save leaves the saving state and queues the write', async () => {
    setTasks([task('a', 'Write spec')]);
    mutateAsync.mockReturnValue(new Promise(() => undefined)); // paused
    const onClose = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save 0.5h' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeInTheDocument();
    window.dispatchEvent(new Event('offline'));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('will send when online'));
  });

  it('the Save total counts only listed tasks', async () => {
    setTasks([task('a', 'Write spec')]);
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Increase hours on Write spec' }));
    expect(screen.getByRole('button', { name: 'Save 0.5h' })).toBeInTheDocument();
  });

  it('closing through the timesheet link does not ask for focus restoration', async () => {
    setTasks([]);
    const onClose = renderSheet();
    await userEvent.click(screen.getByRole('link', { name: /timesheet/i }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('empty state links to the timesheet', () => {
    setTasks([]);
    renderSheet();
    expect(screen.getByTestId('quicklog-empty')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /timesheet/i })).toHaveAttribute(
      'href',
      '/me/timesheet',
    );
    expect(screen.queryByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
  });
});
