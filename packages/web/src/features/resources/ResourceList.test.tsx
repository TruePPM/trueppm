import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OrgResource } from '@/hooks/useResources';
import { ResourceList } from './ResourceList';

function res(over: Partial<OrgResource> = {}): OrgResource {
  return {
    id: 'r1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    jobRole: 'Engineer',
    calendarId: null,
    maxUnits: 1,
    isDeleted: false,
    skills: [],
    ...over,
  };
}

describe('ResourceList accessible name (#3220)', () => {
  it('has no aria-label override, so the visible email is part of the name', () => {
    render(
      <ResourceList
        resources={[res({ skills: [{} as OrgResource['skills'][number]] })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button');
    expect(btn).not.toHaveAttribute('aria-label');
    expect(btn).toHaveAccessibleName(/Ada Lovelace/);
    expect(btn).toHaveAccessibleName(/Engineer · ada@example\.com/);
    expect(btn).toHaveAccessibleName(/1 skill$/);
  });

  it('omits missing role and email cleanly', () => {
    render(
      <ResourceList
        resources={[res({ jobRole: '', email: undefined })]}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName(/^Ada Lovelace\s*$/);
  });

  it('includes the email when there is no role', () => {
    render(
      <ResourceList resources={[res({ jobRole: '' })]} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName(/ada@example\.com/);
  });

  it('announces the deactivated state', () => {
    render(
      <ResourceList resources={[res({ isDeleted: true })]} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole('button')).toHaveAccessibleName(/Deactivated/);
  });
});
