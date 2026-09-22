import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DemoModePanelNote } from './DemoModePanelNote';

describe('DemoModePanelNote (#3970)', () => {
  it('names the Schedule as the only interactive surface', () => {
    render(<DemoModePanelNote />);
    expect(
      screen.getByText(
        'The Schedule is the only interactive part of this demo — drag a task and watch the critical path recompute live in your browser. Nothing you do here is saved.',
      ),
    ).toBeInTheDocument();
  });

  it('scopes boards, backlogs, sprints and resource plans to browse-only — no inviting "you can look at them" framing', () => {
    render(<DemoModePanelNote />);
    // Regression guard for the pre-#3970 copy, which pitched this sentence in the same
    // inviting tone as the Schedule pitch above it ("you can look at them, but you
    // can't change them") with nothing marking it as categorically non-interactive.
    expect(screen.queryByText(/you can look at them/i)).toBeNull();
    expect(
      screen.getByText(
        'Everything else — boards, backlogs, sprints and resource plans — is real sample data to browse, not to try changes on. You can look, but nothing outside the Schedule responds to what you do.',
      ),
    ).toBeInTheDocument();
  });

  it('renders a real heading rather than a bold div, so it surfaces in the page heading list', () => {
    render(<DemoModePanelNote />);
    expect(screen.getByRole('heading', { name: 'Read-only demo', level: 2 })).toBeInTheDocument();
  });
});
