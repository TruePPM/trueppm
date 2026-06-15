import { describe, expect, it, beforeEach } from 'vitest';
import { useSchedulerStore } from './schedulerStore';

describe('useSchedulerStore', () => {
  beforeEach(() => {
    // Reset the singleton store between cases (state survives across tests).
    useSchedulerStore.setState({
      isRecalculating: false,
      cpmError: null,
      recalculatedAt: null,
    });
  });

  it('starts idle with no error and no recalc timestamp', () => {
    const { isRecalculating, cpmError, recalculatedAt } = useSchedulerStore.getState();
    expect(isRecalculating).toBe(false);
    expect(cpmError).toBeNull();
    expect(recalculatedAt).toBeNull();
  });

  it('setRecalculating(true) raises the running flag (cpm_queued)', () => {
    useSchedulerStore.getState().setRecalculating(true);
    expect(useSchedulerStore.getState().isRecalculating).toBe(true);
  });

  it('setCpmError stops the spinner and records the error', () => {
    useSchedulerStore.getState().setRecalculating(true);
    const err = { error: 'cyclic_dependency' as const, cycle: ['a', 'b', 'a'] };
    useSchedulerStore.getState().setCpmError(err);

    const { isRecalculating, cpmError } = useSchedulerStore.getState();
    // A CPM error must clear the spinner, otherwise it hangs forever.
    expect(isRecalculating).toBe(false);
    expect(cpmError).toEqual(err);
  });

  it('setCpmComplete clears the spinner and any prior error, stamping the time', () => {
    useSchedulerStore.getState().setCpmError({ error: 'internal_error', cycle: [] });
    useSchedulerStore.getState().setRecalculating(true);
    useSchedulerStore.getState().setCpmComplete('2026-06-15T10:00:00Z');

    const { isRecalculating, cpmError, recalculatedAt } = useSchedulerStore.getState();
    expect(isRecalculating).toBe(false);
    expect(cpmError).toBeNull();
    expect(recalculatedAt).toBe('2026-06-15T10:00:00Z');
  });

  it('clearCpmError drops the error but leaves the spinner untouched', () => {
    useSchedulerStore.getState().setRecalculating(true);
    useSchedulerStore.getState().setCpmError({ error: 'internal_error', cycle: [] });
    // setCpmError cleared isRecalculating; raise it again to prove clearCpmError
    // does not also touch the spinner.
    useSchedulerStore.getState().setRecalculating(true);
    useSchedulerStore.getState().clearCpmError();

    const { cpmError, isRecalculating } = useSchedulerStore.getState();
    expect(cpmError).toBeNull();
    expect(isRecalculating).toBe(true);
  });
});
