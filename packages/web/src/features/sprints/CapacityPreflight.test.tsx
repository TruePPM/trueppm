import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CapacityPreflight } from './CapacityPreflight';
import type { SprintCapacity } from '@/hooks/useSprints';

function makeCapacity(overrides: Partial<SprintCapacity> = {}): SprintCapacity {
  return {
    members: [],
    totals: {
      committed_hours: 100,
      available_hours: 200,
      ratio: 0.5,
      buffer_hours: 100,
      label: 'on_track',
      pto_days: 0,
    },
    working_days: 10,
    hours_per_day: 8,
    ...overrides,
  };
}

describe('CapacityPreflight', () => {
  it('renders aggregate hours and the on-track label', () => {
    render(<CapacityPreflight capacity={makeCapacity()} />);
    expect(screen.getByText(/hours committed/)).toBeInTheDocument();
    expect(screen.getByText(/On track/)).toBeInTheDocument();
    expect(screen.getByLabelText(/50% of capacity committed/)).toBeInTheDocument();
  });

  it('uses semantic-at-risk colour when totals.label is at_risk', () => {
    render(
      <CapacityPreflight
        capacity={makeCapacity({
          totals: {
            committed_hours: 180,
            available_hours: 200,
            ratio: 0.9,
            buffer_hours: 20,
            label: 'at_risk',
            pto_days: 0,
          },
        })}
      />,
    );
    expect(screen.getByText(/At risk/i).className).toMatch(/text-semantic-at-risk/);
  });

  it('uses semantic-critical colour and "overrun" copy when over capacity', () => {
    render(
      <CapacityPreflight
        capacity={makeCapacity({
          totals: {
            committed_hours: 240,
            available_hours: 200,
            ratio: 1.2,
            buffer_hours: -40,
            label: 'over_capacity',
            pto_days: 0,
          },
        })}
      />,
    );
    expect(screen.getByText(/Over capacity/i).className).toMatch(/text-semantic-critical/);
    expect(screen.getByText(/of overrun/)).toBeInTheDocument();
  });

  it('renders per-person rows with initials avatars', () => {
    render(
      <CapacityPreflight
        capacity={makeCapacity({
          members: [
            {
              member_id: 'r1',
              member_name: 'Aisha Khan',
              initials: 'AK',
              committed_hours: 60,
              available_hours: 80,
              ratio: 0.75,
              is_over: false,
            },
            {
              member_id: 'r2',
              member_name: 'Ben Lee',
              initials: 'BL',
              committed_hours: 100,
              available_hours: 80,
              ratio: 1.25,
              is_over: true,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('AK')).toBeInTheDocument();
    expect(screen.getByText('BL')).toBeInTheDocument();
    expect(screen.getByText('Aisha Khan')).toBeInTheDocument();
    expect(screen.getByText('100/80')).toBeInTheDocument();
  });

  it('shows empty-state copy when no members are assigned', () => {
    render(<CapacityPreflight capacity={makeCapacity({ members: [] })} />);
    expect(screen.getByText(/No assignments yet for this sprint/)).toBeInTheDocument();
  });
});
