import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import { Breadcrumb } from './Breadcrumb';

function renderTrail(items: Parameters<typeof Breadcrumb>[0]['items']) {
  return render(
    <MemoryRouter>
      <Breadcrumb items={items} />
    </MemoryRouter>,
  );
}

describe('Breadcrumb', () => {
  it('links every non-last segment and marks the last as the current page', () => {
    renderTrail([
      { label: 'Workspace', to: '/' },
      { label: 'Apollo', to: '/programs/p1/overview' },
      { label: 'Launch Site' },
    ]);

    // Intermediate segments are links...
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Apollo' })).toHaveAttribute(
      'href',
      '/programs/p1/overview',
    );
    // ...the leaf is the current page (non-link).
    const leaf = screen.getByText('Launch Site');
    expect(leaf).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Launch Site' })).not.toBeInTheDocument();
  });

  it('renders the last segment as current even if a `to` is supplied', () => {
    renderTrail([
      { label: 'Workspace', to: '/' },
      { label: 'Apollo', to: '/programs/p1/overview' },
    ]);
    expect(screen.getByText('Apollo')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Apollo' })).not.toBeInTheDocument();
  });

  it('exposes a Breadcrumb landmark', () => {
    renderTrail([{ label: 'Workspace', to: '/' }]);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });
});
