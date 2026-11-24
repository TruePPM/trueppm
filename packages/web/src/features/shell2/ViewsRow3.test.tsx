import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectViewSet, SeedDiff } from '@/api/types';
import { ViewsRow3 } from './ViewsRow3';

const patch = vi.fn();
const post = vi.fn();
vi.mock('@/hooks/useProjectViews', () => ({
  useUpdateProjectViews: () => ({ mutate: patch, isPending: false }),
  useApplyLensSeed: () => ({ mutate: post, isPending: false }),
}));

const SET: ProjectViewSet = {
  views: [],
  lens: 'scrum_master',
  seeded_lens: 'scrum_master',
  seed_line: { lens: 'scrum_master', hidden_count: 3 },
  lens_offer: null,
  landing: 'board',
  last_layouts: {},
};
const label = (v: string) => ({ schedule: 'Schedule', board: 'Board', risk: 'Risk' })[v] ?? v;

beforeEach(() => {
  patch.mockReset();
  post.mockReset();
});

describe('ViewsRow3', () => {
  it('shows the seed line and Show all clears only seed hides', () => {
    render(<ViewsRow3 projectId="p" viewSet={SET} labelFor={label} />);
    expect(screen.getByText('Shown for Scrum Masters · 3 views hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(patch).toHaveBeenCalledWith({ clear_seed: true });
  });

  it('persists dismissal server-side', () => {
    render(<ViewsRow3 projectId="p" viewSet={SET} labelFor={label} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this note' }));
    expect(patch).toHaveBeenCalledWith({ seed_line_dismissed: true });
  });

  it('renders nothing without a seed line or offer', () => {
    const { container } = render(
      <ViewsRow3 projectId="p" viewSet={{ ...SET, seed_line: null }} labelFor={label} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers lens suggestions, previews a diff, and applies only on confirm', () => {
    const diff: SeedDiff = {
      lens: 'scrum_master',
      will_hide: ['schedule'],
      will_show: [],
      will_open_on: 'board',
      kept: [{ view: 'risk', hidden: true }],
      change_count: 1,
      applied: false,
    };
    post.mockImplementation((_body: unknown, opts?: { onSuccess?: (d: SeedDiff) => void }) =>
      opts?.onSuccess?.(diff),
    );
    render(
      <ViewsRow3
        projectId="p"
        viewSet={{ ...SET, seed_line: null, lens_offer: 'scrum_master' }}
        labelFor={label}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply Scrum Master suggestions…' }));
    expect(post).toHaveBeenLastCalledWith(
      { lens: 'scrum_master', dry_run: true },
      expect.anything(),
    );
    expect(screen.getByText('Your choices: Risk (hidden)')).toBeInTheDocument();
    expect(screen.getByText('Board')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 change' }));
    expect(post).toHaveBeenLastCalledWith(
      { lens: 'scrum_master', dry_run: false },
      expect.anything(),
    );
  });

  it('dismisses the lens offer', () => {
    render(<ViewsRow3 projectId="p" viewSet={{ ...SET, lens_offer: 'pm' }} labelFor={label} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Project Manager suggestions' }));
    expect(patch).toHaveBeenCalledWith({ lens_offer_dismissed: 'pm' });
  });
});
