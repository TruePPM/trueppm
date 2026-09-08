import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PullEffectList } from './PullEffectList';

describe('PullEffectList', () => {
  it('personalizes the destination bullet with the target project name', () => {
    render(<PullEffectList projectName="Avionics" projectMethodology="AGILE" />);
    expect(screen.getByText(/New task in Avionics's backlog/)).toBeInTheDocument();
    expect(screen.getByText(/This item becomes Pulled/)).toBeInTheDocument();
  });

  it('falls back to a generic destination when no project is selected', () => {
    render(<PullEffectList projectName={null} />);
    expect(screen.getByText(/New task in the project backlog/)).toBeInTheDocument();
  });

  it('applies an extra className onto the list', () => {
    const { container } = render(<PullEffectList projectName={null} className="mt-2" />);
    expect(container.querySelector('ul')).toHaveClass('mt-2');
  });

  // #3644 — the third bullet used to promise tags were "copied over". They are
  // not: `_apply_tags_as_labels` converts each into a project `Label`, which is a
  // different, project-scoped, curated collection that other people see.
  describe('the tag conversion (#3644)', () => {
    it('states that tags become labels, and never that they are copied', () => {
      render(<PullEffectList projectName="Avionics" projectMethodology="AGILE" />);

      expect(
        screen.getByText(/Each tag matches or creates a label in Avionics/),
      ).toBeInTheDocument();
      expect(screen.getByText(/50 characters max/)).toBeInTheDocument();
      // The old copy listed tags inside the copied-fields bullet. Assert the
      // negative on that bullet specifically — a bare `queryByText(/tags/)`
      // would be satisfied by the conversion bullet and pass vacuously.
      expect(screen.getByText(/are copied/).textContent).not.toMatch(/tag/i);
    });
  });

  // #3644 — `methodologyTabs` hides BOTH product-backlog and sprints on
  // WATERFALL, so the old bullet named a tab the target does not render.
  describe('a WATERFALL target (#3644)', () => {
    it('names the surface that actually lists the task, not the hidden Backlog tab', () => {
      render(<PullEffectList projectName="Runway 24L" projectMethodology="WATERFALL" />);

      expect(screen.getByText(/on Schedule, under Unscheduled/)).toBeInTheDocument();
      expect(screen.getByText(/New undated task in Runway 24L/)).toBeInTheDocument();
      expect(screen.queryByText(/backlog/i)).not.toBeInTheDocument();
    });

    it('uses the same points noun the WATERFALL create form does', () => {
      render(<PullEffectList projectName="Runway 24L" projectMethodology="WATERFALL" />);
      // A reader who entered an "Estimate" must not be told a "story points"
      // value carries across — one field, one word, on both surfaces.
      expect(screen.getByText(/description, estimate, and type are copied/)).toBeInTheDocument();
      expect(screen.queryByText(/story points/)).not.toBeInTheDocument();
    });

    it('keeps the agile noun and the backlog destination on AGILE and HYBRID', () => {
      const { unmount } = render(
        <PullEffectList projectName="Avionics" projectMethodology="AGILE" />,
      );
      expect(screen.getByText(/description, story points, and type are copied/)).toBeInTheDocument();
      expect(screen.queryByText(/Unscheduled/)).not.toBeInTheDocument();
      unmount();

      render(<PullEffectList projectName="Avionics" projectMethodology="HYBRID" />);
      expect(screen.getByText(/New task in Avionics's backlog/)).toBeInTheDocument();
    });

    it('stays methodology-neutral rather than guessing when no target is chosen', () => {
      render(<PullEffectList projectName={null} />);
      expect(screen.queryByText(/Unscheduled/)).not.toBeInTheDocument();
      expect(screen.getByText(/story points/)).toBeInTheDocument();
    });
  });
});
