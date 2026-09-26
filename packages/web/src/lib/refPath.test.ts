import { describe, expect, it } from 'vitest';
import {
  isUuid,
  programPath,
  projectPath,
  refSegment,
  replaceRefSegment,
  segmentAfterRef,
} from './refPath';

const UUID = '6f1c2b1e-9a57-4c1e-8d4f-2a0b7c9e1d33';

describe('refPath', () => {
  it('recognizes only UUID-shaped values as ids', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID.toUpperCase())).toBe(true);
    expect(isUuid('PLAT')).toBe(false);
    expect(isUuid('p1')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  it('addresses an object by its key, falling back to its UUID when keyless', () => {
    expect(refSegment({ id: UUID, code: 'PLAT' })).toBe('PLAT');
    expect(refSegment({ id: UUID, code: '' })).toBe(UUID);
    expect(refSegment({ id: UUID, code: '  ' })).toBe(UUID);
    expect(refSegment({ id: UUID })).toBe(UUID);
  });

  it('builds project and program paths from the key', () => {
    expect(projectPath({ id: UUID, code: 'PLAT' }, 'schedule')).toBe('/projects/PLAT/schedule');
    expect(projectPath({ id: UUID, code: 'PLAT' })).toBe('/projects/PLAT');
    expect(projectPath({ id: UUID, code: null }, 'tasks', 'T-10')).toBe(
      `/projects/${UUID}/tasks/T-10`,
    );
    expect(projectPath({ id: UUID, code: 'PLAT' }, '/board/')).toBe('/projects/PLAT/board');
    expect(programPath({ id: UUID, code: 'atlas-platform-launch' }, 'overview')).toBe(
      '/programs/atlas-platform-launch/overview',
    );
  });

  it('swaps only the object segment and keeps the rest of the path', () => {
    expect(replaceRefSegment(`/projects/${UUID}/tasks/T-10`, 'project', 'PLAT')).toBe(
      '/projects/PLAT/tasks/T-10',
    );
    expect(replaceRefSegment('/projects/OLD', 'project', 'NEW')).toBe('/projects/NEW');
    expect(replaceRefSegment('/programs/x/settings', 'program', 'atlas')).toBe(
      '/programs/atlas/settings',
    );
    // A route of the other kind is left alone.
    expect(replaceRefSegment('/programs/x/overview', 'project', 'PLAT')).toBe(
      '/programs/x/overview',
    );
  });

  it('reads the view positionally, whatever the object segment is', () => {
    expect(segmentAfterRef('/projects/PLAT/board', 'project')).toBe('board');
    expect(segmentAfterRef(`/projects/${UUID}/settings/team`, 'project')).toBe('settings');
    expect(segmentAfterRef('/projects/PLAT', 'project')).toBeUndefined();
    expect(segmentAfterRef('/programs/atlas/backlog', 'program')).toBe('backlog');
    expect(segmentAfterRef('/me/work', 'project')).toBeUndefined();
  });
});
