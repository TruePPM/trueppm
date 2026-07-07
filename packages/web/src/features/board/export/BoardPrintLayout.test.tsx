import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { BoardPrintLayout } from './BoardPrintLayout';
import type { BoardPrintData } from './boardPrintData';

const DATA: BoardPrintData = {
  projectName: 'Apollo',
  sprintName: 'Sprint 4',
  columns: [
    { status: 'NOT_STARTED', label: 'To do' },
    { status: 'IN_PROGRESS', label: 'In progress' },
  ],
  lanes: [
    {
      id: 'p1',
      name: 'Phase 1',
      cards: [
        {
          id: 't1',
          shortId: 'AP-1',
          name: 'Design the deck',
          status: 'NOT_STARTED',
          assignee: 'Ada Lovelace',
          assigneeInitials: 'AL',
          due: '2026-06-30',
          storyPoints: 5,
          isCritical: true,
          isBlocked: true,
          isMilestone: false,
        },
      ],
    },
  ],
  footer: {
    generatedAtLabel: 'Jun 21, 2026',
    userName: 'Sarah PM',
    contextLabel: 'All cards',
  },
};

describe('BoardPrintLayout', () => {
  it('pins the export surface to the light theme island (issue #1683)', () => {
    const { container } = render(
      <BoardPrintLayout ref={createRef<HTMLDivElement>()} data={DATA} />,
    );
    const root = container.firstChild as HTMLElement;
    // Without `.theme-light`, a dark-mode app rasterizes light ink on this white
    // sheet (WCAG 1.4.3). The island forces the light token palette.
    expect(root.classList.contains('theme-light')).toBe(true);
    expect(root.classList.contains('bg-white')).toBe(true);
  });

  it('renders header, columns, lane, card content, and footer', () => {
    render(<BoardPrintLayout ref={createRef<HTMLDivElement>()} data={DATA} />);

    expect(screen.getByRole('heading', { name: 'Apollo' })).toBeInTheDocument();
    expect(screen.getByText(/Sprint 4/)).toBeInTheDocument();
    expect(screen.getByText('To do')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Phase 1')).toBeInTheDocument();
    expect(screen.getByText('Design the deck')).toBeInTheDocument();
    // Assignee renders as initials, never an avatar image.
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    // Footer: timestamp + exporting user + community watermark.
    expect(screen.getByText(/Generated Jun 21, 2026 by Sarah PM/)).toBeInTheDocument();
    expect(screen.getByText('Generated with TruePPM Community')).toBeInTheDocument();
  });

  it('forwards its ref to the root node for rasterization', () => {
    const ref = createRef<HTMLDivElement>();
    render(<BoardPrintLayout ref={ref} data={DATA} />);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
