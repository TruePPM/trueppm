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

  it('renders up to three avatars with initials', () => {
    render(<PresenceAvatarStack users={USERS.slice(0, 3)} />);
    expect(screen.getByText('AS')).toBeInTheDocument();
    expect(screen.getByText('BJ')).toBeInTheDocument();
    expect(screen.getByText('CL')).toBeInTheDocument();
  });

  it('shows overflow count when more than three users are present', () => {
    render(<PresenceAvatarStack users={USERS} />);
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('derives initials from single-name users (first two letters)', () => {
    render(<PresenceAvatarStack users={[{ user_id: '1', display_name: 'Dan' }]} />);
    expect(screen.getByText('DA')).toBeInTheDocument();
  });

  it('exposes a role=status with aggregated label', () => {
    render(<PresenceAvatarStack users={USERS.slice(0, 2)} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Alice Smith, Bob Jones online');
  });
});
