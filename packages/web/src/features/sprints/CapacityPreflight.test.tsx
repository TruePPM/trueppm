import { screen } from '@testing-library/react';
import { renderWithProviders as render } from '@/test/utils';
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

  describe('points chip + footer band (#864)', () => {
    it('omits the chip and footer when no points ceiling is set', () => {
      render(
        <CapacityPreflight capacity={makeCapacity()} points={{ committed: 12, capacity: null }} />,
      );
      expect(screen.queryByText(/pts ·/)).not.toBeInTheDocument();
      expect(screen.queryByText(/of capacity/)).not.toBeInTheDocument();
    });

    it('renders a primary chip and "pts free" footer under capacity', () => {
      render(
        <CapacityPreflight capacity={makeCapacity()} points={{ committed: 18, capacity: 24 }} />,
      );
      expect(screen.getByText('18/24 pts · 75%')).toBeInTheDocument();
      expect(screen.getByText('Team is at 75% of capacity. 6 pts free.')).toBeInTheDocument();
    });

    it('renders a critical chip and "pts over" footer when over capacity', () => {
      render(
        <CapacityPreflight capacity={makeCapacity()} points={{ committed: 30, capacity: 24 }} />,
      );
      const chip = screen.getByText('30/24 pts · 125%');
      expect(chip.className).toMatch(/text-semantic-critical/);
      expect(screen.getByText('Team is at 125% of capacity (6 pts over).')).toBeInTheDocument();
    });

    it('does not color a zero-committed footer as on-track (#3477)', () => {
      render(
        <CapacityPreflight capacity={makeCapacity()} points={{ committed: 0, capacity: 34 }} />,
      );
      const footer = screen.getByText('Team is at 0% of capacity. 34 pts free.');
      expect(footer.className).not.toMatch(/text-semantic-on-track/);
      expect(footer.className).toMatch(/text-neutral-text-secondary/);
    });
  });

  describe('zero-denominator "not computable" state (#3477)', () => {
    it('renders the shared muted reason instead of "0/0 hours committed · On track"', () => {
      render(
        <CapacityPreflight
          capacity={makeCapacity({
            totals: {
              committed_hours: 0,
              available_hours: 0,
              ratio: 0,
              buffer_hours: 0,
              label: 'on_track',
              pto_days: 0,
            },
          })}
        />,
      );
      expect(screen.getByText('No assignments yet')).toBeInTheDocument();
      expect(screen.queryByText(/hours committed/)).not.toBeInTheDocument();
      expect(screen.queryByText('On track')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/% of capacity committed/)).not.toBeInTheDocument();
    });

    it('still renders the real ratio and label when available hours are nonzero', () => {
      render(<CapacityPreflight capacity={makeCapacity()} />);
      expect(screen.queryByText('No assignments yet')).not.toBeInTheDocument();
      expect(screen.getByText(/hours committed/)).toBeInTheDocument();
    });
  });

  describe('zero-committed hours against a real denominator (rule 416, #3845)', () => {
    it('does not color "On track" as on-track green when committed_hours is a real zero', () => {
      render(
        <CapacityPreflight
          capacity={makeCapacity({
            totals: {
              committed_hours: 0,
              available_hours: 160,
              ratio: 0,
              buffer_hours: 160,
              label: 'on_track',
              pto_days: 0,
            },
          })}
        />,
      );
      const label = screen.getByText('On track');
      expect(label.className.split(' ')).not.toContain('text-semantic-on-track');
      expect(label.className.split(' ')).toContain('text-neutral-text-secondary');
    });
  });
});
