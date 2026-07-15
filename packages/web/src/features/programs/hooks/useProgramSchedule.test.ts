import { describe, it, expect } from 'vitest';
import {
  classifyProgramScheduleError,
  getProgramScheduleInvalidInput,
} from './useProgramSchedule';

/** Minimal axios-shaped error — `isAxiosError(payload)` only checks the brand. */
function axiosError(status: number | undefined, data?: unknown): unknown {
  return {
    isAxiosError: true,
    response: status === undefined ? undefined : { status, data },
  };
}

const INVALID_INPUT_BODY = {
  code: 'program_schedule_invalid_input',
  detail: 'A task in “Migration Tooling” has data the schedule engine cannot compute.',
  reason: "Task 'd33fddc2' three-point estimates must satisfy optimistic <= most_likely <= pessimistic.",
  project: { id: 'p-1', name: 'Migration Tooling' },
  task: { id: 't-1', name: 'Something' },
};

describe('classifyProgramScheduleError', () => {
  it('maps 409 to not-computed', () => {
    expect(classifyProgramScheduleError(axiosError(409))).toBe('not-computed');
  });
  it('maps a code-less 422 to too-large', () => {
    expect(classifyProgramScheduleError(axiosError(422))).toBe('too-large');
    expect(
      classifyProgramScheduleError(axiosError(422, { code: 'program_schedule_too_large' })),
    ).toBe('too-large');
  });
  it('maps a program_schedule_invalid_input 422 to invalid-input', () => {
    expect(classifyProgramScheduleError(axiosError(422, INVALID_INPUT_BODY))).toBe(
      'invalid-input',
    );
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

describe('getProgramScheduleInvalidInput', () => {
  it('returns the structured body for an invalid-input 422', () => {
    const detail = getProgramScheduleInvalidInput(axiosError(422, INVALID_INPUT_BODY));
    expect(detail?.project?.name).toBe('Migration Tooling');
    expect(detail?.task?.id).toBe('t-1');
  });
  it('returns null for a too-large 422', () => {
    expect(getProgramScheduleInvalidInput(axiosError(422))).toBeNull();
    expect(
      getProgramScheduleInvalidInput(axiosError(422, { code: 'program_schedule_too_large' })),
    ).toBeNull();
  });
  it('returns null for non-422 and non-axios errors', () => {
    expect(getProgramScheduleInvalidInput(axiosError(500, INVALID_INPUT_BODY))).toBeNull();
    expect(getProgramScheduleInvalidInput(new Error('x'))).toBeNull();
  });
});
