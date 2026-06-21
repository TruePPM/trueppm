import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaneMeta } from './LaneMeta';

const BASE_PROPS = {
  phaseId: 'phase-1',
  phaseName: 'Engineering',
  avgProgress: 55,
  taskCount: 8,
  railColor: '#3E8C6D',
};

describe('LaneMeta', () => {
  it('renders phase name', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('renders task count — plural', () => {
    render(<LaneMeta {...BASE_PROPS} taskCount={8} />);
    expect(screen.getByText('8 tasks')).toBeInTheDocument();
  });

  it('renders task count — singular', () => {
    render(<LaneMeta {...BASE_PROPS} taskCount={1} />);
    expect(screen.getByText('1 task')).toBeInTheDocument();
  });

  it('renders percentage', () => {
    render(<LaneMeta {...BASE_PROPS} avgProgress={55} />);
    expect(screen.getByText('55%')).toBeInTheDocument();
  });

  it('clamps progress to 0–100', () => {
    render(<LaneMeta {...BASE_PROPS} avgProgress={150} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders add-task button with correct aria-label', () => {
    render(<LaneMeta {...BASE_PROPS} onAddTask={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add task to Engineering' })).toBeInTheDocument();
  });

  it('calls onAddTask when + is clicked', () => {
    const onAddTask = vi.fn();
    render(<LaneMeta {...BASE_PROPS} onAddTask={onAddTask} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add task to Engineering' }));
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  // #324: assignee-grouped lanes pass no onAddTask — a lane id there is a
  // resource, not a parent — so the add affordance is suppressed (not dead).
  it('suppresses the add-task button when onAddTask is omitted', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(
      screen.queryByRole('button', { name: 'Add task to Engineering' }),
    ).not.toBeInTheDocument();
  });

  it('progress bar fill uses semantic-on-track at avg ≥ 50 (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={50} />);
    const bar = container.querySelector('[role="progressbar"] > div');
    expect(bar?.className).toContain('bg-semantic-on-track');
  });

  it('progress bar fill uses brand-accent at avg < 50 (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={49} />);
    const bar = container.querySelector('[role="progressbar"] > div');
    expect(bar?.className).toContain('bg-brand-accent');
  });

  it('progress bar width matches avgProgress (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={42} />);
    const bar = container.querySelector<HTMLElement>('[role="progressbar"] > div');
    expect(bar?.style.width).toBe('42%');
  });

  it('progress bar exposes aria-valuenow with the percent (issue #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={37} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('37');
    expect(bar?.getAttribute('aria-valuemin')).toBe('0');
    expect(bar?.getAttribute('aria-valuemax')).toBe('100');
  });

  it('renders em-dash instead of 0% when there are no committed tasks (ADR-0057)', () => {
    render(<LaneMeta {...BASE_PROPS} taskCount={0} avgProgress={0} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('progress bar drops aria-valuenow when there are no committed tasks (issue #385)', () => {
    const { container } = render(
      <LaneMeta {...BASE_PROPS} taskCount={0} avgProgress={0} />,
    );
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe(null);
    expect(bar?.getAttribute('aria-label')).toMatch(/No committed tasks/i);
  });

  it('em-dash empty state triggers when committedTaskCount is 0 even with cards present', () => {
    // Lane has cards (taskCount=4) but none are committed (no plannedStart).
    // The visible "{N} tasks" counter still reads the total, but the percent
    // collapses to em-dash because there is no committed delivery to roll up.
    render(
      <LaneMeta {...BASE_PROPS} taskCount={4} committedTaskCount={0} avgProgress={0} />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText('4 tasks')).toBeInTheDocument();
  });

  it('renders no SVG circle (ProgressRing replaced by inline bar in #385)', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={55} />);
    expect(container.querySelector('circle')).toBeNull();
  });

  it('percent label uses tppm-mono (issue #385)', () => {
    render(<LaneMeta {...BASE_PROPS} avgProgress={55} />);
    const pct = screen.getByText('55%');
    expect(pct.className).toContain('tppm-mono');
  });

  it('renders workshop variant with contentEditable name', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    expect(textbox).toBeInTheDocument();
    expect(textbox).toHaveAttribute('contenteditable', 'true');
  });

  it('renders drag handle in workshop mode', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    expect(screen.getByTitle('Drag to reorder phase')).toBeInTheDocument();
  });

  it('does not render drag handle in normal mode', () => {
    render(<LaneMeta {...BASE_PROPS} />);
    expect(screen.queryByTitle('Drag to reorder phase')).not.toBeInTheDocument();
  });

  it('renders collapseToggle when provided', () => {
    render(
      <LaneMeta
        {...BASE_PROPS}
        collapseToggle={<button>▾</button>}
      />,
    );
    expect(screen.getByRole('button', { name: '▾' })).toBeInTheDocument();
  });

  it('calls onPhaseRename when the editable name blurs with a new value', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = '  Discovery  ';
    fireEvent.blur(textbox);
    expect(onPhaseRename).toHaveBeenCalledWith('Discovery');
  });

  it('does not call onPhaseRename when the name is unchanged after blur', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
  });

  it('reverts the editable name to the original on blur when emptied', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = '   ';
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
    expect(textbox.textContent).toBe('Engineering');
  });

  it('commits the edit on Enter key', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'Build';
    fireEvent.keyDown(textbox, { key: 'Enter' });
    // Enter triggers blur, which fires the onBlur handler with the new value.
    fireEvent.blur(textbox);
    expect(onPhaseRename).toHaveBeenCalledWith('Build');
  });

  it('reverts the edit on Escape key', () => {
    const onPhaseRename = vi.fn();
    render(<LaneMeta {...BASE_PROPS} workshop onPhaseRename={onPhaseRename} />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'AbandonedEdit';
    fireEvent.keyDown(textbox, { key: 'Escape' });
    expect(textbox.textContent).toBe('Engineering');
    fireEvent.blur(textbox);
    expect(onPhaseRename).not.toHaveBeenCalled();
  });

  it('ignores blur when no onPhaseRename callback is provided', () => {
    render(<LaneMeta {...BASE_PROPS} workshop />);
    const textbox = screen.getByRole('textbox', { name: /Phase name: Engineering/ });
    textbox.textContent = 'Whatever';
    expect(() => fireEvent.blur(textbox)).not.toThrow();
  });

  describe('budget display', () => {
    it('formats large budgets in millions ($1.5M)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={1_500_000}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$1\.5M/)).toBeInTheDocument();
    });

    it('formats mid-size budgets in thousands ($45K)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={45_000}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$45K/)).toBeInTheDocument();
    });

    it('formats small budgets in dollars ($250)', () => {
      render(
        <LaneMeta
          {...BASE_PROPS}
          showCost
          phaseBudgetAtCompletion={250}
          phaseActualCost={null}
        />,
      );
      expect(screen.getByText(/\$250/)).toBeInTheDocument();
    });
  });
});
