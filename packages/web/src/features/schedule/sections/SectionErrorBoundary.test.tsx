import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { SectionErrorBoundary } from './SectionErrorBoundary';

function Bomb({ throwOnce }: { throwOnce: boolean }) {
  if (throwOnce) {
    throw new Error('boom');
  }
  return <p>recovered</p>;
}

describe('SectionErrorBoundary', () => {
  it('renders the fallback when a child throws', () => {
    // Suppress React's noisy uncaught-error log for this test only.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SectionErrorBoundary sectionTitle="Subtasks">
        <Bomb throwOnce />
      </SectionErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Section unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('Retry resets the boundary and re-renders the children', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    function Harness() {
      const [shouldThrow, setShouldThrow] = useState(true);
      // Expose a way to "fix" the underlying child after the boundary triggers.
      return (
        <>
          <button type="button" onClick={() => setShouldThrow(false)}>
            fix
          </button>
          <SectionErrorBoundary sectionTitle="Subtasks">
            <Bomb throwOnce={shouldThrow} />
          </SectionErrorBoundary>
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByText(/Section unavailable/i)).toBeInTheDocument();

    // Fix the underlying problem first, THEN press Retry on the boundary.
    fireEvent.click(screen.getByRole('button', { name: 'fix' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(screen.queryByText(/Section unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('does not interfere with normal rendering when children do not throw', () => {
    render(
      <SectionErrorBoundary sectionTitle="Overview">
        <p>just fine</p>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText('just fine')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
