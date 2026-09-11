/**
 * Feedback dialog (#2392).
 *
 * The premise of the feature is "a link, not a beacon", so the load-bearing
 * assertion is a negative one: opening this dialog must make no network request
 * at all. Everything else follows from that.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackDialog } from './FeedbackDialog';

const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/**
 * The component now calls `useQueryClient()` (#3388), so every render needs a
 * provider in the tree. A fresh client per call, optionally pre-seeded — the
 * seed is what lets a test simulate "the Schedule/Board view already fetched
 * this project's tasks" without the dialog itself making a request.
 */
function renderDialog(seed?: { key: unknown[]; data: unknown }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) queryClient.setQueryData(seed.key, seed.data);
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackDialog onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: {
    get: (...a: unknown[]) => {
      apiGet(...a);
    },
    post: (...a: unknown[]) => {
      apiPost(...a);
    },
  },
}));
const RESOLVED_BUILD = {
  edition: 'community',
  version: '0.4.0-beta.1',
  buildSha: 'deadbeefcafe',
};
/** Mutable so a test can mount against the in-flight state and then resolve it. */
let buildInfo = { ...RESOLVED_BUILD };
vi.mock('@/hooks/useEdition', () => ({
  useBuildInfo: () => buildInfo,
}));
const workspaceData = { feedbackEnabled: true, feedbackUrl: '' };
vi.mock('@/features/settings/hooks/useWorkspaceSettings', () => ({
  useWorkspaceSettings: () => ({ data: workspaceData, isLoading: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  buildInfo = { ...RESOLVED_BUILD };
  workspaceData.feedbackUrl = '';
  window.history.pushState({}, '', '/projects/3f2504e0-4f89-11d3-9a0c-0305e82c3301/board?q=Acme');
});

describe('FeedbackDialog — a link, not a beacon', () => {
  it('makes NO network request when opened', () => {
    renderDialog();
    // This is the whole promise of the feature. A self-hosted, potentially
    // air-gapped instance must not phone home because a control was rendered.
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('says plainly that nothing is sent from the dialog', () => {
    renderDialog();
    expect(screen.getByText(/Nothing is sent from here/)).toBeInTheDocument();
  });

  it('withholds the referrer, which would leak the URL this feature strips', () => {
    renderDialog();
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });
});

describe('FeedbackDialog — what the user sees before leaving', () => {
  it('shows the build, edition and screen it would report', () => {
    renderDialog();
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents');
    expect(body.value).toContain('0.4.0-beta.1');
    expect(body.value).toContain('community');
    expect(body.value).toContain('/projects/:id/board');
  });

  it('does NOT show the project id or the search term from the URL', () => {
    renderDialog();
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).not.toContain('3f2504e0');
    expect(body).not.toContain('Acme');
  });

  it('picks up the build identity when it arrives after mount', () => {
    // The `['edition']` query is not guaranteed warm when the dialog opens — the
    // report must not freeze the placeholder it rendered while that was in flight.
    buildInfo = { edition: 'community', version: 'unknown', buildSha: '' };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <FeedbackDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Report contents').value).toContain(
      'unknown',
    );

    buildInfo = { ...RESOLVED_BUILD };
    rerender(
      <QueryClientProvider client={queryClient}>
        <FeedbackDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).toContain('0.4.0-beta.1');
    expect(body).not.toContain('unknown');
  });

  it('keeps the user edit when the build identity resolves underneath it', () => {
    buildInfo = { edition: 'community', version: 'unknown', buildSha: '' };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <FeedbackDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText('Report contents'), {
      target: { value: 'my own words' },
    });

    buildInfo = { ...RESOLVED_BUILD };
    rerender(
      <QueryClientProvider client={queryClient}>
        <FeedbackDialog onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Report contents').value).toBe(
      'my own words',
    );
  });

  it('lets the user edit the body before it travels', () => {
    renderDialog();
    const body = screen.getByLabelText('Report contents');
    fireEvent.change(body, { target: { value: 'my own words' } });

    // "Here is what we would send" is not a real promise unless it is editable
    // — and the edit has to be what actually leaves.
    const href = screen.getByRole('link', { name: 'Continue to tracker' }).getAttribute('href');
    // Read the param rather than decoding the raw string: form encoding writes
    // spaces as `+`, which decodeURIComponent leaves alone.
    const sent = new URL(href ?? '').searchParams.get('issue[description]');
    expect(sent).toBe('my own words');
  });
});

describe('FeedbackDialog — project size (#3388)', () => {
  it('reports the task count from the already-warm Schedule/Board cache', () => {
    renderDialog({
      key: ['tasks', PROJECT_ID],
      data: Array.from({ length: 1234 }, (_, i) => ({ id: `t${i}` })),
    });
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).toContain('Project size: 1,234 tasks');
  });

  it('falls back to the project-overview cache when the task list is not loaded', () => {
    renderDialog({
      key: ['project-overview', PROJECT_ID],
      data: { total_tasks: 57 },
    });
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).toContain('Project size: 57 tasks');
  });

  it('omits the line when neither cache is warm, rather than reporting 0', () => {
    renderDialog();
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).not.toContain('Project size');
  });

  it('omits the line off a project route, even if a stray cache entry exists', () => {
    window.history.pushState({}, '', '/me/work');
    renderDialog({ key: ['tasks', PROJECT_ID], data: [{ id: 't1' }] });
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).not.toContain('Project size');
  });

  it('opening the dialog makes no request to warm either cache', () => {
    // Same promise as the top-level "no network request" spec, restated for
    // this field specifically: a cache MISS must stay a miss, never trigger a
    // fetch to go find out.
    renderDialog();
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });
});

describe('FeedbackDialog — operator control', () => {
  it('defaults to the public tracker when no URL is configured', () => {
    renderDialog();
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'href',
      expect.stringContaining('gitlab.com/trueppm/trueppm'),
    );
  });

  it('uses the operator tracker when one is set', () => {
    workspaceData.feedbackUrl = 'https://helpdesk.internal/new';
    renderDialog();
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'href',
      expect.stringContaining('helpdesk.internal'),
    );
  });
});
