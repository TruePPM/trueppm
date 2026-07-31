/**
 * Feedback dialog (#2392).
 *
 * The premise of the feature is "a link, not a beacon", so the load-bearing
 * assertion is a negative one: opening this dialog must make no network request
 * at all. Everything else follows from that.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeedbackDialog } from './FeedbackDialog';

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
    render(<FeedbackDialog onClose={vi.fn()} />);
    // This is the whole promise of the feature. A self-hosted, potentially
    // air-gapped instance must not phone home because a control was rendered.
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('says plainly that nothing is sent from the dialog', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByText(/Nothing is sent from here/)).toBeInTheDocument();
  });

  it('withholds the referrer, which would leak the URL this feature strips', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });
});

describe('FeedbackDialog — what the user sees before leaving', () => {
  it('shows the build, edition and screen it would report', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents');
    expect(body.value).toContain('0.4.0-beta.1');
    expect(body.value).toContain('community');
    expect(body.value).toContain('/projects/:id/board');
  });

  it('does NOT show the project id or the search term from the URL', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).not.toContain('3f2504e0');
    expect(body).not.toContain('Acme');
  });

  it('picks up the build identity when it arrives after mount', () => {
    // The `['edition']` query is not guaranteed warm when the dialog opens — the
    // report must not freeze the placeholder it rendered while that was in flight.
    buildInfo = { edition: 'community', version: 'unknown', buildSha: '' };
    const { rerender } = render(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Report contents').value).toContain('unknown');

    buildInfo = { ...RESOLVED_BUILD };
    rerender(<FeedbackDialog onClose={vi.fn()} />);
    const body = screen.getByLabelText<HTMLTextAreaElement>('Report contents').value;
    expect(body).toContain('0.4.0-beta.1');
    expect(body).not.toContain('unknown');
  });

  it('keeps the user edit when the build identity resolves underneath it', () => {
    buildInfo = { edition: 'community', version: 'unknown', buildSha: '' };
    const { rerender } = render(<FeedbackDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Report contents'), {
      target: { value: 'my own words' },
    });

    buildInfo = { ...RESOLVED_BUILD };
    rerender(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Report contents').value).toBe(
      'my own words',
    );
  });

  it('lets the user edit the body before it travels', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
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

describe('FeedbackDialog — operator control', () => {
  it('defaults to the public tracker when no URL is configured', () => {
    render(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'href',
      expect.stringContaining('gitlab.com/trueppm/trueppm'),
    );
  });

  it('uses the operator tracker when one is set', () => {
    workspaceData.feedbackUrl = 'https://helpdesk.internal/new';
    render(<FeedbackDialog onClose={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Continue to tracker' })).toHaveAttribute(
      'href',
      expect.stringContaining('helpdesk.internal'),
    );
  });
});
