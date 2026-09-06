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
    it.each(['=', '+', '-', '@', '\t'])('prefixes a value starting with %j with a leading apostrophe', (char) => {
      expect(escapeField(`${char}cmd|'/C calc'!A0`)).toBe(`'${char}cmd|'/C calc'!A0`);
    });

    it('prefixes AND quotes a value starting with a carriage return', () => {
      // `\r` is both a formula trigger and a record separator, so it needs both
      // treatments; the prefix alone would leave the field able to end its row.
      expect(escapeField("\rcmd|'/C calc'!A0")).toBe("\"'\rcmd|'/C calc'!A0\"");
    });

    it('quotes an INTERIOR carriage return, which would otherwise forge a record', () => {
      // Records are joined with \r\n and the formula prefix only guards position
      // 0 of a field. Unquoted, this field ends its record at the \r and the next
      // record begins `=cmd…` — unprefixed, and live when opened in Excel.
      expect(escapeField("2026-99-99\r=cmd|'/C calc'!A0")).toBe(
        "\"2026-99-99\r=cmd|'/C calc'!A0\"",
      );
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
    expect(firstLine).toBe(
      'WBS,Name,Start,Finish,Duration (days),Progress (%),Status,Critical,' +
        'Total float (days),Free float (days)',
    );
  });

  it('produces one data row per task', () => {
    const tasks = [makeTask(), makeTask({ id: 't2', wbs: '2', name: 'Second' })];
    const lines = tasksToCsvString(tasks).split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 data rows
  });

  it('encodes task fields in the correct column order', () => {
    const task = makeTask({ isCritical: true, totalFloat: 4, freeFloat: 2 });
    const lines = tasksToCsvString([task]).split('\r\n');
    const dataRow = lines[1];
    expect(dataRow).toBe('1,Test task,2026-01-05,2026-01-09,5,50,IN_PROGRESS,Yes,4,2');
  });

  it('marks non-critical tasks with "No"', () => {
    const lines = tasksToCsvString([makeTask({ isCritical: false })]).split('\r\n');
    expect(lines[1].split(',')[7]).toBe('No');
  });

  it('leaves a float cell EMPTY when CPM has not run, never 0 (#3344)', () => {
    // A pre-CPM row has no float. Writing `0` would assert this task has no
    // slack — the opposite reading, and the alarming one — to every spreadsheet
    // that opens the file.
    const lines = tasksToCsvString([makeTask({ totalFloat: null, freeFloat: null })]).split('\r\n');
    expect(lines[1].endsWith(',,')).toBe(true);
  });

  it('escapes a NEGATIVE float, whose leading minus is a formula trigger (#3344)', () => {
    // `-3` starts with one of FORMULA_PREFIX_CHARS, so an unescaped cell would
    // ship something Excel evaluates. This is the case a "numbers need no
    // quoting" shortcut gets wrong.
    const lines = tasksToCsvString([makeTask({ totalFloat: -3, freeFloat: -3 })]).split('\r\n');
    expect(lines[1].endsWith(",'-3,'-3")).toBe(true);
    expect(lines[1]).not.toMatch(/,-3/);
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
