import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceRolesPage, buildRolesMatrixCsv } from './WorkspaceRolesPage';

describe('buildRolesMatrixCsv', () => {
  it('serializes the capability matrix with a header and Yes/No grants', () => {
    const csv = buildRolesMatrixCsv();
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Section,Capability,Viewer,Member,Scheduler,Admin,Owner');
    // "View tasks" is granted to every role.
    expect(csv).toContain('Tasks,View tasks,Yes,Yes,Yes,Yes,Yes');
    // "Edit any task" is Admin + Owner only.
    expect(csv).toContain('Tasks,Edit any task,No,No,No,Yes,Yes');
  });
});

describe('WorkspaceRolesPage', () => {
  // Captured so assertions reference the local mock, not URL.createObjectURL
  // as an unbound method (eslint @typescript-eslint/unbound-method).
  let createObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom implements neither createObjectURL nor anchor navigation; stub both.
    createObjectURL = vi.fn(() => 'blob:mock');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the Export matrix button enabled (lifted out of the stub fieldset)', () => {
    render(<WorkspaceRolesPage />);
    expect(screen.getByRole('button', { name: 'Export matrix' })).toBeEnabled();
  });

  it('exports a CSV blob when Export matrix is clicked (#594)', () => {
    render(<WorkspaceRolesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Export matrix' }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toContain('text/csv');
  });
});
