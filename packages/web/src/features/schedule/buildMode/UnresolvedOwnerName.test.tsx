import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProjectResource } from '@/types';
import { UnresolvedOwnerName } from './UnresolvedOwnerName';

function member(id: string, name: string): ProjectResource {
  return {
    id: `pr-${id}`,
    projectId: 'p1',
    resourceId: id,
    resource: {
      id,
      name,
      email: `${id}@example.com`,
      jobRole: '',
      maxUnits: 1,
      calendarId: null,
      skills: [],
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1,
    notes: '',
  } as ProjectResource;
}

const POOL = [member('r-ana', 'Ana Rivera')];

describe('UnresolvedOwnerName', () => {
  it('renders a clean name as plain text with no annotation spans', () => {
    const { container } = render(<UnresolvedOwnerName name="Draft the plan" pool={POOL} />);
    expect(container.textContent).toBe('Draft the plan');
    expect(container.querySelectorAll('span')).toHaveLength(0);
  });

  it('underlines an unmatched @token without removing it from the name', () => {
    const { container } = render(<UnresolvedOwnerName name="Draft @nobody" pool={POOL} />);
    // The literal text survives — an unresolved owner is a correctable state, not a
    // reason to drop the token (which would look assigned and carry zero capacity).
    expect(container.textContent).toBe('Draft @nobody');
    expect(screen.getByLabelText('@nobody — unresolved owner')).toBeInTheDocument();
  });

  it('carries the state for assistive tech, not by color alone (WCAG 1.4.1)', () => {
    render(<UnresolvedOwnerName name="Draft @nobody" pool={POOL} />);
    const token = screen.getByLabelText('@nobody — unresolved owner');
    expect(token).toHaveAttribute('title', expect.stringContaining('matches @nobody'));
  });

  it('leaves a token that resolves against the roster unmarked', () => {
    const { container } = render(<UnresolvedOwnerName name="Draft @ana" pool={POOL} />);
    expect(container.textContent).toBe('Draft @ana');
    expect(screen.queryByLabelText(/unresolved owner/)).not.toBeInTheDocument();
  });

  it('marks every unresolved token when a name carries more than one', () => {
    render(<UnresolvedOwnerName name="@nobody and @noone" pool={POOL} />);
    expect(screen.getByLabelText('@nobody — unresolved owner')).toBeInTheDocument();
    expect(screen.getByLabelText('@noone — unresolved owner')).toBeInTheDocument();
  });

  it('treats every token as unresolved when the roster has not loaded', () => {
    // An empty pool must not silently "resolve" anything — the token stays visible.
    render(<UnresolvedOwnerName name="Draft @ana" pool={[]} />);
    expect(screen.getByLabelText('@ana — unresolved owner')).toBeInTheDocument();
  });
});
