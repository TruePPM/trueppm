import { describe, expect, it } from 'vitest';
import { useGanttTasks } from './useGanttTasks';
import { FIXTURE_TASKS, FIXTURE_LINKS } from '@/fixtures/tasks';

describe('useGanttTasks (stub)', () => {
  it('returns fixture tasks and links', () => {
    const { tasks, links, isLoading, error } = useGanttTasks();
    expect(tasks).toBe(FIXTURE_TASKS);
    expect(links).toBe(FIXTURE_LINKS);
    expect(isLoading).toBe(false);
    expect(error).toBeNull();
  });

  it('fixture covers all bar types', () => {
    const { tasks } = useGanttTasks();
    expect(tasks?.some((t) => t.isSummary)).toBe(true);
    expect(tasks?.some((t) => t.isCritical && !t.isMilestone)).toBe(true);
    expect(tasks?.some((t) => t.isComplete)).toBe(true);
    expect(tasks?.some((t) => t.isMilestone)).toBe(true);
    expect(tasks?.some((t) => t.baselineStart)).toBe(true);
  });

  it('fixture covers all link types', () => {
    const { links } = useGanttTasks();
    const types = new Set(links?.map((l) => l.type));
    expect(types.has('FS')).toBe(true);
    expect(types.has('SS')).toBe(true);
    expect(types.has('FF')).toBe(true);
    expect(types.has('SF')).toBe(true);
  });
});
