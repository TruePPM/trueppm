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

  it('states availability in the visible text, not a bare percent', () => {
    const items = [makeProjectResource({ effectiveMaxUnits: 0.5 })];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    // A bare "50%" next to a filled bar reads as load. The word is what disambiguates
    // it, and it must be on-screen — not only in the accessible name (#3235).
    expect(screen.getByText('50% available')).toBeInTheDocument();
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

  it('calls onSelect when Enter is pressed on an item', () => {
    const onSelect = vi.fn();
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={onSelect} filterQuery="" />);
    fireEvent.keyDown(screen.getByRole('option'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('pr-1');
  });

  it('calls onSelect when Space is pressed on an item', () => {
    const onSelect = vi.fn();
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={onSelect} filterQuery="" />);
    fireEvent.keyDown(screen.getByRole('option'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('pr-1');
  });

  it('does not call onSelect for other key presses', () => {
    const onSelect = vi.fn();
    const items = [makeProjectResource()];
    render(<RosterList items={items} selectedId={null} onSelect={onSelect} filterQuery="" />);
    fireEvent.keyDown(screen.getByRole('option'), { key: 'ArrowDown' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  // The AC asks for a colour/semantic assertion at three points on the axis. These
  // are the assertions the old suite lacked: it fixtured `effective_max_units: '1.00'`
  // and asserted only that "100%" was visible, which locked the defect in rather than
  // catching it. `queryBar` reads the fill element directly so a ramp cannot come back
  // unnoticed.
  function queryBar(container: HTMLElement): HTMLElement {
    const bar = container.querySelector<HTMLElement>('[aria-hidden="true"] > div');
    expect(bar).not.toBeNull();
    return bar as HTMLElement;
  }

  it('never applies a health ramp — a 1.5-FTE crew is not "overallocated"', () => {
    const items = [makeProjectResource({ effectiveMaxUnits: 1.5 })];
    const { container } = render(
      <RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />,
    );
    // 150% availability is a deliberately-configured crew carrying zero assignments.
    // Announcing it as overallocated is a false claim about work that does not exist.
    expect(screen.getByText('150% available')).toBeInTheDocument();
    expect(screen.queryByLabelText(/overallocated/)).not.toBeInTheDocument();

    const bar = queryBar(container);
    expect(bar.className).toContain('bg-brand-primary');
    expect(bar.className).not.toContain('bg-semantic-critical');
    // Above full time the bar pins rather than overflowing its track.
    expect(bar.style.width).toBe('100%');
  });

  it('draws the default 1.0 ceiling as a full bar in the neutral fill, not amber', () => {
    // This is the fresh-install case: max_units defaults to 1.0, so EVERY resource hit
    // the old `pct >= 85` branch and the entire roster rendered in the product's amber
    // "at risk" colour — at half width, so a fully-available person looked half-empty.
    const items = [makeProjectResource({ effectiveMaxUnits: 1.0 })];
    const { container } = render(
      <RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />,
    );
    const bar = queryBar(container);
    expect(bar.className).toContain('bg-brand-primary');
    expect(bar.className).not.toContain('bg-semantic-at-risk');
    expect(bar.style.width).toBe('100%');
  });

  it('draws a partial ceiling proportionally, in the same fill', () => {
    const items = [makeProjectResource({ effectiveMaxUnits: 0.5 })];
    const { container } = render(
      <RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />,
    );
    const bar = queryBar(container);
    // Same colour as every other row: availability is a quantity, not a verdict, so a
    // person at 50% is not "healthier" than one at 100%.
    expect(bar.className).toContain('bg-brand-primary');
    expect(bar.className).not.toContain('bg-semantic-on-track');
    expect(bar.style.width).toBe('50%');
  });

  it('keeps the two channels agreeing on what the number means', () => {
    const items = [makeProjectResource({ effectiveMaxUnits: 0.5 })];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    const label = screen.getByText('50% available');
    expect(label.getAttribute('aria-label')).toBe(
      '50% available — availability, not assigned load',
    );
  });

  it('filters by jobRole', () => {
    const items = [
      makeProjectResource({ id: 'pr-1', resource: { id: 'r1', name: 'Alice Smith', email: '', jobRole: 'Engineer', maxUnits: 1, calendarId: null, skills: [] } }),
      makeProjectResource({ id: 'pr-2', resourceId: 'r2', resource: { id: 'r2', name: 'Bob Jones', email: '', jobRole: 'Designer', maxUnits: 1, calendarId: null, skills: [] } }),
    ];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="designer" />);
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.queryByText('Alice Smith')).toBeNull();
  });

  it('renders "+N more" chip when a resource has more than 3 skills', () => {
    const skills = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`, resourceId: 'r1', skillId: `sk${i}`,
      skill: { id: `sk${i}`, name: `Skill${i}`, normalizedName: `skill${i}`, category: '' },
      proficiency: 1 as const,
    }));
    const items = [
      makeProjectResource({
        resource: { id: 'r1', name: 'Alice Smith', email: '', jobRole: '', maxUnits: 1, calendarId: null, skills },
      }),
    ];
    render(<RosterList items={items} selectedId={null} onSelect={vi.fn()} filterQuery="" />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });
});
