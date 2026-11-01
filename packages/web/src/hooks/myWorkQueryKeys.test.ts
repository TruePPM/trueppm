import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateMyWork, MY_WORK_KEY, TIMESHEET_ASSIGNMENTS_KEY } from './myWorkQueryKeys';

describe('invalidateMyWork (#4766)', () => {
  it('refreshes both caches of the assigned-task feed', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    invalidateMyWork(qc);
    expect(spy).toHaveBeenCalledWith({ queryKey: MY_WORK_KEY });
    expect(spy).toHaveBeenCalledWith({ queryKey: TIMESHEET_ASSIGNMENTS_KEY });
  });
});
