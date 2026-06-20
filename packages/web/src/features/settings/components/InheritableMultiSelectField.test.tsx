import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InheritableMultiSelectField } from './InheritableMultiSelectField';

const GROUPS = [
  { mime: 'application/pdf', label: 'PDF', group: 'Documents' },
  { mime: 'text/plain', label: 'Plain text', group: 'Documents' },
  { mime: 'image/png', label: 'PNG image', group: 'Images' },
];
const DENIED = [{ mime: 'text/html', label: 'HTML' }];

function renderField(
  props: Partial<React.ComponentProps<typeof InheritableMultiSelectField>> = {},
) {
  const onChange = vi.fn();
  render(
    <InheritableMultiSelectField
      value={null}
      onChange={onChange}
      inherited={['application/pdf', 'text/plain']}
      inheritFromLabel="the workspace default"
      ariaLabel="Allowed attachment file types"
      canEdit
      scopeNoun="project"
      groups={GROUPS}
      deniedTypes={DENIED}
      {...props}
    />,
  );
  return { onChange };
}

describe('InheritableMultiSelectField', () => {
  it('shows the inherit/override radio pair with the inherited count when inheriting', () => {
    renderField({ value: null, inherited: ['application/pdf', 'text/plain'] });
    const group = screen.getByRole('radiogroup', { name: 'Allowed attachment file types' });
    expect(group).toBeInTheDocument();
    // Chip suffix: "Inherit (2 types)".
    expect(screen.getByText(/\(2 types\)/)).toBeInTheDocument();
    // Inheriting body lists the inherited labels; no checklist visible yet.
    expect(screen.queryByLabelText('PDF')).toBeNull();
  });

  it('singularizes the inherited count for a single type', () => {
    renderField({ value: null, inherited: ['application/pdf'] });
    expect(screen.getByText(/\(1 type\)/)).toBeInTheDocument();
  });

  it('choosing Override seeds the checklist from the inherited set', () => {
    const { onChange } = renderField({ value: null, inherited: ['application/pdf', 'text/plain'] });
    fireEvent.click(screen.getByText('Override', { exact: true }));
    // Emits the inherited set as the new (non-null) override.
    expect(onChange).toHaveBeenCalledWith(['application/pdf', 'text/plain']);
  });

  it('choosing Inherit emits null (reset-to-inherited)', () => {
    const { onChange } = renderField({ value: ['application/pdf'], inherited: ['application/pdf'] });
    fireEvent.click(screen.getByText('Inherit'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders the checklist when overriding and reflects the value', () => {
    renderField({ value: ['application/pdf'], inherited: ['application/pdf', 'text/plain'] });
    expect(screen.getByLabelText<HTMLInputElement>('PDF').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Plain text').checked).toBe(false);
  });

  it('shows "Same as parent" when the override equals the inherited set', () => {
    renderField({
      value: ['application/pdf', 'text/plain'],
      inherited: ['application/pdf', 'text/plain'],
    });
    expect(screen.getByText('Same as parent.')).toBeInTheDocument();
  });

  it('shows a "Narrower than parent (removed: …)" delta', () => {
    renderField({
      value: ['application/pdf'],
      inherited: ['application/pdf', 'text/plain'],
    });
    expect(screen.getByText(/Narrower than parent \(removed: Plain text\)/)).toBeInTheDocument();
  });

  it('shows a "Wider than parent (added: …)" delta', () => {
    renderField({
      value: ['application/pdf', 'text/plain', 'image/png'],
      inherited: ['application/pdf', 'text/plain'],
    });
    expect(screen.getByText(/Wider than parent \(added: PNG image\)/)).toBeInTheDocument();
  });

  it('renders the denied type as a disabled, non-input row when overriding', () => {
    renderField({ value: ['application/pdf'], inherited: ['application/pdf'] });
    expect(screen.getByText('HTML')).toBeInTheDocument();
    expect(screen.queryByLabelText('HTML')).toBeNull();
  });

  it('collapses to a read-only indicator when canEdit is false', () => {
    renderField({ canEdit: false, value: null, inherited: ['application/pdf', 'text/plain'] });
    // No editable affordances.
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByLabelText('PDF')).toBeNull();
    // Composite aria-label carries the effective summary + provenance + "View only.".
    expect(
      screen.getByLabelText(
        'Allowed attachment file types: PDF, Plain text, inherited from the workspace default. View only.',
      ),
    ).toBeInTheDocument();
  });
});
