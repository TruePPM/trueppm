/**
 * WebhookEditorModal — create/edit flow + delivery log (#849).
 *
 * The webhook mutation hooks were previously only stubbed by consumers, so
 * nothing asserted the modal wires create vs. update correctly, enforces its
 * client-side validation, or renders the delivery log. These tests mock the
 * hooks and exercise the real events catalog.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookEditorModal } from './WebhookEditorModal';

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  deliveries: vi.fn(() => ({ data: [] as unknown[], isLoading: false })),
}));

vi.mock('@/hooks/useWebhooks', () => ({
  useCreateWebhook: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateWebhook: () => ({ mutate: h.updateMutate, isPending: false }),
  useWebhookDeliveries: (...args: unknown[]) => h.deliveries(...(args as [])),
}));

const SCOPE = { kind: 'project' as const, id: 'p1' };

function selectEvent(eventId: string) {
  const checkbox = screen
    .getByText(eventId)
    .closest('label')!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(checkbox);
}

describe('WebhookEditorModal', () => {
  beforeEach(() => {
    h.createMutate.mockReset();
    h.updateMutate.mockReset();
    h.deliveries.mockReset();
    h.deliveries.mockReturnValue({ data: [], isLoading: false });
  });

  it('renders in create mode with the create affordances', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'New webhook' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create webhook' })).toBeInTheDocument();
  });

  it('blocks submit and surfaces a validation error when the URL is not https', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Endpoint URL must start with https://');
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it('requires at least one event before creating', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Select at least one event');
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it('creates the webhook and calls onSaved on success', () => {
    const onSaved = vi.fn();
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    selectEvent('task.created');
    fireEvent.change(screen.getByPlaceholderText('whsec_…'), {
      target: { value: 'whsec_abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    const [body, callbacks] = h.createMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onSuccess: () => void; onError: (e: Error) => void },
    ];
    expect(body).toEqual({
      url: 'https://example.com/hook',
      events: ['task.created'],
      format: 'slack',
      secret: 'whsec_abc',
    });
    // The modal owns the success → onSaved bridge.
    callbacks.onSuccess();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('edits an existing webhook via the update hook (secret optional)', () => {
    const webhook = {
      id: 'w1',
      project: 'p1',
      program: null,
      url: 'https://old.example/hook',
      events: ['task.created'],
      format: 'slack',
      is_active: true,
      created_at: '2026-06-01T00:00:00Z',
      created_by: null,
    };
    render(
      <WebhookEditorModal scope={SCOPE} webhook={webhook} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Edit webhook' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    const [arg] = h.updateMutate.mock.calls[0] as [{ id: string; body: Record<string, unknown> }];
    expect(arg).toMatchObject({
      id: 'w1',
      body: { url: 'https://old.example/hook', events: ['task.created'], format: 'slack' },
    });
    // Blank secret is omitted from the edit payload (keeps the stored one).
    expect(arg.body).not.toHaveProperty('secret');
  });

  it('shows the empty delivery state when editing a webhook with no deliveries', () => {
    h.deliveries.mockReturnValue({ data: [], isLoading: false });
    const webhook = {
      id: 'w1',
      project: 'p1',
      program: null,
      url: 'https://old.example/hook',
      events: ['task.created'],
      format: 'slack',
      is_active: true,
      created_at: '2026-06-01T00:00:00Z',
      created_by: null,
    };
    render(
      <WebhookEditorModal scope={SCOPE} webhook={webhook} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('No deliveries yet.')).toBeInTheDocument();
  });

  it('renders recent deliveries when present', () => {
    h.deliveries.mockReturnValue({
      data: [
        {
          id: 'd1',
          event_type: 'task.created',
          sequence_number: 7,
          status: 'success',
          response_status: 200,
        },
      ],
      isLoading: false,
    });
    const webhook = {
      id: 'w1',
      project: 'p1',
      program: null,
      url: 'https://old.example/hook',
      events: ['task.created'],
      format: 'slack',
      is_active: true,
      created_at: '2026-06-01T00:00:00Z',
      created_by: null,
    };
    render(
      <WebhookEditorModal scope={SCOPE} webhook={webhook} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
  });
});
