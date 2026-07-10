import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import type { PresenceUser } from '@/stores/presenceStore';

const USERS: PresenceUser[] = [
  { user_id: '1', display_name: 'Alice Smith' },
  { user_id: '2', display_name: 'Bob Jones' },
  { user_id: '3', display_name: 'Carol Lee' },
  { user_id: '4', display_name: 'Dan' },
  { user_id: '5', display_name: 'Eve Baker' },
];

describe('PresenceAvatarStack', () => {
  it('renders nothing when users is empty', () => {
    const { container } = render(<PresenceAvatarStack users={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders up to two avatars with initials (design §02 cap, #1804)', () => {
    render(<PresenceAvatarStack users={USERS.slice(0, 3)} />);
    expect(screen.getByText('AS')).toBeInTheDocument();
    expect(screen.getByText('BJ')).toBeInTheDocument();
    // Third viewer folds into the "+N" overflow instead of a third circle.
    expect(screen.queryByText('CL')).not.toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('shows overflow count when more than two users are present', () => {
    render(<PresenceAvatarStack users={USERS} />);
    expect(screen.getByText('+3')).toBeInTheDocument();
  });

  it('renders 24px circles via the canonical AvatarInitials treatment (#1705, #1804)', () => {
    const { container } = render(<PresenceAvatarStack users={USERS.slice(0, 2)} />);
    const circles = container.querySelectorAll('span.h-6.w-6.rounded-full');
    expect(circles).toHaveLength(2);
  });

  it('derives initials from single-name users (first two letters)', () => {
    render(<PresenceAvatarStack users={[{ user_id: '1', display_name: 'Dan' }]} />);
    expect(screen.getByText('DA')).toBeInTheDocument();
  });

  it('marks the cluster live with a single "viewing now" dot on the top-of-stack avatar (#1736)', () => {
    const { container } = render(<PresenceAvatarStack users={USERS.slice(0, 3)} />);
    // One decorative green dot conveys live presence (aria-hidden — the "viewing"
    // state is named in the role=status aria-label).
    const dots = container.querySelectorAll('span.bg-semantic-on-track.rounded-full');
    expect(dots).toHaveLength(1);
  });

  it('exposes a role=status with aggregated "viewing" label', () => {
    render(<PresenceAvatarStack users={USERS.slice(0, 2)} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Alice Smith, Bob Jones viewing');
  });

  it('surfaces the anonymity contract as a tooltip and accessible description', () => {
    render(<PresenceAvatarStack users={USERS.slice(0, 2)} />);
    const status = screen.getByRole('status');
    // Contract copy is announced (aria-describedby) and shown on hover (title) (#1560).
    expect(screen.getByText(/never who's editing what/i)).toBeInTheDocument();
    expect(status).toHaveAttribute('title', expect.stringContaining("never who's editing what"));
    expect(status).toHaveAttribute('aria-describedby', 'presence-stack-contract');
  });
});
