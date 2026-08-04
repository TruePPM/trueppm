import { describe, it, expect } from 'vitest';
import { escapeField, tasksToCsvString } from './exportCsv';
import type { Task } from '@/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    wbs: '1',
    name: 'Test task',
    start: '2026-01-05',
    finish: '2026-01-09',
    duration: 5,
    progress: 50,
    parentId: null,
    isCritical: false,
    isComplete: false,
    isSummary: false,
    isMilestone: false,
    status: 'IN_PROGRESS',
    assignees: [],
    notes: '',
    ...overrides,
  };
}

describe('escapeField', () => {
  it('returns plain strings unmodified', () => {
    expect(escapeField('hello')).toBe('hello');
  });

  it('wraps strings containing a comma in double quotes', () => {
    expect(escapeField('Smith, John')).toBe('"Smith, John"');
  });

  it('escapes embedded double quotes as double-double-quotes', () => {
    expect(escapeField('say "hello"')).toBe('"say ""hello"""');
  });

  it('wraps strings containing a newline', () => {
    expect(escapeField('line1\nline2')).toBe('"line1\nline2"');
  });

  // ── CSV/DDE formula-injection mitigation (#2762) ──────────────────────────
  // A task name is user-supplied and, via CSV import, ingested with no character
  // filtering — so a name starting with a formula-trigger character must be
  // neutralized on export or it executes as a formula when opened in a spreadsheet.
  describe('formula-injection mitigation', () => {
    it.each(['=', '+', '-', '@', '\t', '\r'])('prefixes a value starting with %j with a leading apostrophe', (char) => {
      expect(escapeField(`${char}cmd|'/C calc'!A0`)).toBe(`'${char}cmd|'/C calc'!A0`);
    });

    it('does not prefix a value where the trigger character is not first', () => {
      expect(escapeField('Task = something')).toBe('Task = something');
    });

    it('composes the formula prefix with comma quoting', () => {
      // The prefixed value still contains a comma and a double-quote, so it must
      // also be RFC 4180–wrapped with the embedded quote doubled.
      expect(escapeField('=SUM(A1), "bad"')).toBe('"\'=SUM(A1), ""bad"""');
    });

    it('composes the formula prefix with newline quoting', () => {
      expect(escapeField('=cmd\nline2')).toBe('"\'=cmd\nline2"');
    });
  });
});

describe('tasksToCsvString', () => {
  it('produces a header row as the first line', () => {
    const csv = tasksToCsvString([]);
    const firstLine = csv.split('\r\n')[0];
    expect(firstLine).toBe('WBS,Name,Start,Finish,Duration (days),Progress (%),Status,Critical');
  });

  it('produces one data row per task', () => {
    const tasks = [makeTask(), makeTask({ id: 't2', wbs: '2', name: 'Second' })];
    const lines = tasksToCsvString(tasks).split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  it('encodes task fields in the correct column order', () => {
    const task = makeTask({ isCritical: true });
    const lines = tasksToCsvString([task]).split('\r\n');
    const dataRow = lines[1];
    expect(dataRow).toBe('1,Test task,2026-01-05,2026-01-09,5,50,IN_PROGRESS,Yes');
  });

  it('marks non-critical tasks with "No"', () => {
    const lines = tasksToCsvString([makeTask({ isCritical: false })]).split('\r\n');
    expect(lines[1].endsWith(',No')).toBe(true);
  });

  it('escapes task names that contain commas', () => {
    const task = makeTask({ name: 'Phase 1, Design' });
    const lines = tasksToCsvString([task]).split('\r\n');
    expect(lines[1]).toContain('"Phase 1, Design"');
  });

  it('neutralizes a formula-injection task name imported from CSV (#2762)', () => {
    // CSV import applies no character filtering to Task.name (parser.py), so a
    // malicious name persists verbatim and must be neutralized here on export.
    const task = makeTask({ name: "=cmd|'/C calc'!A0" });
    const lines = tasksToCsvString([task]).split('\r\n');
    expect(lines[1]).toContain("'=cmd|'/C calc'!A0");
    expect(lines[1]).not.toMatch(/,=cmd/); // raw unprefixed formula must not appear
  });

  it('produces valid RFC 4180 line endings (CRLF)', () => {
    const csv = tasksToCsvString([makeTask()]);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('handles 1000 tasks within a reasonable time budget', () => {
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      makeTask({ id: `t${i}`, wbs: String(i + 1), name: `Task ${i + 1}` }),
    );
    const start = performance.now();
    const csv = tasksToCsvString(tasks);
    const elapsed = performance.now() - start;

    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(1001); // header + 1000 data rows
    // < 100 ms locally; < 2000 ms is the CI budget (same as scheduler bench)
    expect(elapsed).toBeLessThan(2000);
  });
});
