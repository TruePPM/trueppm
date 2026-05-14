import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NameAutocomplete } from './NameAutocomplete';

const SUGGESTIONS = [
  'Foundation',
  'Framing',
  'Final inspection',
  'Roofing',
  'Electrical',
  'Plumbing',
  'HVAC',
];

describe('NameAutocomplete', () => {
  it('renders nothing when query is empty', () => {
    const { container } = render(
      <NameAutocomplete
        query=""
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('filters suggestions by query (case-insensitive)', () => {
    render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Framing')).toBeInTheDocument();
    expect(screen.queryByText('Foundation')).toBeNull();
  });

  it('caps at 6 suggestions', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Task ${i}`);
    render(
      <NameAutocomplete
        query="task"
        suggestions={many}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });

  it('calls onSelect when item is clicked (mousedown)', () => {
    const onSelect = vi.fn();
    render(
      <NameAutocomplete
        query="fr"
        suggestions={SUGGESTIONS}
        onSelect={onSelect}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.mouseDown(screen.getByText('Framing'));
    expect(onSelect).toHaveBeenCalledWith('Framing');
  });

  it('renders nothing when no suggestions match query', () => {
    const { container } = render(
      <NameAutocomplete
        query="zzz"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a listbox role', () => {
    render(
      <NameAutocomplete
        query="fo"
        suggestions={SUGGESTIONS}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('listbox', { name: 'Task name suggestions' })).toBeInTheDocument();
  });
});
