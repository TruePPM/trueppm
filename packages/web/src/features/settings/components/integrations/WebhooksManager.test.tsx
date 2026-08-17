import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhooksManager } from './WebhooksManager';
import type { ApiWebhook } from '@/hooks/useWebhooks';

const useWebhooks = vi.fn();
const deleteMutate = vi.fn();
const testMutate = vi.fn();
const testReset = vi.fn();
/** What `useWebhookTestResult` reports back — the receiver's real answer (#2884). */
const testResult = vi.fn(() => ({ data: null as unknown }));

vi.mock('@/hooks/useWebhooks', () => ({
  useWebhooks: () => useWebhooks() as unknown,
  useDeleteWebhook: () => ({ mutate: deleteMutate, isPending: false }),
  useTestWebhook: () => ({
    mutate: testMutate,
    reset: testReset,
    isPending: false,
    isError: false,
  }),
  useWebhookTestResult: () => testResult(),
}));

// The editor modal has its own tests; here it's a marker so we can assert it opens.
vi.mock('./WebhookEditorModal', () => ({
  WebhookEditorModal: ({ webhook }: { webhook?: ApiWebhook }) => (
    <div data-testid="webhook-editor">{webhook ? `edit:${webhook.id}` : 'create'}</div>
  ),
}));

const SCOPE = { kind: 'project' as const, id: 'p-1' };

const WEBHOOK: ApiWebhook = {
  id: 'wh-1',
  project: 'p-1',
  program: null,
  url: 'https://hooks.slack.com/services/X/Y/Z',
  events: ['task.created', 'task.assigned'],
  format: 'slack',
  is_active: true,
  secret_set: true,
  consecutive_failures: 0,
  last_failure_at: null,
  last_failure_reason: '',
  disabled_at: null,
  disabled_reason: '',
  created_at: '2026-05-20T12:00:00Z',
  created_by: null,
};

beforeEach(() => {
  useWebhooks.mockReset();
  deleteMutate.mockReset();
  testMutate.mockReset();
  testReset.mockReset();
  testResult.mockReset();
  testResult.mockReturnValue({ data: null });
});

describe('WebhooksManager', () => {
  it('shows a loading skeleton', () => {
    useWebhooks.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    expect(screen.getByLabelText('Loading webhooks')).toBeInTheDocument();
  });

  it('shows the empty state when there are no webhooks', () => {
    useWebhooks.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    expect(screen.getByText(/No webhooks yet/i)).toBeInTheDocument();
  });

  it('renders a webhook row with url, event count and format', () => {
    useWebhooks.mockReturnValue({ data: [WEBHOOK], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    expect(screen.getByText('https://hooks.slack.com/services/X/Y/Z')).toBeInTheDocument();
    expect(screen.getByText('2 events')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('opens the editor in create mode when New webhook is clicked', () => {
    useWebhooks.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'New webhook' }));
    expect(screen.getByTestId('webhook-editor')).toHaveTextContent('create');
  });

  it('sends a test ping when Test is clicked', () => {
    useWebhooks.mockReturnValue({ data: [WEBHOOK], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(testMutate).toHaveBeenCalledWith('wh-1', expect.anything());
  });

  it('reports the receiver\'s real answer, not the enqueue ack (#2884)', () => {
    // The old button flipped to "Sent ✓" in the POST's onSuccess. Because the ping
    // also skipped the format renderer, a Slack-format webhook — the default — was
    // guaranteed to fail while the UI claimed success. The button now waits for the
    // delivery row.
    useWebhooks.mockReturnValue({ data: [WEBHOOK], isLoading: false, isError: false, refetch: vi.fn() });
    testResult.mockReturnValue({
      data: { id: 'd1', status: 'failed', response_status: 400 } as unknown,
    });
    render(<WebhooksManager scope={SCOPE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const [, callbacks] = testMutate.mock.calls[0] as [
      string,
      { onSuccess: (d: { delivery_id: string }) => void },
    ];
    act(() => callbacks.onSuccess({ delivery_id: 'd1' }));

    expect(screen.getByRole('button', { name: 'Failed 400' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delivered/ })).not.toBeInTheDocument();
  });

  it('reports a delivered ping once the row settles', () => {
    useWebhooks.mockReturnValue({ data: [WEBHOOK], isLoading: false, isError: false, refetch: vi.fn() });
    testResult.mockReturnValue({
      data: { id: 'd1', status: 'success', response_status: 200 } as unknown,
    });
    render(<WebhooksManager scope={SCOPE} />);

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const [, callbacks] = testMutate.mock.calls[0] as [
      string,
      { onSuccess: (d: { delivery_id: string }) => void },
    ];
    act(() => callbacks.onSuccess({ delivery_id: 'd1' }));

    expect(screen.getByRole('button', { name: /Delivered/ })).toBeInTheDocument();
  });

  it('surfaces the auto-disable state on the row (#2884)', () => {
    useWebhooks.mockReturnValue({
      data: [{ ...WEBHOOK, is_active: false, consecutive_failures: 5, disabled_at: 'x' }],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<WebhooksManager scope={SCOPE} />);
    expect(screen.getByText('paused after 5 failures')).toBeInTheDocument();
  });

  it('confirms before deleting', () => {
    useWebhooks.mockReturnValue({ data: [WEBHOOK], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog', { name: /Delete webhook/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete webhook' }));
    expect(deleteMutate).toHaveBeenCalledWith('wh-1', expect.anything());
  });

  it('shows an error state with retry', () => {
    const refetch = vi.fn();
    useWebhooks.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<WebhooksManager scope={SCOPE} />);
    expect(screen.getByText(/Couldn.t load webhooks/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders explanatory copy scoped to the project (#597)', () => {
    useWebhooks.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={SCOPE} />);
    expect(
      screen.getByText(/Webhooks let external systems receive real-time events/i),
    ).toBeInTheDocument();
  });

  it('renders program-scoped explanatory copy at program scope (#597)', () => {
    useWebhooks.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() });
    render(<WebhooksManager scope={{ kind: 'program', id: 'prog-1' }} />);
    expect(
      screen.getByText(/Program webhooks let external systems receive real-time events/i),
    ).toBeInTheDocument();
  });
});
