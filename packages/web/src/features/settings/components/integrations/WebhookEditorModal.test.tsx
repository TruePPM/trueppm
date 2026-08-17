/**
 * WebhookEditorModal — create/edit flow + delivery log (#849).
 *
 * The webhook mutation hooks were previously only stubbed by consumers, so
 * nothing asserted the modal wires create vs. update correctly, enforces its
 * client-side validation, or renders the delivery log. These tests mock the
 * hooks and exercise the real events catalog.
 */
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import type { ApiWebhook } from '@/hooks/useWebhooks';
import { WebhookEditorModal } from './WebhookEditorModal';

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  createPending: false,
  updatePending: false,
  deliveries: vi.fn(() => ({ data: [] as unknown[] | undefined, isLoading: false })),
}));

vi.mock('@/hooks/useWebhooks', () => ({
  useCreateWebhook: () => ({ mutate: h.createMutate, isPending: h.createPending }),
  useUpdateWebhook: () => ({ mutate: h.updateMutate, isPending: h.updatePending }),
  useWebhookDeliveries: (...args: unknown[]) => h.deliveries(...(args as [])),
}));

const SCOPE = { kind: 'project' as const, id: 'p1' };

/** Callback bag the modal hands the mutation (`onSuccess` / `onError`). */
interface MutationCallbacks {
  onSuccess: () => void;
  onError: (e: Error) => void;
}

/** An axios-shaped rejection carrying a DRF error body. */
function axiosError(data: unknown): Error {
  const err = new AxiosError('Request failed with status code 400');
  err.response = { status: 400, data } as AxiosResponse;
  return err;
}

function makeWebhook(overrides: Partial<ApiWebhook> = {}): ApiWebhook {
  return {
    id: 'w1',
    project: 'p1',
    program: null,
    url: 'https://old.example/hook',
    events: ['task.created'],
    format: 'slack',
    is_active: true,
    secret_set: true,
    consecutive_failures: 0,
    last_failure_at: null,
    last_failure_reason: '',
    disabled_at: null,
    disabled_reason: '',
    created_at: '2026-06-01T00:00:00Z',
    created_by: null,
    ...overrides,
  };
}

/**
 * The format chips live inside the `Field` <label>, which implicitly labels the
 * first button in it — so the Generic chip's accessible name is the whole label.
 * Address it by its unique title instead.
 */
function genericFormatButton(): HTMLElement {
  return screen.getByTitle('Raw event envelope.');
}

/** A hand-typed secret that clears the 32-character floor (MIN_SECRET_LENGTH). */
const LONG_SECRET = 'whsec_' + 'a'.repeat(40);

/** Uncheck "Generate a secret for me" so the manual secret input is rendered. */
function declineGeneratedSecret() {
  fireEvent.click(screen.getByLabelText(/Generate a secret for me/));
}

/** Fill the create form with a valid URL, one event, and a typed secret. */
function fillValidCreateForm() {
  fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
    target: { value: 'https://example.com/hook' },
  });
  selectEvent('task.created');
  declineGeneratedSecret();
  fireEvent.change(screen.getByPlaceholderText('whsec_…'), { target: { value: LONG_SECRET } });
}

function selectEvent(eventId: string) {
  const checkbox = screen
    .getByText(eventId)
    .closest('label')!
    .querySelector('input[type="checkbox"]') as HTMLInputElement;
  fireEvent.click(checkbox);
}

beforeEach(() => {
  h.createMutate.mockReset();
  h.updateMutate.mockReset();
  h.createPending = false;
  h.updatePending = false;
  h.deliveries.mockReset();
  h.deliveries.mockReturnValue({ data: [], isLoading: false });
});

