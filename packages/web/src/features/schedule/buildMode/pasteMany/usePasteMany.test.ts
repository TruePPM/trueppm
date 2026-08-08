import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectResource, Task } from '@/types';
import { usePasteMany } from './usePasteMany';

// ADR-0810 (#2756): usePasteMany's undo() now routes through the server-recorded
// operation ledger, not a raw client-side bulk-delete. These mocks isolate that
// branch — buildPasteOperations/parsePastedText/inferColumns are already covered
// by their own unit tests and are exercised here only far enough to populate a
// receipt.

const h = vi.hoisted(() => ({
  bulkCreate: { mutate: vi.fn(), isPending: false },
  bulkDelete: { mutate: vi.fn() },
  undoOperation: { mutate: vi.fn() },
}));

vi.mock('@/hooks/useTaskMutations', () => ({
  useBulkCreateTasks: () => h.bulkCreate,
  useBulkDeleteTasks: () => h.bulkDelete,
}));

vi.mock('@/hooks/useBatchOperations', () => ({
  useUndoPasteManyOperation: () => h.undoOperation,
}));

vi.mock('@/components/Toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

function setup() {
  return renderHook(() =>
    usePasteMany({
      projectId: 'proj-1',
      resourcePool: [] as ProjectResource[],
      allTasks: [] as Task[],
      focusedRowId: null,
      onFocusRow: vi.fn(),
    }),
  );
}

/**
 * Drive a paste to a populated receipt with the given server operation_id.
 *
 * Echoes back the client-minted ids `buildPasteOperations` actually generated
 * (read off the `mutate` call's own operations array) rather than a fixed id —
 * `commit`'s onSuccess intersects the response's applied ids against its own
 * `built.createdIds`, so a mismatched fixture id would silently produce an
 * empty receipt and every assertion below would test nothing.
 */
function paste(result: ReturnType<typeof setup>['result'], operationId: string | null) {
  h.bulkCreate.mutate = vi.fn(
    (
      ops: { id: string }[],
      opts?: {
        onSuccess?: (d: {
          applied: { op: string; id: string }[];
          operation_id: string | null;
        }) => void;
      },
    ) => {
      opts?.onSuccess?.({
        applied: ops.map((op) => ({ op: 'create', id: op.id })),
        operation_id: operationId,
      });
    },
  );
  act(() => {
    result.current.handlePaste('Survey\t5\nDesign\t3');
  });
}

describe('usePasteMany undo (ADR-0810, #2756)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('undoes through the server operation ledger when the create response carried one', () => {
    const { result } = setup();
    paste(result, 'op-1');

    act(() => result.current.undo());

    expect(h.undoOperation.mutate).toHaveBeenCalledWith('op-1', expect.anything());
    expect(h.bulkDelete.mutate).not.toHaveBeenCalled();
  });

  it('clears the receipt once the server undo succeeds', () => {
    h.undoOperation.mutate = vi.fn(
      (_id, opts?: { onSuccess?: (d: { undo: { deleted: number; kept: number } }) => void }) => {
        opts?.onSuccess?.({ undo: { deleted: 2, kept: 0 } });
      },
    );
    const { result } = setup();
    paste(result, 'op-1');
    expect(result.current.receipt).not.toBeNull();

    act(() => result.current.undo());

    expect(result.current.receipt).toBeNull();
  });

  it('falls back to the raw client-side delete if the create response carried no operation id', () => {
    const { result } = setup();
    paste(result, null);
    const createdIds = result.current.receipt?.createdIds;
    expect(createdIds?.length).toBeGreaterThan(0);

    act(() => result.current.undo());

    expect(h.bulkDelete.mutate).toHaveBeenCalledWith(createdIds, expect.anything());
    expect(h.undoOperation.mutate).not.toHaveBeenCalled();
  });

  it('is a no-op with nothing pasted yet', () => {
    const { result } = setup();

    act(() => result.current.undo());

    expect(h.undoOperation.mutate).not.toHaveBeenCalled();
    expect(h.bulkDelete.mutate).not.toHaveBeenCalled();
  });
});
