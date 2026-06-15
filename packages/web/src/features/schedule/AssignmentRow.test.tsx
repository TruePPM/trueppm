/**
 * Tests for AssignmentRow — allocation input, validation, remove button (#97).
 */
import { screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import { AssignmentRow } from './AssignmentRow';
import type { TaskAssignment } from '@/types';

const ASSIGNMENT: TaskAssignment = {
  id: 'ar-1',
  resourceId: 'res-1',
  resourceName: 'Alice',
  units: 1.0,
};

function renderRow(
  overrides: Partial<{
    assignment: TaskAssignment;
    onUnitsChange: (d: number) => void;
    onRemove: () => void;
    isUpdating: boolean;
    isRemoving: boolean;
  }> = {},
) {
  const props = {
    assignment: ASSIGNMENT,
    onUnitsChange: vi.fn(),
    onRemove: vi.fn(),
    isUpdating: false,
    isRemoving: false,
    ...overrides,
  };
  renderWithProviders(<AssignmentRow {...props} />);
  return props;
}

describe('AssignmentRow', () => {
  it('renders the resource name and initial allocation percentage', () => {
    renderRow();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    const input = screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i });
    expect(input).toHaveValue(100);
  });

  it('calls onUnitsChange with the correct decimal when user blurs a valid value', () => {
    const onUnitsChange = vi.fn();
    renderRow({ onUnitsChange });
    const input = screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i });
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.blur(input);
    expect(onUnitsChange).toHaveBeenCalledWith(0.75);
  });

  it('commits draft on Enter key and calls onUnitsChange', () => {
    const onUnitsChange = vi.fn();
    renderRow({ onUnitsChange });
    const input = screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i });
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onUnitsChange).toHaveBeenCalledWith(1.5);
  });

  it('reverts to server value when an invalid value is entered', () => {
    const onUnitsChange = vi.fn();
    renderRow({ onUnitsChange });
    const input = screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    // 0 is out of range (min 1), so reverts to 100 and onUnitsChange is NOT called
    expect(onUnitsChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(100);
  });

  it('does not call onUnitsChange when value is unchanged', () => {
    const onUnitsChange = vi.fn();
    renderRow({ onUnitsChange });
    const input = screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i });
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    // Already at 100%, no change
    expect(onUnitsChange).not.toHaveBeenCalled();
  });

  it('calls onRemove when the remove button is clicked', () => {
    const onRemove = vi.fn();
    renderRow({ onRemove });
    fireEvent.click(screen.getByRole('button', { name: /Remove Alice from task/i }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('disables input and remove button when isUpdating is true', () => {
    renderRow({ isUpdating: true });
    expect(screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove Alice from task/i })).toBeDisabled();
  });

  it('disables input and remove button when isRemoving is true', () => {
    renderRow({ isRemoving: true });
    expect(screen.getByRole('spinbutton', { name: /Allocation percent for Alice/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove Alice from task/i })).toBeDisabled();
  });

  // ADR-0132/#1142: a non-editor sees the allocation read-only.
  it('renders allocation as static text with no input or remove control when readOnly', () => {
    renderWithProviders(
      <AssignmentRow
        assignment={ASSIGNMENT}
        onUnitsChange={vi.fn()}
        onRemove={vi.fn()}
        isUpdating={false}
        isRemoving={false}
        readOnly
      />,
    );
    expect(
      screen.queryByRole('spinbutton', { name: /Allocation percent for Alice/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Remove Alice from task/i }),
    ).not.toBeInTheDocument();
    // The allocation value is still visible (read display, not a hole).
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
