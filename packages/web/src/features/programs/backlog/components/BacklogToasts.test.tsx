import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogController } from '../hooks/useBacklogController';
import { BacklogToasts } from './BacklogToasts';

function renderToast(toast: BacklogController['toast']) {
  const controller = {
    toast,
    dismissToast: vi.fn(),
    retryPull: vi.fn(),
  } as unknown as BacklogController;
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

  it('omits the deep-link until the task id resolves', () => {
    renderToast({ kind: 'success', message: 'Pulled to Avionics.', projectId: 'p-7' });
    expect(screen.queryByRole('link', { name: 'Go to task' })).not.toBeInTheDocument();
    expect(screen.getByText('Pulled to Avionics.')).toBeInTheDocument();
  });
});
