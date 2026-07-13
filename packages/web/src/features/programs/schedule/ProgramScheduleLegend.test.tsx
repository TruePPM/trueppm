/**
 * Unit tests for ProgramScheduleLegend — covers the "Limited-view task"
 * hatch swatch, which moved off a hardcoded rgba(0,0,0,…) fill onto the
 * mode-aware --hatch-limited-view token (issue #1914).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LIMITED_VIEW_HATCH_STYLE, ProgramScheduleLegend } from './ProgramScheduleLegend';

describe('LIMITED_VIEW_HATCH_STYLE', () => {
  it('references the mode-aware --hatch-limited-view token', () => {
    expect(LIMITED_VIEW_HATCH_STYLE.backgroundImage).toContain('var(--hatch-limited-view)');
  });

  it('does not hardcode a black rgba fill', () => {
    expect(LIMITED_VIEW_HATCH_STYLE.backgroundImage).not.toMatch(/rgba\(0,\s*0,\s*0/);
  });
});

describe('ProgramScheduleLegend', () => {
  it('omits the "Limited-view task" item when there are no external tasks', () => {
    render(<ProgramScheduleLegend hasExternalTasks={false} />);
    expect(screen.queryByText('Limited-view task')).not.toBeInTheDocument();
  });

  it('shows the "Limited-view task" item with the hatch swatch when external tasks are present', () => {
    render(<ProgramScheduleLegend hasExternalTasks />);
    const label = screen.getByText('Limited-view task');
    expect(label).toBeInTheDocument();
    const swatch = label.parentElement?.querySelector('span[aria-hidden="true"] > span');
    expect(swatch).toHaveStyle({ backgroundImage: LIMITED_VIEW_HATCH_STYLE.backgroundImage });
  });
});
