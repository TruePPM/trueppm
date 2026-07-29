import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StakeholderEmptyState, StakeholderReachSummary } from './StakeholderReachSummary';

/**
 * Reach summary copy contract (#2529, ADR-0697).
 *
 * The assertions that matter are the negative ones: no combined total, no version
 * number, no claim that external contacts are notified or emailed, and no
 * substituted number when the Viewer count is unavailable.
 */

function reachText(): string {
  return document.body.textContent ?? '';
}

describe('StakeholderReachSummary', () => {
  it('states both arms separately with distinct verbs', () => {
    render(<StakeholderReachSummary externalCount={3} viewerMemberCount={6} />);

    expect(screen.getByText(/3 external contacts — listed only\./)).toBeInTheDocument();
    expect(reachText()).toContain('No email or notification is sent to them yet');
    expect(reachText()).toContain('6 Viewer-role members get an in-app notification');
  });

  it('never renders a combined total', () => {
    render(<StakeholderReachSummary externalCount={3} viewerMemberCount={6} />);

    // 3 + 6 = 9 — the union number #1675 removed from the resolver must not
    // reappear in the UI.
    expect(reachText()).not.toContain('9');
    expect(reachText()).not.toMatch(/reaches 9|9 people|9 recipients/i);
  });

  it('never names a version and never claims externals are reached', () => {
    render(<StakeholderReachSummary externalCount={2} viewerMemberCount={4} />);

    const text = reachText();
    expect(text).not.toMatch(/\b0\.\d\b/);
    expect(text).not.toMatch(/will be emailed|notifications will be sent/i);
    expect(text).toContain('a future, operator-enabled capability');
  });

  it('omits the Viewer clause entirely when the count is unavailable', () => {
    render(<StakeholderReachSummary externalCount={3} viewerMemberCount={undefined} />);

    expect(screen.getByText(/3 external contacts — listed only\./)).toBeInTheDocument();
    // Absence beats a wrong figure: no zero, no placeholder, no skeleton.
    expect(reachText()).not.toMatch(/Viewer-role/);
  });

  it('states the withholding rather than going silent for a non-Admin', () => {
    render(
      <StakeholderReachSummary externalCount={3} viewerMemberCount={undefined} viewerCountRestricted />,
    );

    // Silence here would read as "the alias reaches nobody" — say it is withheld.
    expect(reachText()).toContain('Viewer-role reach is visible to program admins.');
    expect(reachText()).not.toMatch(/gets? an in-app notification/);
  });

  it('says plainly that the alias notifies nobody at 0 Viewers', () => {
    render(<StakeholderReachSummary externalCount={3} viewerMemberCount={0} />);

    expect(reachText()).toContain('No Viewer-role members in this program');
    expect(reachText()).toContain('notifies no one in-app today');
  });

  it('renders nothing at 0 external rows — the empty state carries the sentence', () => {
    const { container } = render(
      <StakeholderReachSummary externalCount={0} viewerMemberCount={6} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('agrees in number at 1, on both the noun and the verb', () => {
    render(<StakeholderReachSummary externalCount={1} viewerMemberCount={1} />);

    const text = reachText();
    expect(text).toContain('1 external contact — listed only.');
    expect(text).not.toContain('1 external contacts');
    expect(text).toContain('1 Viewer-role member gets an in-app notification');
  });
});

describe('StakeholderEmptyState', () => {
  it('states the real Viewer count', () => {
    render(<StakeholderEmptyState viewerMemberCount={6} canManage={false} />);

    expect(reachText()).toContain('No external stakeholders yet —');
    expect(reachText()).toContain('reaches 6 Viewer-role members in this program.');
  });

  it('states that the alias reaches nobody at 0 Viewers', () => {
    render(<StakeholderEmptyState viewerMemberCount={0} canManage={false} />);

    expect(reachText()).toContain('and no Viewer-role members');
    expect(reachText()).toContain('reaches no one today.');
  });

  it('falls back to the bare string rather than substituting a number', () => {
    render(<StakeholderEmptyState viewerMemberCount={undefined} canManage={false} />);

    expect(reachText()).toBe('No external stakeholders yet.');
  });

  it('appends the add hint only for managers', () => {
    const { unmount } = render(<StakeholderEmptyState viewerMemberCount={6} canManage />);
    expect(reachText()).toContain('Add one below.');
    unmount();

    render(<StakeholderEmptyState viewerMemberCount={6} canManage={false} />);
    expect(reachText()).not.toContain('Add one below.');
  });

  it('agrees in number at 1 Viewer', () => {
    render(<StakeholderEmptyState viewerMemberCount={1} canManage={false} />);

    expect(reachText()).toContain('reaches 1 Viewer-role member in this program.');
    expect(reachText()).not.toContain('1 Viewer-role members');
  });
});
