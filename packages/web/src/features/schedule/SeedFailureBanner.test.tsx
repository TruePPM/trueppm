import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SeedFailureBanner } from './SeedFailureBanner';
import { ROLE_ADMIN, ROLE_MEMBER } from '@/lib/roles';

const { getMock, postMock, toastMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/client', () => ({ apiClient: { get: getMock, post: postMock } }));
vi.mock('@/components/Toast/toast', () => ({ toast: toastMock }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

const failedApplication = {
  id: 'app-1',
  template: 'tmpl-1',
  template_name: 'Kickoff skeleton',
  template_version: 1,
  project: 'proj-1',
  status: 'failed',
  result_summary: {},
  error_detail: 'Template no longer exists.',
  created_at: '2026-08-05T00:00:00Z',
  completed_at: '2026-08-05T00:00:01Z',
  undone_at: null,
};

function mockApplication(extra: Record<string, unknown> = {}) {
  getMock.mockImplementation((url: string) => {
    if (url.includes('/template-applications/')) {
      return Promise.resolve({ data: { ...failedApplication, ...extra } });
    }
    return Promise.resolve({ data: {} });
  });
}

function renderBanner(
  props: Partial<Parameters<typeof SeedFailureBanner>[0]> = {},
) {
  return render(
    <SeedFailureBanner
      projectId="proj-1"
      applicationId="app-1"
      currentRole={ROLE_ADMIN}
      onRetried={vi.fn()}
      onDismiss={vi.fn()}
      {...props}
    />,
    { wrapper },
  );
}

describe('SeedFailureBanner (#3348)', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    toastMock.error.mockClear();
    toastMock.success.mockClear();
    toastMock.info.mockClear();
  });

  it('states the failure, names the template, and says nothing was written', async () => {
    mockApplication();
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    // One occurrence now that the sr-only twin is gone, but getAllByText keeps this
    // assertion honest about presence rather than about count.
    expect(screen.getAllByText(/Kickoff skeleton/).length).toBeGreaterThan(0);
    // The reassurance clause is the whole point of the state: a failed apply is a
    // total rollback, and until #3348 nothing anywhere said so.
    expect(
      screen.getByText(/Nothing was written\. This project is exactly as empty as it was before\./),
    ).toBeInTheDocument();
  });

  it('surfaces error_detail verbatim', async () => {
    mockApplication({ error_detail: 'connection to server at "db" failed: timeout' });
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    expect(screen.getByTestId('seed-failure-banner-reason')).toHaveTextContent(
      'Reason: connection to server at "db" failed: timeout',
    );
  });

  it('falls back to a plain sentence when error_detail is empty', async () => {
    // Not "Reason: " with nothing after it — a dangling prefix reads as a
    // rendering bug rather than as an absent reason.
    mockApplication({ error_detail: '   ' });
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    expect(screen.getByTestId('seed-failure-banner-reason')).toHaveTextContent(
      "The server didn't record a reason.",
    );
    expect(screen.getByTestId('seed-failure-banner-reason')).not.toHaveTextContent('Reason:');
  });

  it('announces assertively, and the announcement includes the way out', async () => {
    mockApplication();
    renderBanner();

    const banner = await screen.findByTestId('seed-failure-banner');
    // role="alert" on the CONTAINER, not an sr-only twin: a terminal failure of an
    // explicitly requested act must interrupt, and announcing the container is what
    // makes the recovery sentence audible. A screen-reader user who hears what broke
    // but not the way out has been told the worse half. Static text — the status is
    // terminal and polling has stopped — so it cannot re-announce on a tick (rule 220).
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Nothing was written');
    expect(banner).toHaveTextContent('Reason: Template no longer exists.');
    expect(banner).toHaveTextContent('Try again, or just start building this project below.');
    // No sr-only twin restating what the container already announces.
    expect(screen.queryByTestId('seed-failure-banner-live')).not.toBeInTheDocument();
  });

  it('puts the recovery control before the dismiss in the DOM', async () => {
    // A first tab stop that destroys the surface's payload is the wrong first tab
    // stop — this banner is the only reader of `error_detail` anywhere in the web.
    mockApplication();
    renderBanner();

    const banner = await screen.findByTestId('seed-failure-banner');
    const order = Array.from(banner.querySelectorAll('button')).map((b) =>
      b.getAttribute('data-testid'),
    );
    expect(order).toEqual(['seed-failure-banner-retry', 'seed-failure-banner-dismiss']);
  });

  // The three states of the recovery sentence. Each names a DIFFERENT next act, and
  // each is the substitute for a control that is absent rather than disabled.
  it('offers retry to an admin whose template still exists', async () => {
    mockApplication();
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    expect(screen.getByTestId('seed-failure-banner-retry')).toHaveTextContent('Try again');
    expect(screen.getByTestId('seed-failure-banner-recovery')).toHaveTextContent(
      'Try again, or just start building this project below.',
    );
  });

  it('omits retry below Admin and points at one instead of showing a dead button', async () => {
    mockApplication();
    renderBanner({ currentRole: ROLE_MEMBER });

    await screen.findByTestId('seed-failure-banner');
    expect(screen.queryByTestId('seed-failure-banner-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('seed-failure-banner-recovery')).toHaveTextContent(
      'Ask a project admin to apply it again, or just start building this project below.',
    );
  });

  it('omits retry when the template was deleted, and says so — even for an admin', async () => {
    // `template: null` outranks the role. Telling somebody to ask an admin to do an
    // impossible thing is worse than saying nothing about it.
    mockApplication({ template: null });
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    expect(screen.queryByTestId('seed-failure-banner-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('seed-failure-banner-recovery')).toHaveTextContent(
      "This template no longer exists, so it can't be applied again. Start building this project below.",
    );
  });

  it('hands the retry-minted application id back to the parent', async () => {
    mockApplication();
    postMock.mockResolvedValue({ data: { queued: true, application: 'app-2' } });
    const onRetried = vi.fn();
    renderBanner({ onRetried });

    await screen.findByTestId('seed-failure-banner');
    fireEvent.click(screen.getByTestId('seed-failure-banner-retry'));

    await waitFor(() => expect(onRetried).toHaveBeenCalledWith('app-2'));
    expect(postMock).toHaveBeenCalledWith('/project-templates/tmpl-1/apply/', {
      project: 'proj-1',
    });
    // No success toast — the seeding skeleton that replaces this banner is the
    // confirmation, and a toast on top of it would be redundant.
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it('advises a retry when the refusal could plausibly clear', async () => {
    mockApplication();
    // Not an axios rejection, so nothing decided against the request — retryable.
    postMock.mockRejectedValue(new Error('network down'));
    const onRetried = vi.fn();
    renderBanner({ onRetried });

    await screen.findByTestId('seed-failure-banner');
    fireEvent.click(screen.getByTestId('seed-failure-banner-retry'));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Couldn't start the apply. Try again."),
    );
    expect(onRetried).not.toHaveBeenCalled();
    // The banner survives the refusal, so the original explanation is still on screen.
    expect(screen.getByTestId('seed-failure-banner')).toBeInTheDocument();
  });

  it("does NOT say 'Try again' when the server has already refused the retry", async () => {
    // The retry's own refusal is a DIFFERENT error from the one on screen: the role
    // can be lost since load, the project archived meanwhile. Advising a retry on a
    // 403 names the one act guaranteed not to help (rule 372).
    mockApplication();
    postMock.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 403, data: { detail: 'You do not have permission to do this.' } },
      }),
    );
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    fireEvent.click(screen.getByTestId('seed-failure-banner-retry'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    const message = toastMock.error.mock.calls[0][0] as string;
    expect(message).toContain('You do not have permission to do this.');
    expect(message).not.toContain('Try again');
  });

  it('dismisses', async () => {
    mockApplication();
    const onDismiss = vi.fn();
    renderBanner({ onDismiss });

    await screen.findByTestId('seed-failure-banner');
    fireEvent.click(screen.getByLabelText('Dismiss seed failure banner'));
    expect(onDismiss).toHaveBeenCalled();
  });

  // Rule 301: an unmapped or non-terminal status must fall through to the calm
  // branch, never into a red failure banner. These are the negative controls that
  // stop the gate from being `status !== 'success'`.
  it.each(['pending', 'running', 'success', 'undone', 'some_future_status'])(
    'renders nothing for status %s',
    async (status) => {
      mockApplication({ status });
      renderBanner();

      await expect(screen.findByTestId('seed-failure-banner')).rejects.toThrow();
    },
  );

  it('never offers undo — a failed apply is a total rollback with nothing to reverse', async () => {
    mockApplication();
    renderBanner();

    await screen.findByTestId('seed-failure-banner');
    expect(screen.queryByText(/Undo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete untouched/i)).not.toBeInTheDocument();
  });
});
