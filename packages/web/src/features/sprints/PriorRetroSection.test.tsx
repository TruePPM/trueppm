import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriorRetroSection } from './PriorRetroSection';
import type { SprintRetroPayload, SprintRetroSummaryPayload } from '@/hooks/useSprints';

const FULL: SprintRetroPayload = {
  kind: 'full',
  id: 'r1',
  sprint: 's1',
  notes: 'Pairing helped.\nFewer interrupts.',
  team_visibility: 'project',
  created_by: 1,
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
  action_items: [
    {
      id: 'a1',
      text: 'Write the runbook',
      assignee: null,
      assignee_username: null,
      story_points: null,
      promoted_task_id: 'abcdef12-0000-0000-0000-000000000000',
      created_at: '2026-04-15T00:00:00Z',
    },
    {
      id: 'a2',
      text: 'Trim the standup',
      assignee: null,
      assignee_username: null,
      story_points: null,
      promoted_task_id: null,
      created_at: '2026-04-15T00:00:00Z',
    },
  ],
};

const SUMMARY: SprintRetroSummaryPayload = {
  kind: 'summary',
  id: 'r2',
  sprint: 's2',
  team_visibility: 'team_only',
  created_at: '2026-04-15T00:00:00Z',
  updated_at: '2026-04-15T00:00:00Z',
  action_items_count: 4,
  promoted_count: 1,
};

describe('PriorRetroSection', () => {
  it('renders the disabled-state row when there is no prior retro', () => {
    render(<PriorRetroSection prior={null} />);
    expect(screen.getByText(/No prior retro on this project/)).toBeInTheDocument();
    expect(screen.queryByText('Prior retro')).toBeNull();
  });

  it('renders a full prior retro open by default with notes and the action-item table', () => {
    render(<PriorRetroSection prior={FULL} />);
    const details = screen.getByText('Prior retro').closest('details');
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(/Pairing helped/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Write the runbook')).toBeInTheDocument();
    // A promoted item shows the short task id; an unpromoted one reads "Open".
    expect(screen.getByText('→ T-abcdef')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('omits the notes paragraph and table when the full retro has neither', () => {
    render(<PriorRetroSection prior={{ ...FULL, notes: '', action_items: [] }} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/Pairing helped/)).toBeNull();
  });

  it('renders the team-only counts variant for a summary payload', () => {
    render(<PriorRetroSection prior={SUMMARY} />);
    expect(screen.getByText(/Prior retro is team-only/)).toHaveTextContent(
      'counts: 4 items, 1 promoted.',
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tracks the disclosure state when the user toggles it', () => {
    render(<PriorRetroSection prior={FULL} />);
    const details = screen.getByText('Prior retro').closest('details') as HTMLDetailsElement;
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(details).not.toHaveAttribute('open');
  });
});
