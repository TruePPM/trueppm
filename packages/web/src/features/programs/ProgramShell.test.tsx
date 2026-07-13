import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ProgramShell } from './ProgramShell';

function renderShell(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/programs/:programId" element={<ProgramShell />}>
          <Route path="overview" element={<div>OVERVIEW_OUTLET</div>} />
          <Route path="settings/general" element={<div>SETTINGS_OUTLET</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('<ProgramShell>', () => {
  // #790 / ADR-0095 / #1920: program navigation lives in the left rail's "This
  // program" tier (it was briefly in the TopBar via ProgramTabs), so the shell
  // renders no in-content header or tab strip — only the routed outlet.
  it('renders only the routed outlet, with no in-content program nav or header', () => {
    renderShell('/programs/p-1/overview');
    expect(screen.getByText('OVERVIEW_OUTLET')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Apollo' })).not.toBeInTheDocument();
  });

  it('uses a scrolling container on working routes', () => {
    const { container } = renderShell('/programs/p-1/overview');
    expect(container.querySelector('.overflow-y-auto')).not.toBeNull();
    expect(container.querySelector('.overflow-hidden')).toBeNull();
  });

  // #776 (preserved): settings sub-pages run the shared SettingsShell, which owns
  // its own scroll region, so the shell mounts them in a non-scrolling
  // `min-h-0 overflow-hidden` box (mirroring ProjectShell) to keep them top-aligned.
  it('uses a non-scrolling overflow-hidden container on settings routes', () => {
    const { container } = renderShell('/programs/p-1/settings/general');
    expect(screen.getByText('SETTINGS_OUTLET')).toBeInTheDocument();
    expect(container.querySelector('.overflow-hidden')).not.toBeNull();
    expect(container.querySelector('.overflow-y-auto')).toBeNull();
  });
});
