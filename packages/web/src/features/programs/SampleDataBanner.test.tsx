import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SampleDataBanner } from './SampleDataBanner';

vi.mock('@/hooks/useProgramSeedIo', () => ({
  useRemoveSampleProgram: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderBanner(canRemove = true) {
  return render(
    <MemoryRouter>
      <SampleDataBanner programId="prog-1" canRemove={canRemove} />
    </MemoryRouter>,
  );
}

describe('SampleDataBanner', () => {
  it('warns that the user own changes are also deleted before teardown (#1053)', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: /remove sample data/i }));
    expect(screen.getByText(/including any changes you made/i)).toBeInTheDocument();
    expect(screen.getByText(/your own projects are not affected/i)).toBeInTheDocument();
  });

  it('advertises the 60 days of bundled history (#376)', () => {
    renderBanner();
    expect(screen.getByText(/includes 60 days of history/i)).toBeInTheDocument();
  });

  it('hides the teardown control when the user cannot remove', () => {
    renderBanner(false);
    expect(screen.queryByRole('button', { name: /remove sample data/i })).not.toBeInTheDocument();
  });
});
