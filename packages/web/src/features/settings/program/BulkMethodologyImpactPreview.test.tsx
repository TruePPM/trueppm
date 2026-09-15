import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BulkMethodologyImpactPreview } from './BulkMethodologyImpactPreview';
import type { Project } from '@/types';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'P',
    colorDot: '#000',
    healthState: 'unknown',
    openTaskCount: null,
    methodology: 'HYBRID',
    programId: null,
    ...overrides,
  };
}

describe('BulkMethodologyImpactPreview (#3296)', () => {
  it('states the target and the selection count in the heading', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project(), project({ id: 'p2' })]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.getByText((_, el) => el?.textContent === 'Set Methodology to Waterfall on 2 selected projects?'),
    ).toBeInTheDocument();
  });

  it('WATERFALL names sprint and backlog-story totals hidden, with a not-deleted framing', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[
          project({ id: 'p1', sprintCount: 3, backlogStoryCount: 2 }),
          project({ id: 'p2', sprintCount: 0, backlogStoryCount: 0 }),
        ]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/1 of 2 selected projects have sprints and board data/)).toBeInTheDocument();
    expect(screen.getByText(/3 sprints, 2 backlog stories/)).toBeInTheDocument();
    expect(screen.getByText(/hidden, not deleted/)).toBeInTheDocument();
  });

  it('AGILE names baseline and dependency totals hidden', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project({ baselineCount: 1, dependencyCount: 4 })]}
        value="AGILE"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/1 baseline, 4 dependency links/)).toBeInTheDocument();
  });

  it('HYBRID states nothing is hidden, in neutral tone (no warning icon)', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project()]}
        value="HYBRID"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.queryByText(/hidden/)).toBeNull();
  });

  it('says nothing will be hidden when no selected row carries data on the surface', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project({ sprintCount: 0, backlogStoryCount: 0 })]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/nothing will be hidden/)).toBeInTheDocument();
  });

  it('drops the numeric line rather than rendering a false zero when a count is unknown', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project({ sprintCount: undefined, backlogStoryCount: 2 })]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText(/counts aren't available/)).toBeInTheDocument();
    expect(screen.queryByText(/backlog stories\./)).toBeNull();
  });

  it('states how many already match the target value', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[
          project({ id: 'p1', methodology: 'WATERFALL' }),
          project({ id: 'p2', methodology: 'AGILE' }),
        ]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(
      screen.getByText((_, el) => el?.textContent === '1 of 2 already set to Waterfall.'),
    ).toBeInTheDocument();
  });

  it('is a role="group", never alertdialog — this never blocks', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project()]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole('group')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('moves focus into itself on mount', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project()]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByRole('group')).toHaveFocus();
  });

  it('Escape calls onCancel without writing', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project()]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={onConfirm}
        onCancel={onCancel}
        busy={false}
      />,
    );
    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Confirm and Cancel stay enabled regardless of the counts — never gated on them', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project({ sprintCount: undefined, backlogStoryCount: undefined })]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy={false}
      />,
    );
    expect(screen.getByText('Set Waterfall')).toBeEnabled();
    expect(screen.getByText('Cancel')).toBeEnabled();
  });

  it('disables both actions while busy', () => {
    render(
      <BulkMethodologyImpactPreview
        selectedRows={[project()]}
        value="WATERFALL"
        entityNoun="projects"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        busy
      />,
    );
    expect(screen.getByText('Applying…')).toBeDisabled();
    expect(screen.getByText('Cancel')).toBeDisabled();
  });
});
