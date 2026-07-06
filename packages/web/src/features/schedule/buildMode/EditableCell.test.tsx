import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  EditableCell,
  parseDurationInput,
  parsePercentInput,
} from './EditableCell';

describe('parseDurationInput', () => {
  it.each([
    ['5', 5],
    ['5d', 5],
    ['12d', 12],
    ['2w', 10],
    ['  3  ', 3],
    ['0', 0],
  ])('parses %s → %i', (input, expected) => {
    expect(parseDurationInput(input)).toBe(expected);
  });

  it.each(['', '-1', '5x', 'abc', '1.5', '5dd'])(
    'rejects %s as null',
    (input) => {
      expect(parseDurationInput(input)).toBeNull();
    },
  );
});

describe('parsePercentInput', () => {
  it.each([
    ['0', 0],
    ['100', 100],
    ['65', 65],
    ['50%', 50],
    ['  75  ', 75],
  ])('parses %s → %i', (input, expected) => {
    expect(parsePercentInput(input)).toBe(expected);
  });

  it.each(['', '-1', '101', '50.5', 'half'])('rejects %s', (input) => {
    expect(parsePercentInput(input)).toBeNull();
  });
});

const baseProps = {
  value: 'Initial name',
  inputType: 'text' as const,
  ariaLabel: 'Task name',
  column: 'name' as const,
  onStartEdit: vi.fn(),
  onCommit: vi.fn(),
  onRollback: vi.fn(),
  onTabForward: vi.fn(),
  onTabBackward: vi.fn(),
};

describe('EditableCell — static state', () => {
  it('renders the display value', () => {
    render(<EditableCell {...baseProps} isEditing={false} display="Display label" />);
    expect(screen.getByText('Display label')).toBeInTheDocument();
  });

  it('falls back to value when display is omitted', () => {
    render(<EditableCell {...baseProps} isEditing={false} />);
    expect(screen.getByText('Initial name')).toBeInTheDocument();
  });

  it('calls onStartEdit when clicked', () => {
    const onStartEdit = vi.fn();
    render(<EditableCell {...baseProps} isEditing={false} onStartEdit={onStartEdit} />);
    fireEvent.click(screen.getByText('Initial name'));
    expect(onStartEdit).toHaveBeenCalledOnce();
  });
});

describe('EditableCell — editing state', () => {
  it('renders an input with the current value', () => {
    render(<EditableCell {...baseProps} isEditing={true} />);
    const input = screen.getByLabelText<HTMLInputElement>('Task name');
    expect(input.tagName).toBe('INPUT');
    expect(input.value).toBe('Initial name');
  });

  it('Enter commits the draft and reports parsed value', () => {
    const onCommit = vi.fn();
    render(<EditableCell {...baseProps} isEditing={true} onCommit={onCommit} />);
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Renamed');
  });

  it('Enter on unchanged value does not call onCommit', () => {
    const onCommit = vi.fn();
    render(<EditableCell {...baseProps} isEditing={true} onCommit={onCommit} />);
    const input = screen.getByLabelText('Task name');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Esc rolls back and reports rollback', () => {
    const onRollback = vi.fn();
    render(<EditableCell {...baseProps} isEditing={true} onRollback={onRollback} />);
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRollback).toHaveBeenCalledOnce();
  });

  it('Tab commits and advances forward', () => {
    const onCommit = vi.fn();
    const onTabForward = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        isEditing={true}
        onCommit={onCommit}
        onTabForward={onTabForward}
      />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Tabbed' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onCommit).toHaveBeenCalledWith('Tabbed');
    expect(onTabForward).toHaveBeenCalledOnce();
  });

  it('Shift-Tab commits and retreats', () => {
    const onTabBackward = vi.fn();
    render(
      <EditableCell {...baseProps} isEditing={true} onTabBackward={onTabBackward} />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(onTabBackward).toHaveBeenCalledOnce();
  });

  it('blur with changed value commits silently', () => {
    const onCommit = vi.fn();
    render(<EditableCell {...baseProps} isEditing={true} onCommit={onCommit} />);
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Lost focus' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('Lost focus');
  });

  it('blur with unchanged value does not commit', () => {
    const onCommit = vi.fn();
    render(<EditableCell {...baseProps} isEditing={true} onCommit={onCommit} />);
    fireEvent.blur(screen.getByLabelText('Task name'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('invalid duration triggers error flash and discards edit', () => {
    const onCommit = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        value="5"
        inputType="duration"
        isEditing={true}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'garbage' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('valid duration in week form commits as days', () => {
    const onCommit = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        value="5"
        inputType="duration"
        isEditing={true}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: '2w' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(10);
  });

  it('percent rejects out-of-range values', () => {
    const onCommit = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        value="50"
        inputType="number"
        isEditing={true}
        onCommit={onCommit}
      />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('EditableCell — commit-and-continue / blank guard (#1666)', () => {
  it('fires onEnterCommit after a successful Enter-commit', () => {
    const onCommit = vi.fn();
    const onEnterCommit = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        isEditing={true}
        onCommit={onCommit}
        onEnterCommit={onEnterCommit}
      />,
    );
    const input = screen.getByLabelText('Task name');
    fireEvent.change(input, { target: { value: 'Design' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Design');
    expect(onEnterCommit).toHaveBeenCalledOnce();
  });

  it('fires onEnterCommit even when the name is unchanged (Enter always continues)', () => {
    const onEnterCommit = vi.fn();
    render(
      <EditableCell {...baseProps} isEditing={true} onEnterCommit={onEnterCommit} />,
    );
    // No change — tryCommit is a no-op success, but Enter still continues.
    fireEvent.keyDown(screen.getByLabelText('Task name'), { key: 'Enter' });
    expect(onEnterCommit).toHaveBeenCalledOnce();
  });

  it('blank Enter with emptyIsNoop is a calm no-op — no commit, no continue, no error flash', () => {
    const onCommit = vi.fn();
    const onEnterCommit = vi.fn();
    render(
      <EditableCell
        {...baseProps}
        value=""
        isEditing={true}
        emptyIsNoop
        onCommit={onCommit}
        onEnterCommit={onEnterCommit}
      />,
    );
    const input = screen.getByLabelText('Task name');
    // Empty draft (the freshly-created blank row) + Enter = double-Enter guard:
    // no new row is spawned and the cursor stays put (cell remains in edit mode).
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onEnterCommit).not.toHaveBeenCalled();
    expect(input.closest('[data-editing="true"]')).toBeTruthy();
  });
});

describe('EditableCell — outside-driven value updates', () => {
  it('updates draft when value changes externally and not editing', () => {
    const { rerender } = render(<EditableCell {...baseProps} isEditing={false} />);
    rerender(<EditableCell {...baseProps} value="Updated" isEditing={false} />);
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('does NOT update draft mid-edit when value changes externally', () => {
    const { rerender } = render(<EditableCell {...baseProps} isEditing={true} />);
    const input = screen.getByLabelText<HTMLInputElement>('Task name');
    fireEvent.change(input, { target: { value: 'Local edit in progress' } });
    rerender(<EditableCell {...baseProps} value="WS push" isEditing={true} />);
    expect(input.value).toBe('Local edit in progress');
  });
});

describe('EditableCell — cursor affordance', () => {
  it('static cell uses cursor-text', () => {
    const { container } = render(<EditableCell {...baseProps} isEditing={false} />);
    expect(container.firstChild).toHaveClass('cursor-text');
  });
});
