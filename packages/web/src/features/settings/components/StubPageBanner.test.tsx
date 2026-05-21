import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubPageBanner } from './StubPageBanner';

describe('<StubPageBanner>', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('renders the preview message with a link to the page issue', () => {
    render(<StubPageBanner pageIssue={518} />);
    expect(screen.getByTestId('stub-page-banner')).toBeInTheDocument();
    expect(screen.getByText(/Preview/)).toBeInTheDocument();
    expect(screen.getByText(/your changes will not be saved yet/i)).toBeInTheDocument();

    const link = screen.getByRole('link', { name: '#518' });
    expect(link).toHaveAttribute('href', 'https://gitlab.com/trueppm/trueppm/-/issues/518');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('uses role="status" with polite live region for assistive tech', () => {
    render(<StubPageBanner pageIssue={518} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('persists dismissal in localStorage when the close button is clicked', async () => {
    const user = userEvent.setup();
    render(<StubPageBanner pageIssue={520} />);

    await user.click(screen.getByRole('button', { name: /dismiss preview banner/i }));

    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
    expect(localStorage.getItem('trueppm.settings.stub-banner-dismissed.520')).toBe('1');
  });

  it('stays hidden on subsequent mounts when already dismissed', () => {
    localStorage.setItem('trueppm.settings.stub-banner-dismissed.523', '1');

    render(<StubPageBanner pageIssue={523} />);

    expect(screen.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });

  it('dismissal is keyed per-issue: dismissing one banner does not dismiss another', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<StubPageBanner pageIssue={518} />);
    await user.click(screen.getByRole('button', { name: /dismiss preview banner/i }));
    unmount();

    render(<StubPageBanner pageIssue={519} />);
    expect(screen.getByTestId('stub-page-banner')).toBeInTheDocument();
  });

  // Reason: previous implementation used sessionStorage and re-appeared on every
  // new tab. After #592, a banner dismissed in one tab must stay dismissed in a
  // newly-opened tab (same origin) — that's what localStorage gives us.
  it('stays dismissed across a simulated new tab (no remount-time reset)', () => {
    localStorage.setItem('trueppm.settings.stub-banner-dismissed.518', '1');

    // First "tab"
    const first = render(<StubPageBanner pageIssue={518} />);
    expect(first.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
    first.unmount();

    // Second "tab" — fresh mount, localStorage persists, banner stays hidden
    const second = render(<StubPageBanner pageIssue={518} />);
    expect(second.queryByTestId('stub-page-banner')).not.toBeInTheDocument();
  });
});
