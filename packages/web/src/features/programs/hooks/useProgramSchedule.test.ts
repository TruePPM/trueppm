import { describe, it, expect } from 'vitest';
import { classifyProgramScheduleError } from './useProgramSchedule';

/** Minimal axios-shaped error — `isAxiosError(payload)` only checks the brand. */
function axiosError(status: number | undefined): unknown {
  return { isAxiosError: true, response: status === undefined ? undefined : { status } };
}

describe('classifyProgramScheduleError', () => {
  it('maps 409 to not-computed', () => {
    expect(classifyProgramScheduleError(axiosError(409))).toBe('not-computed');
  });
  it('maps 422 to too-large', () => {
    expect(classifyProgramScheduleError(axiosError(422))).toBe('too-large');
  });
  it('maps 403 to forbidden', () => {
    expect(classifyProgramScheduleError(axiosError(403))).toBe('forbidden');
  });
  it('maps other statuses to unknown', () => {
    expect(classifyProgramScheduleError(axiosError(500))).toBe('unknown');
    expect(classifyProgramScheduleError(axiosError(undefined))).toBe('unknown');
  });
  it('maps non-axios errors to unknown', () => {
    expect(classifyProgramScheduleError(new Error('network'))).toBe('unknown');
    expect(classifyProgramScheduleError(null)).toBe('unknown');
  });
});
