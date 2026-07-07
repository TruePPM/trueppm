import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { TaskStatus } from '@/types';
import { ChipStrip } from './ChipStrip';

describe('ChipStrip', () => {
  it('renders nothing when no filters are set', () => {
    const { container } = render(
      <ChipStrip search="" ownerFilter="" statusFilter="" overdue={false} onRemove={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a search chip when search is set', () => {
    render(<ChipStrip search="design" ownerFilter="" statusFilter="" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('"design"')).toBeInTheDocument();
  });

  it('renders an owner chip when owner is set', () => {
    render(<ChipStrip search="" ownerFilter="Alice" statusFilter="" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('Owner: Alice')).toBeInTheDocument();
  });

  it('renders a status chip when status is set, mapping to friendly label', () => {
    render(<ChipStrip search="" ownerFilter="" statusFilter="IN_PROGRESS" overdue={false} onRemove={vi.fn()} />);
    expect(screen.getByText('Status: In progress')).toBeInTheDocument();
  });

  it('clicking ✕ on a chip invokes onRemove with that key', () => {
    const onRemove = vi.fn();
    render(
      <ChipStrip
        search="design"
        ownerFilter="Alice"
        statusFilter="COMPLETE"
        overdue={false}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByLabelText('Remove "design" filter'));
    expect(onRemove).toHaveBeenCalledWith('search');
    fireEvent.click(screen.getByLabelText('Remove Owner: Alice filter'));
    expect(onRemove).toHaveBeenCalledWith('owner');
    fireEvent.click(screen.getByLabelText('Remove Status: Done filter'));
    expect(onRemove).toHaveBeenCalledWith('status');
  });

  it('falls back to the raw status string when the status is unknown', () => {
    // Forces the `STATUS_LABEL[statusFilter] ?? statusFilter` fallback branch.
    render(
      <ChipStrip
        search=""
        ownerFilter=""
        statusFilter={'UNKNOWN' as unknown as TaskStatus}
        overdue={false}
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByText('Status: UNKNOWN')).toBeInTheDocument();
  });
});