describe('WebhookEditorModal', () => {
  beforeEach(() => {
    h.createMutate.mockReset();
    h.updateMutate.mockReset();
    h.createPending = false;
    h.updatePending = false;
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
    declineGeneratedSecret();
    fireEvent.change(screen.getByPlaceholderText('whsec_…'), {
      target: { value: LONG_SECRET },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    expect(h.createMutate).toHaveBeenCalledTimes(1);
    const [body, callbacks] = h.createMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onSuccess: (created: ApiWebhook) => void; onError: (e: Error) => void },
    ];
    expect(body).toEqual({
      url: 'https://example.com/hook',
      events: ['task.created'],
      format: 'slack',
      secret: LONG_SECRET,
    });
    // The modal owns the success → onSaved bridge. A hand-typed secret is not
    // echoed by the API, so there is nothing to show and the modal just closes.
    callbacks.onSuccess(makeWebhook());
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('edits an existing webhook via the update hook (secret optional)', () => {
    const webhook = makeWebhook();
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
    const webhook = makeWebhook();
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
    const webhook = makeWebhook();
    render(
      <WebhookEditorModal scope={SCOPE} webhook={webhook} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();
  });
});

describe('WebhookEditorModal — event selection', () => {
  it('requires a signing secret on create when generation is declined', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    selectEvent('task.created');
    declineGeneratedSecret();

    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    expect(screen.getByRole('alert')).toHaveTextContent('A signing secret is required.');
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it('toggles an event back off, restoring the empty selection', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('0 selected')).toBeInTheDocument();

    selectEvent('task.created');
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    selectEvent('task.created');
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });

  it('preserves event ids the picker cannot render instead of deleting them', () => {
    // This assertion is inverted from what it used to be, and that inversion IS the
    // fix (#2883). The modal narrowed a saved webhook to its own catalog and PATCHed
    // the narrowed list, so opening an API-created webhook to fix a URL typo silently
    // deleted every subscription the picker had not caught up with — eight real OSS
    // events at the time the drift was found. The guard was written to strip
    // *Enterprise* ids like `portfolio.rebalanced`; it could not tell them apart from
    // real ones, and destroying a valid subscription is far worse than carrying an
    // inert id the backend simply never fires.
    render(
      <WebhookEditorModal
        scope={SCOPE}
        webhook={makeWebhook({ events: ['task.created', 'portfolio.rebalanced'] })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const [arg] = h.updateMutate.mock.calls[0] as [{ body: Record<string, unknown> }];
    expect(arg.body.events).toEqual(['task.created', 'portfolio.rebalanced']);
  });

  it('lists an unrenderable id in its own section so it can be cleared deliberately', () => {
    render(
      <WebhookEditorModal
        scope={SCOPE}
        webhook={makeWebhook({ events: ['task.created', 'portfolio.rebalanced'] })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('Other subscriptions')).toBeInTheDocument();

    // Unchecking it is a decision, and that decision is honored.
    selectEvent('portfolio.rebalanced');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const [arg] = h.updateMutate.mock.calls[0] as [{ body: Record<string, unknown> }];
    expect(arg.body.events).toEqual(['task.created']);
  });

  it('offers every backend event, including the sprint / risk / baseline / comment cohorts', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    for (const id of [
      'sprint.activated',
      'sprint.closed',
      'sprint.scope_changed',
      'risk.opened',
      'risk.escalated',
      'risk.closed',
      'baseline.captured',
      'comment.created',
    ]) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  it('sends the rotated secret when one is typed while editing', () => {
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/unchanged/), {
      target: { value: `  ${LONG_SECRET}  ` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const [arg] = h.updateMutate.mock.calls[0] as [{ body: Record<string, unknown> }];
    expect(arg.body.secret).toBe(LONG_SECRET);
  });
});

describe('WebhookEditorModal — format picker', () => {
  it('drops the Slack preview and sends the generic format when Generic is picked', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByText('Slack render example')).toBeInTheDocument();

    fireEvent.click(genericFormatButton());
    expect(screen.queryByText('Slack render example')).not.toBeInTheDocument();

    fillValidCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    const [body] = h.createMutate.mock.calls[0] as [Record<string, unknown>];
    expect(body.format).toBe('generic');
  });

  it('marks the active format pressed and leaves Enterprise formats disabled', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Slack$/ })).toHaveAttribute('aria-pressed', 'true');
    const discord = screen.getByRole('button', { name: 'DiscordEnterprise' });
    expect(discord).toBeDisabled();
    expect(within(discord).getByText('Enterprise')).toBeInTheDocument();
  });

  it('starts on the saved format when editing a generic webhook', () => {
    render(
      <WebhookEditorModal
        scope={SCOPE}
        webhook={makeWebhook({ format: 'generic' })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.queryByText('Slack render example')).not.toBeInTheDocument();
    expect(genericFormatButton()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('WebhookEditorModal — dismissal', () => {
  it('closes on Escape, the ✕ button, and Cancel', () => {
    const onClose = vi.fn();
    render(<WebhookEditorModal scope={SCOPE} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('closes on a backdrop press but not on a press inside the panel', () => {
    const onClose = vi.fn();
    render(<WebhookEditorModal scope={SCOPE} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole('heading', { name: 'New webhook' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks every dismissal path while a save is in flight', () => {
    h.createPending = true;
    const onClose = vi.fn();
    render(<WebhookEditorModal scope={SCOPE} onClose={onClose} onSaved={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the saving label while an edit is in flight', () => {
    h.updatePending = true;
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  });
});

describe('WebhookEditorModal — server error surfacing', () => {
  function submitCreateAndFailWith(err: Error): void {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fillValidCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));
    const [, callbacks] = h.createMutate.mock.calls[0] as [Record<string, unknown>, MutationCallbacks];
    act(() => callbacks.onError(err));
  }

  it('renders the first DRF list message with its field prefix', () => {
    submitCreateAndFailWith(axiosError({ url: ['Enter a valid URL.'] }));
    expect(screen.getByRole('alert')).toHaveTextContent('url: Enter a valid URL.');
  });

  it('renders a scalar DRF message', () => {
    submitCreateAndFailWith(axiosError({ detail: 'Not allowed here.' }));
    expect(screen.getByRole('alert')).toHaveTextContent('detail: Not allowed here.');
  });

  it('falls back to a generic message for an empty DRF body', () => {
    submitCreateAndFailWith(axiosError({}));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
  });

  it('falls back to a generic message for a non-axios failure', () => {
    submitCreateAndFailWith(new Error('network down'));
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
  });

  it('surfaces an update failure and clears it once the form re-validates', () => {
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const [, callbacks] = h.updateMutate.mock.calls[0] as [
      { id: string; body: Record<string, unknown> },
      MutationCallbacks,
    ];
    act(() => callbacks.onError(axiosError({ events: ['Unknown event.'] })));
    expect(screen.getByRole('alert')).toHaveTextContent('events: Unknown event.');

    // A second valid submit clears the banner before dispatching again.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(h.updateMutate).toHaveBeenCalledTimes(2);
  });

  it('bridges an update success to onSaved', () => {
    const onSaved = vi.fn();
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={onSaved} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const [, callbacks] = h.updateMutate.mock.calls[0] as [
      { id: string; body: Record<string, unknown> },
      MutationCallbacks,
    ];
    callbacks.onSuccess();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('WebhookEditorModal — delivery log', () => {
  it('shows a busy placeholder while deliveries load', () => {
    h.deliveries.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByText('No deliveries yet.')).not.toBeInTheDocument();
  });

  it('shows the empty state when the delivery query resolves to nothing', () => {
    h.deliveries.mockReturnValue({ data: undefined, isLoading: false });
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('No deliveries yet.')).toBeInTheDocument();
  });

  it('renders failed and pending deliveries, falling back to the status word', () => {
    h.deliveries.mockReturnValue({
      data: [
        {
          id: 'd1',
          event_type: 'task.updated',
          sequence_number: 9,
          status: 'failed',
          response_status: 500,
        },
        {
          id: 'd2',
          event_type: 'task.deleted',
          sequence_number: 10,
          status: 'pending',
          response_status: null,
        },
      ],
      isLoading: false,
    });
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.getByText('500')).toBeInTheDocument();
    // No HTTP status yet → the raw delivery status is shown instead.
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('#9')).toBeInTheDocument();
    expect(screen.getByText('#10')).toBeInTheDocument();
  });

  it('does not query deliveries at all in create mode', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByText('Recent deliveries')).not.toBeInTheDocument();
    expect(h.deliveries).not.toHaveBeenCalled();
  });
});

describe('WebhookEditorModal — signing secret (#2885)', () => {
  it('defaults to generating a secret and omits the field from the create body', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    // The manual input is not even rendered while generation is on.
    expect(screen.queryByPlaceholderText('whsec_…')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    selectEvent('task.created');
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    const [body] = h.createMutate.mock.calls[0] as [Record<string, unknown>];
    // Omitted, not blank: the server auto-generates only when the field is absent
    // or empty, and this is the path that reaches its 256-bit generator.
    expect(body).not.toHaveProperty('secret');
  });

  it('rejects a hand-typed secret below the server floor before it round-trips', () => {
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    selectEvent('task.created');
    declineGeneratedSecret();
    fireEvent.change(screen.getByPlaceholderText('whsec_…'), { target: { value: 'whsec_hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    expect(screen.getByRole('alert')).toHaveTextContent('at least 32 characters');
    expect(h.createMutate).not.toHaveBeenCalled();
  });

  it('shows the one-time secret echo instead of discarding it', () => {
    const onSaved = vi.fn();
    render(<WebhookEditorModal scope={SCOPE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText('https://hooks.slack.com/services/…'), {
      target: { value: 'https://example.com/hook' },
    });
    selectEvent('task.created');
    fireEvent.click(screen.getByRole('button', { name: 'Create webhook' }));

    const [, callbacks] = h.createMutate.mock.calls[0] as [
      Record<string, unknown>,
      { onSuccess: (created: ApiWebhook) => void },
    ];
    act(() => callbacks.onSuccess(makeWebhook({ secret: 'generated-256-bit-value' })));

    // The modal must NOT close yet — there is no read path to this value again.
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Webhook created' })).toBeInTheDocument();
    expect(screen.getByLabelText('Generated signing secret')).toHaveValue('generated-256-bit-value');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('WebhookEditorModal — auto-disable notice (#2884)', () => {
  it('explains why deliveries stopped when the failure guard fired', () => {
    render(
      <WebhookEditorModal
        scope={SCOPE}
        webhook={makeWebhook({
          is_active: false,
          consecutive_failures: 5,
          disabled_at: '2026-08-17T10:00:00Z',
          disabled_reason: 'Automatically deactivated after 5 consecutive failed deliveries.',
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('Deliveries paused automatically')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('5 consecutive failed deliveries');
  });

  it('shows no notice on a healthy webhook', () => {
    render(
      <WebhookEditorModal scope={SCOPE} webhook={makeWebhook()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.queryByText('Deliveries paused automatically')).not.toBeInTheDocument();
  });
});
