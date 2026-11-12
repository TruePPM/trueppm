import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogController } from '../hooks/useBacklogController';
import { BacklogToasts } from './BacklogToasts';

function renderToast(toast: BacklogController['toast']) {
  // No cast: `BacklogToasts` declares the three fields it reads, so this object
  // is checked rather than asserted (#3644).
  const controller = {
    toast,
    dismissToast: vi.fn(),
    retryPull: vi.fn(),
  };
  render(
    <MemoryRouter>
      <BacklogToasts controller={controller} />
    </MemoryRouter>,
  );
  return controller;
}

describe('BacklogToasts', () => {
  it('renders a "Go to task" deep-link once the pulled task id is known (#1994)', () => {
    renderToast({
      kind: 'success',
      message: 'Pulled to Avionics.',
      projectId: 'p-7',
      taskId: 't-9',
    });
    const link = screen.getByRole('link', { name: 'Go to task' });
    expect(link).toHaveAttribute('href', '/projects/p-7/tasks/t-9');
  });

  it('gives the dismiss control a 44px hit pad', () => {
    renderToast({
      kind: 'error',
      // Only the fields the error branch reads; cast keeps the fixture small.
      item: {} as never,
      project: { name: 'Avionics' } as never,
      message: 'boom',
      offline: false,
    });
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    expect(btn.className).toContain('before:h-11');
    expect(btn.className).toContain('before:w-11');
  });

  it('omits the deep-link until the task id resolves', () => {
    renderToast({ kind: 'success', message: 'Pulled to Avionics.', projectId: 'p-7' });
    expect(screen.queryByRole('link', { name: 'Go to task' })).not.toBeInTheDocument();
    expect(screen.getByText('Pulled to Avionics.')).toBeInTheDocument();
  });
});
