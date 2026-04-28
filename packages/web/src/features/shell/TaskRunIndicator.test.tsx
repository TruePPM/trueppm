import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskRunStore } from '@/stores/taskRunStore';
import { TaskRunIndicator } from './TaskRunIndicator';

describe('TaskRunIndicator', () => {
  beforeEach(() => {
    useTaskRunStore.setState({ runs: {}, activeCount: 0 });
  });

  it('renders nothing when there are no active runs', () => {
    const { container } = render(<TaskRunIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it('renders with singular label when activeCount is 1', () => {
    useTaskRunStore.setState({ activeCount: 1 });
    render(<TaskRunIndicator />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      '1 background operation running',
    );
  });

  it('renders with plural label when activeCount is greater than 1', () => {
    useTaskRunStore.setState({ activeCount: 3 });
    render(<TaskRunIndicator />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      '3 background operations running',
    );
  });

  it('displays the count number', () => {
    useTaskRunStore.setState({ activeCount: 2 });
    render(<TaskRunIndicator />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });
});
