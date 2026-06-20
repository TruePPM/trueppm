import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AttachmentTypesChecklist } from './AttachmentTypesChecklist';
import { DENIED_ATTACHMENT_TYPES } from '@/lib/attachmentTypes';

// A small, self-contained catalog so assertions don't depend on the full one.
const GROUPS = [
  { mime: 'application/pdf', label: 'PDF', group: 'Documents' },
  { mime: 'text/plain', label: 'Plain text', group: 'Documents' },
  { mime: 'image/png', label: 'PNG image', group: 'Images' },
];

describe('AttachmentTypesChecklist', () => {
  it('renders an option checkbox per catalog type, plus a group legend checkbox', () => {
    render(<AttachmentTypesChecklist value={[]} onChange={vi.fn()} groups={GROUPS} deniedTypes={[]} />);
    expect(screen.getByLabelText('PDF')).toBeInTheDocument();
    expect(screen.getByLabelText('Plain text')).toBeInTheDocument();
    expect(screen.getByLabelText('PNG image')).toBeInTheDocument();
    // Group checkboxes.
    expect(screen.getByLabelText('All Documents')).toBeInTheDocument();
    expect(screen.getByLabelText('All Images')).toBeInTheDocument();
  });

  it('checks the boxes present in value', () => {
    render(
      <AttachmentTypesChecklist value={['application/pdf']} onChange={vi.fn()} groups={GROUPS} deniedTypes={[]} />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('PDF').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Plain text').checked).toBe(false);
  });

  it('toggling a single option adds it to the emitted value', () => {
    const onChange = vi.fn();
    render(<AttachmentTypesChecklist value={[]} onChange={onChange} groups={GROUPS} deniedTypes={[]} />);
    fireEvent.click(screen.getByLabelText('PDF'));
    expect(onChange).toHaveBeenCalledWith(['application/pdf']);
  });

  it('unchecking a single option removes it from the emitted value', () => {
    const onChange = vi.fn();
    render(
      <AttachmentTypesChecklist
        value={['application/pdf', 'text/plain']}
        onChange={onChange}
        groups={GROUPS}
        deniedTypes={[]}
      />,
    );
    fireEvent.click(screen.getByLabelText('PDF'));
    expect(onChange).toHaveBeenCalledWith(['text/plain']);
  });

  it('group legend checkbox is indeterminate when partially checked', () => {
    render(
      <AttachmentTypesChecklist value={['application/pdf']} onChange={vi.fn()} groups={GROUPS} deniedTypes={[]} />,
    );
    const docsLegend = screen.getByLabelText<HTMLInputElement>('All Documents');
    expect(docsLegend.indeterminate).toBe(true);
    expect(docsLegend.checked).toBe(false);
  });

  it('group legend checkbox is fully checked when all children are checked', () => {
    render(
      <AttachmentTypesChecklist
        value={['application/pdf', 'text/plain']}
        onChange={vi.fn()}
        groups={GROUPS}
        deniedTypes={[]}
      />,
    );
    const docsLegend = screen.getByLabelText<HTMLInputElement>('All Documents');
    expect(docsLegend.checked).toBe(true);
    expect(docsLegend.indeterminate).toBe(false);
  });

  it('clicking the group legend toggles all of its children at once', () => {
    const onChange = vi.fn();
    render(<AttachmentTypesChecklist value={[]} onChange={onChange} groups={GROUPS} deniedTypes={[]} />);
    fireEvent.click(screen.getByLabelText('All Documents'));
    expect(onChange).toHaveBeenCalledWith(['application/pdf', 'text/plain']);
  });

  it('clicking a fully-checked group legend clears its children', () => {
    const onChange = vi.fn();
    render(
      <AttachmentTypesChecklist
        value={['application/pdf', 'text/plain', 'image/png']}
        onChange={onChange}
        groups={GROUPS}
        deniedTypes={[]}
      />,
    );
    fireEvent.click(screen.getByLabelText('All Documents'));
    // Only the Documents children are removed; image/png survives.
    expect(onChange).toHaveBeenCalledWith(['image/png']);
  });

  it('renders denied types as disabled rows that are NOT real inputs', () => {
    render(
      <AttachmentTypesChecklist
        value={[]}
        onChange={vi.fn()}
        groups={GROUPS}
        deniedTypes={DENIED_ATTACHMENT_TYPES}
      />,
    );
    expect(screen.getByText('Always blocked')).toBeInTheDocument();
    expect(screen.getByText('HTML')).toBeInTheDocument();
    expect(screen.getByText(/Blocked for security/)).toBeInTheDocument();
    // No checkbox is associated with a denied label (they are not inputs).
    expect(screen.queryByLabelText('HTML')).toBeNull();
    expect(screen.queryByLabelText('SVG image')).toBeNull();
  });

  it('disables every checkbox when disabled', () => {
    render(
      <AttachmentTypesChecklist value={['application/pdf']} onChange={vi.fn()} disabled groups={GROUPS} deniedTypes={[]} />,
    );
    expect(screen.getByLabelText<HTMLInputElement>('PDF').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('All Documents').disabled).toBe(true);
  });
});
