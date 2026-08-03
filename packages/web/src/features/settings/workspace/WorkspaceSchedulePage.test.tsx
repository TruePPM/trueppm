import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkspaceSchedulePage } from './WorkspaceSchedulePage';

describe('WorkspaceSchedulePage — Build mode is always on (#2682)', () => {
  it('renders the Schedule section with a keyboard shortcuts link and no toggle', () => {
    render(<WorkspaceSchedulePage />);
    expect(screen.getByRole('heading', { name: 'Schedule' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByRole('button', { name: 'View keyboard shortcuts' })).toBeInTheDocument();
  });

  it('renders a FieldHelp ⓘ trigger for the Build mode field (web-rule 263 / #2266)', () => {
    render(<WorkspaceSchedulePage />);
    expect(
      screen.getByRole('button', { name: 'About the Build mode options' }),
    ).toBeInTheDocument();
  });

  it('opens the keyboard cheatsheet when the link is clicked', () => {
    render(<WorkspaceSchedulePage />);

    expect(screen.queryByRole('dialog', { name: 'Schedule shortcuts' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View keyboard shortcuts' }));
    expect(screen.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeInTheDocument();
  });
});
