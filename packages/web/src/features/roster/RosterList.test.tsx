import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RosterList } from './RosterList';
import type { ProjectResource } from '@/types';

function makeProjectResource(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    id: 'pr-1',
    projectId: 'proj-1',
    resourceId: 'res-1',
    resource: {
      id: 'res-1',
      name: 'Alice Smith',
      email: 'alice@example.com',
      jobRole: 'Engineer',
      maxUnits: 1.0,
      calendarId: null,
      skills: [],
    },
    roleTitle: '',
    unitsOverride: null,
    effectiveMaxUnits: 1.0,
    notes: '',
    ...overrides,
  };
}

describe('RosterList', () => {
  it('renders resource names', () => {
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('shows capacity percentage', () => {
    const items = [makeProjectResource({ effectiveMaxUnits: 0.5 })];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows empty state when no items', () => {
    render(<RosterList items={[]} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByText('No one on this project yet')).toBeInTheDocument();
  });

  it('shows filtered empty state when query matches nothing', () => {
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="zzz" />);
    expect(screen.getByText('No matching team members')).toBeInTheDocument();
  });

  it('filters by name', () => {
    const items = [
      makeProjectResource({ id: 'pr-1', resource: { id: 'r1', name: 'Alice Smith', email: '', jobRole: '', maxUnits: 1, calendarId: null, skills: [] } }),
      makeProjectResource({ id: 'pr-2', resourceId: 'r2', resource: { id: 'r2', name: 'Bob Jones', email: '', jobRole: '', maxUnits: 1, calendarId: null, skills: [] } }),
    ];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="alice" />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
    expect(screen.queryByText('Bob Jones')).toBeNull();
  });

  it('calls onSelect with the item id when clicked', () => {
    const onSelect = vi.fn();
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={onSelect} filterQuery="" />);
    fireEvent.click(screen.getByRole('option'));
    expect(onSelect).toHaveBeenCalledWith('pr-1');
  });

  it('marks selected item with aria-selected', () => {
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId="pr-1" onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  });

  it('shows skill chips for resources with skills', () => {
    const items = [
      makeProjectResource({
        resource: {
          id: 'r1', name: 'Alice Smith', email: '', jobRole: '',
          maxUnits: 1, calendarId: null,
          skills: [
            { id: 's1', resourceId: 'r1', skillId: 'sk1', skill: { id: 'sk1', name: 'React', normalizedName: 'react', category: '' }, proficiency: 2 },
          ],
        },
      }),
    ];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByText('React')).toBeInTheDocument();
  });
});
