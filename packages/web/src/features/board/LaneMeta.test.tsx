import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaneMeta } from './LaneMeta';

const BASE_PROPS = {
  phaseId: 'phase-1',
  phaseName: 'Engineering',
  avgProgress: 55,
  taskCount: 8,
  railColor: '#1C6B3A',
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
    render(<LaneMeta {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: 'Add task to Engineering' })).toBeInTheDocument();
  });

  it('calls onAddTask when + is clicked', () => {
    const onAddTask = vi.fn();
    render(<LaneMeta {...BASE_PROPS} onAddTask={onAddTask} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add task to Engineering' }));
    expect(onAddTask).toHaveBeenCalledTimes(1);
  });

  it('progress ring uses semantic-on-track stroke at avg ≥ 50', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={50} />);
    const arcs = container.querySelectorAll('circle');
    const progressArc = Array.from(arcs).find(
      (c) => c.classList.contains('stroke-semantic-on-track'),
    );
    expect(progressArc).toBeTruthy();
  });

  it('progress ring uses brand-accent stroke at avg < 50', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={49} />);
    const arcs = container.querySelectorAll('circle');
    const progressArc = Array.from(arcs).find(
      (c) => c.classList.contains('stroke-brand-accent'),
    );
    expect(progressArc).toBeTruthy();
  });

  it('progress ring uses neutral-border stroke at 0%', () => {
    const { container } = render(<LaneMeta {...BASE_PROPS} avgProgress={0} />);
    const circles = container.querySelectorAll('circle');
    const hasAccentOrTrack = Array.from(circles).some(
      (c) =>
        c.classList.contains('stroke-semantic-on-track') ||
        c.classList.contains('stroke-brand-accent'),
    );
    expect(hasAccentOrTrack).toBe(false);
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
});
