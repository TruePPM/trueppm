import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SprintCloseFailedBanner } from './SprintCloseFailedBanner';

const SERVER_MESSAGE =
  'The close failed and will not be retried. The sprint is still open — ask a project admin for the details.';

function renderBanner(overrides: Partial<Parameters<typeof SprintCloseFailedBanner>[0]> = {}) {
  return render(
    <SprintCloseFailedBanner
      sprintName="Sprint Alpha"
      iterationLabel="sprint"
      errorMessage={SERVER_MESSAGE}
      attemptCount={3}
      onRetry={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe('SprintCloseFailedBanner (#2992)', () => {
  it('is an assertive alert, not a polite status', () => {
    // It reverses a success the user was already told about — the close toast
    // fired on the 202. The sibling RetroHandoffBanner is role="status"
    // precisely because it never contradicts anything.
    renderBanner();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('names the sprint and says it is still open', () => {
    renderBanner();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Sprint Alpha');
    // The fact that changes what the user does next.
    expect(alert).toHaveTextContent('still open');
  });

  it('renders the server-authored message verbatim', () => {
    // The banner must not derive copy from failure_reason: error_message is
    // role-gated server-side (raw text for Admins, a summary sentence for
    // everyone else), so any client-side substitute would either disagree with
    // the API or leak past the gate.
    renderBanner();
    expect(screen.getByRole('alert')).toHaveTextContent('ask a project admin');
  });

  it('respects the iteration label', () => {
    renderBanner({ iterationLabel: 'iteration' });
    expect(screen.getByRole('alert')).toHaveTextContent('the iteration is still open');
  });

  it('reports the attempt count, singular and plural', () => {
    const { unmount } = renderBanner({ attemptCount: 1 });
    expect(screen.getByRole('alert')).toHaveTextContent('Tried once.');
    unmount();
    renderBanner({ attemptCount: 3 });
    expect(screen.getByRole('alert')).toHaveTextContent('Tried 3 times.');
  });

  it('says nothing further will be retried', () => {
    // The banner only ever renders for a terminal outcome, so it must not leave
    // the user waiting for a recovery that will never come.
    renderBanner();
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing else will be retried');
  });

  it('hides the retry control when a retry is not currently possible', () => {
    // Rendering it anyway would give the user a button that dismisses the only
    // record of the error and opens nothing — the dialog it drives operates on
    // whatever sprint is active, which in that state is not this one.
    renderBanner({ onRetry: undefined });
    expect(screen.queryByRole('button', { name: 'Try closing again' })).toBeNull();
    // Dismiss stays available — the banner must never become untidyable.
    expect(screen.getByRole('button', { name: 'Dismiss close failure' })).toBeInTheDocument();
  });

  it('fires onRetry from the retry control', async () => {
    const onRetry = vi.fn();
    renderBanner({ onRetry });
    await userEvent.click(screen.getByRole('button', { name: 'Try closing again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('fires onDismiss from the dismiss control', async () => {
    const onDismiss = vi.fn();
    renderBanner({ onDismiss });
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss close failure' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
