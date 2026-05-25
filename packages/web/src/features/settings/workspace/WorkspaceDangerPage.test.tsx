import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WorkspaceDangerPage } from './WorkspaceDangerPage';

describe('WorkspaceDangerPage', () => {
  it('stub-disables all three danger-zone buttons until #641 ships (#669)', () => {
    render(<WorkspaceDangerPage />);
    expect(screen.getByRole('button', { name: /Export all data/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Transfer ownership/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Delete workspace/i })).toBeDisabled();
  });

  it('explains why and links the tracking issue (#641)', () => {
    render(<WorkspaceDangerPage />);
    expect(
      screen.getByText(/workspace lifecycle endpoints are\s+in progress/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#641' })).toHaveAttribute(
      'href',
      'https://gitlab.com/trueppm/trueppm/-/issues/641',
    );
  });
});
