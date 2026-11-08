import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarStack, UnassignedAvatar, initialsOf } from './Avatar';

describe('Avatar (rule 439)', () => {
  it('derives initials from the first two words', () => {
    expect(initialsOf('ana maria lee')).toBe('AM');
    expect(initialsOf('  Cher ')).toBe('C');
  });

  it.each([
    [22, 'h-[22px]'],
    [28, 'h-7'],
    [36, 'h-9'],
  ] as const)('renders at %ipx', (size, cls) => {
    render(<Avatar name="Ana Lee" size={size} />);
    expect(screen.getByRole('img', { name: 'Ana Lee' })).toHaveClass(cls);
  });

  it('hides from assistive tech when decorative', () => {
    render(<Avatar name="Ana Lee" decorative />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('prints the over-allocation number with the amber glyph', () => {
    render(<Avatar name="Ben Ito" overAllocatedPct={131.6} />);
    const badge = screen.getByTestId('avatar-over-allocated');
    expect(badge).toHaveTextContent('◆over-allocated, 132%');
    expect(badge).toHaveClass('text-p1-risk-text');
  });

  it('shows no badge at or under 100%', () => {
    render(<Avatar name="Ben Ito" overAllocatedPct={100} />);
    expect(screen.queryByTestId('avatar-over-allocated')).not.toBeInTheDocument();
  });

  it('renders the dashed unassigned slot with its name', () => {
    render(<UnassignedAvatar />);
    expect(screen.getByRole('img', { name: 'Unassigned' })).toHaveClass('border-dashed');
  });
});

describe('AvatarStack', () => {
  const people = ['Ana Lee', 'Ben Ito', 'Cy Park', 'Dee Moss', 'Eli Ford'].map((name) => ({
    name,
  }));

  it('shows at most three faces plus a +N that reads as people', () => {
    render(<AvatarStack people={people} />);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    const stack = screen.getByTestId('avatar-stack');
    expect(stack).toHaveTextContent('+2');
    expect(screen.getByText('2 more people')).toHaveClass('sr-only');
  });

  it('says "person" for one extra', () => {
    render(<AvatarStack people={people.slice(0, 4)} />);
    expect(screen.getByText('1 more person')).toBeInTheDocument();
  });

  it('has no count when three or fewer', () => {
    render(<AvatarStack people={people.slice(0, 3)} />);
    expect(screen.getByTestId('avatar-stack')).not.toHaveTextContent('+');
  });

  it('renders the unassigned slot for nobody', () => {
    render(<AvatarStack people={[]} />);
    expect(screen.getByRole('img', { name: 'Unassigned' })).toBeInTheDocument();
  });
});
