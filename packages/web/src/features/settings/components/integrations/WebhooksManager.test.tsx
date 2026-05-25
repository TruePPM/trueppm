import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhooksManager } from './WebhooksManager';
import type { ApiWebhook } from '@/hooks/useWebhooks';

const useWebhooks = vi.fn();
const deleteMutate = vi.fn();
const testMutate = vi.fn();

vi.mock('@/hooks/useWebhooks', () => ({
  useWebhooks: () => useWebhooks() as unknown,
  useDeleteWebhook: () => ({ mutate: deleteMutate, isPending: false }),
  useTestWebhook: () => ({ mutate: testMutate, isPending: false }),
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
  created_at: '2026-05-20T12:00:00Z',
  created_by: null,
};

beforeEach(() => {
  useWebhooks.mockReset();
  deleteMutate.mockReset();
  testMutate.mockReset();
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
});
