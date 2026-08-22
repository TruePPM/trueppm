import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PublishTemplateSheet } from './PublishTemplateSheet';
import type { PublishPreview } from '@/hooks/useProjectTemplates';

const h = vi.hoisted(() => ({
  publish: {
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null as unknown,
  },
}));

vi.mock('@/hooks/useProjectTemplates', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  usePublishTemplate: () => h.publish,
}));
vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));

const PREVIEW: PublishPreview = {
  task_count: 82,
  phase_count: 6,
  gate_count: 4,
  milestone_count: 5,
  dependency_count: 14,
  methodology: 'AGILE',
  carries: ['structure', 'dependencies', 'durations'],
  name_taken: false,
  next_version: 1,
  existing_template: null,
};

function open(preview: Partial<PublishPreview> = {}) {
  render(
    <PublishTemplateSheet
      projectId="p1"
      projectName="Vega Platform"
      preview={{ ...PREVIEW, ...preview }}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.publish.error = null;
  h.publish.isPending = false;
});

describe('PublishTemplateSheet — step 1', () => {
  it('states what carries and what is dropped, from the server counts', () => {
    open();
    expect(screen.getByText('Carried into every new project')).toBeInTheDocument();
    expect(screen.getByText(/82 tasks · 6 phases · 14 dependencies/)).toBeInTheDocument();
    expect(screen.getByText('Assignees and resources')).toBeInTheDocument();
  });

  it('renders the inventory as text, never as toggles', () => {
    // Per-publish "carries" switches make templates that differ invisibly, which
    // destroys the comparability templates exist for. Asserted, not assumed.
    open();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('will not advance without a name', async () => {
    open();
    await userEvent.clear(screen.getByRole('textbox', { name: /Template name/i }));
    expect(screen.getByRole('button', { name: 'Review and publish' })).toBeDisabled();
  });

  it('offers the next version when the name is taken, keeping what was typed', async () => {
    h.publish.error = {
      response: {
        status: 409,
        data: {
          code: 'name_taken',
          detail: '“Vega Platform delivery shape” already exists in this workspace (v2).',
          template: 't1',
          version: 2,
          next_version: 3,
        },
      },
    };
    open();
    expect(screen.getByRole('alert')).toHaveTextContent(/already exists in this workspace/);
    // A publish form that clears itself on a conflict is how people stop publishing.
    expect(screen.getByRole('textbox', { name: /Template name/i })).toHaveValue(
      'Vega Platform delivery shape',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Publish as v3 of that template' }));
    expect(h.publish.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ newVersion: true }),
      expect.anything(),
    );
  });
});

describe('PublishTemplateSheet — step 2', () => {
  async function toConfirm() {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Review and publish' }));
  }

  it('states consequences rather than repeating the fields', async () => {
    await toConfirm();
    expect(
      screen.getByText(/Changes nothing in Vega Platform, or in any running project/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Leaves behind everything that is not shape/)).toBeInTheDocument();
    // Silence is a feature: the moment publishing pings 12 PMs it becomes a
    // governance event and the delivery lead stops using it.
    expect(screen.getByText(/Nobody is notified/)).toBeInTheDocument();
  });

  it('publishes on confirm, not on the first screen', async () => {
    await toConfirm();
    expect(h.publish.mutate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Publish v1' }));
    expect(h.publish.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', newVersion: false }),
      expect.anything(),
    );
  });

  it('keeps the draft on a non-field failure', async () => {
    h.publish.error = { response: { status: 500 } };
    await toConfirm();
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was written/);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('textbox', { name: /Template name/i })).toHaveValue(
      'Vega Platform delivery shape',
    );
  });
});

describe('PublishTemplateSheet — the gallery card preview (#2970)', () => {
  it('shows the card as a delivery lead will meet it, seeded from the project name', () => {
    open();
    const card = screen.getByTestId('template-card-preview');
    expect(card).toHaveTextContent('Vega Platform delivery shape');
    expect(card).toHaveTextContent('Yours');
    expect(card).toHaveTextContent('AGILE');
    expect(card).toHaveTextContent('82 rows');
    expect(card).toHaveTextContent('carries 6 phases · 4 gates · 14 deps');
  });

  it('tracks the name as it is typed — the card is the thing being named', async () => {
    const user = userEvent.setup();
    open();
    const nameInput = screen.getByLabelText(/Template name/);
    await user.clear(nameInput);
    await user.type(nameInput, 'House scrum shape');
    expect(screen.getByTestId('template-card-preview')).toHaveTextContent('House scrum shape');
  });

  it('tracks the methodology, which predicts the landing surface', async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(screen.getByLabelText('Methodology'), 'WATERFALL');
    expect(screen.getByTestId('template-card-preview')).toHaveTextContent('WATERFALL');
  });

  it('shows the description once written — it is the only line that argues for it', async () => {
    const user = userEvent.setup();
    open();
    const card = screen.getByTestId('template-card-preview');
    // Falls back to the row count so the card is never a blank line.
    expect(card).toHaveTextContent('82 rows');
    await user.type(screen.getByLabelText(/Description/), 'For a feature team of six');
    expect(screen.getByTestId('template-card-preview')).toHaveTextContent(
      'For a feature team of six',
    );
  });

  it('never shows an empty name — a cleared field previews a placeholder, not nothing', async () => {
    const user = userEvent.setup();
    open();
    await user.clear(screen.getByLabelText(/Template name/));
    expect(screen.getByTestId('template-card-preview')).toHaveTextContent('Untitled template');
  });

  it('offers no choice: the preview is inert and not a focus stop', () => {
    open();
    const card = screen.getByTestId('template-card-preview');
    expect(card.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
    expect(card).not.toHaveAttribute('role', 'radio');
  });

  it('previews the version the publish will actually write', () => {
    open({ next_version: 3 });
    expect(screen.getByTestId('template-card-preview')).toHaveTextContent('v3');
  });
});
