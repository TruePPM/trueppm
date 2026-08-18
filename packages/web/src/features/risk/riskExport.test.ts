import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type MockInstance } from 'vitest';
import { generateRisksCSV, exportRisksToCSV } from './riskExport';
import type { Risk } from '@/api/types';
import { localTodayIso } from '@/lib/localDate';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRisk(overrides: Partial<Risk> = {}): Risk {
  return {
    id: 'abc-123',
    short_id: '1',
    short_id_display: 'R-001',
    qualified_id: 'PLAT-R-001',
    server_version: 1,
    project: 'proj-1',
    title: 'Database outage risk',
    description: 'Servers may go down',
    status: 'OPEN',
    probability: 3,
    impact: 4,
    severity: 12,
    owner: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    tasks: [],
    notes: '',
    ...overrides,
  };
}

// RFC 4180–compliant CSV line parser. Handles quoted commas and doubled double-quotes.
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  // A field is "owed" at the start of the line and after every comma we consume,
  // which is how a trailing comma still yields a final empty cell. Driving the
  // loop on that instead of `i <= line.length` is what stops a quoted last field
  // from falling through for one more pass and appending a phantom empty cell.
  let fieldPending = true;
  while (fieldPending) {
    fieldPending = false;
    if (line[i] === '"') {
      i++; // opening quote
      let cell = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { cell += line[i++]; }
      }
      cells.push(cell);
      if (line[i] === ',') { i++; fieldPending = true; }
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { cells.push(line.slice(i)); break; }
      cells.push(line.slice(i, end));
      i = end + 1;
      fieldPending = true;
    }
  }
  return cells;
}

// Parse a full CSV string (strips BOM) into a 2-D array of cells.
function parseCsv(csv: string): string[][] {
  const clean = csv.replace(/^\uFEFF/, '');
  return clean.split('\r\n').map(parseCsvLine);
}

// ---------------------------------------------------------------------------
// parseCsvLine — the harness itself
// ---------------------------------------------------------------------------

// Every assertion below about column counts and cell contents is only as good as
// this helper. It shipped with an off-by-one that appended a phantom empty cell
// whenever a row's last field was quoted — which is most rows here, since titles
// and descriptions get quoted — so the shape being asserted was wrong (#2475).
describe('parseCsvLine — test harness', () => {
  it.each([
    ['a,b', ['a', 'b']],
    ['a,"b"', ['a', 'b']],
    ['"a",b', ['a', 'b']],
    ['"a,b",c', ['a,b', 'c']],
    ['a,b,', ['a', 'b', '']],
    ['a,"b",', ['a', 'b', '']],
    ['"say ""hi"""', ['say "hi"']],
    ['', ['']],
  ])('parses %j', (line, expected) => {
    expect(parseCsvLine(line)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// generateRisksCSV — pure string generation (no DOM / Blob needed)
// ---------------------------------------------------------------------------

describe('generateRisksCSV — CSV structure', () => {
  it('starts with UTF-8 BOM', () => {
    const csv = generateRisksCSV([makeRisk()]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });

  it('header row contains all expected columns', () => {
    const csv = generateRisksCSV([makeRisk()]);
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([
      'ID', 'Title', 'Status', 'Category', 'Response',
      'P', 'I', 'Severity', 'Owner',
      'Mitigation Due Date', 'Trigger', 'Contingency', 'Description',
    ]);
  });

  it('exports multiple risks as multiple data rows', () => {
    const csv = generateRisksCSV([
      makeRisk(),
      makeRisk({ id: 'abc-456', short_id: '00000002', title: 'Second risk' }),
    ]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(3); // header + 2 data rows
  });
});

describe('generateRisksCSV — RFC 4180 quoting', () => {
  it('values with commas are double-quoted', () => {
    const csv = generateRisksCSV([makeRisk({ title: 'Risk, priority one' })]);
    expect(csv).toContain('"Risk, priority one"');
  });

  it('embedded double-quotes are escaped by doubling', () => {
    const csv = generateRisksCSV([makeRisk({ title: 'Risk "alpha"' })]);
    expect(csv).toContain('"Risk ""alpha"""');
  });

  it('values with newlines are double-quoted', () => {
    const csv = generateRisksCSV([makeRisk({ description: 'Line 1\nLine 2' })]);
    expect(csv).toContain('"Line 1\nLine 2"');
  });
});

// ── CSV/DDE formula-injection mitigation (#2762) ────────────────────────────
// Free-text fields (owner, trigger, contingency, description) are user-supplied,
// so a value starting with a formula-trigger character must be neutralized on
// export or it executes as a formula when the file is opened in a spreadsheet.
describe('generateRisksCSV — formula-injection mitigation', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('prefixes a description starting with %j with a leading apostrophe', (char) => {
    const csv = generateRisksCSV([makeRisk({ description: `${char}cmd|'/C calc'!A0` })]);
    const rows = parseCsv(csv);
    expect(rows[1][12]).toBe(`'${char}cmd|'/C calc'!A0`);
  });

  it('does not prefix a value where the trigger character is not first', () => {
    const csv = generateRisksCSV([makeRisk({ trigger: 'Budget = exceeded' })]);
    const rows = parseCsv(csv);
    expect(rows[1][10]).toBe('Budget = exceeded');
  });

  it('composes the formula prefix with comma/quote quoting', () => {
    const csv = generateRisksCSV([makeRisk({ description: '=SUM(A1), "bad"' })]);
    // Raw, unprefixed formula text must never appear verbatim in the output.
    expect(csv).not.toMatch(/[^']=SUM\(A1\)/);
    const rows = parseCsv(csv);
    expect(rows[1][12]).toBe('\'=SUM(A1), "bad"');
  });

  it('composes the formula prefix with newline quoting', () => {
    const csv = generateRisksCSV([makeRisk({ description: '=cmd\nline2' })]);
    const rows = parseCsv(csv);
    expect(rows[1][12]).toBe("'=cmd\nline2");
  });
});

describe('generateRisksCSV — row content', () => {
  function row(overrides: Partial<Risk> = {}): string[] {
    const csv = generateRisksCSV([makeRisk(overrides)]);
    return parseCsv(csv)[1];
  }

  it('uses the server qualified_id verbatim for the ID column (#929)', () => {
    // The CSV is a cross-project surface, so it exports the fully-qualified id.
    expect(row({ qualified_id: 'PLAT-R-007' })[0]).toBe('PLAT-R-007');
  });

  it('falls back to the compact id when the project has no code (#929)', () => {
    expect(row({ qualified_id: 'R-007' })[0]).toBe('R-007');
  });

  it('translates status to human label', () => {
    expect(row({ status: 'MITIGATING' })[2]).toBe('Mitigating');
  });

  it('translates category to human label', () => {
    expect(row({ category: 'PROJECT_MANAGEMENT' })[3]).toBe('Project Management');
  });

  it('translates response to human label', () => {
    expect(row({ response: 'MITIGATE' })[4]).toBe('Mitigate');
  });

  it('P, I, Severity columns contain numeric strings', () => {
    const r = row({ probability: 3, impact: 4, severity: 12 });
    expect(r[5]).toBe('3');   // P
    expect(r[6]).toBe('4');   // I
    expect(r[7]).toBe('12');  // Severity
  });

  it('formats mitigation_due_date as readable date', () => {
    expect(row({ mitigation_due_date: '2026-06-15' })[9]).toBe('Jun 15, 2026');
  });

  it('null risk framework fields produce empty strings', () => {
    const r = row({ category: null, response: null, mitigation_due_date: null });
    expect(r[3]).toBe('');  // category
    expect(r[4]).toBe('');  // response
    expect(r[9]).toBe('');  // mitigation_due_date
  });
});

// ---------------------------------------------------------------------------
// exportRisksToCSV — download trigger (requires DOM stubs)
// ---------------------------------------------------------------------------

describe('exportRisksToCSV — download trigger', () => {
  let capturedFilename: string | null = null;
  let capturedBlobType: string | null = null;
  // Vitest 4 widens ReturnType<typeof vi.spyOn> to an any-typed MockInstance; type explicitly.
  let clickSpy: MockInstance<() => void>;

  beforeEach(() => {
    capturedFilename = null;
    capturedBlobType = null;

    // jsdom does not implement URL.createObjectURL — define it explicitly
    Object.defineProperty(URL, 'createObjectURL', {
      writable: true,
      configurable: true,
      value: (obj: Blob | MediaSource): string => {
        capturedBlobType = obj instanceof Blob ? obj.type : '';
        return 'blob:mock';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      writable: true,
      configurable: true,
      value: vi.fn(),
    });

    vi.spyOn(document.body, 'appendChild').mockImplementation((el) => {
      capturedFilename = (el as HTMLAnchorElement).download ?? null;
      return el;
    });
    // No removeChild spy: the export now calls `link.remove()` on the anchor
    // itself. appendChild above is mocked and never really attaches it, so
    // remove() on a parentless node is a no-op rather than a throw.
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { writable: true, configurable: true, value: undefined });
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, configurable: true, value: undefined });
    vi.restoreAllMocks();
  });

  it('filename uses project slug and today ISO date', () => {
    // Local calendar day, not `toISOString().slice(0, 10)` (UTC) — the export
    // now stamps the viewer's local day (#2479). Deriving the expectation from
    // `localTodayIso()` (rather than re-deriving it via a UTC method) means
    // this assertion actually tracks the fixed behavior instead of just
    // re-encoding the bug it fixed; see the TZ-pinned test below for the case
    // where local and UTC genuinely disagree.
    const today = localTodayIso();
    exportRisksToCSV([makeRisk()], 'my-project');
    expect(capturedFilename).toBe(`risks-my-project-${today}.csv`);
  });

  it('blob content-type is text/csv;charset=utf-8', () => {
    exportRisksToCSV([makeRisk()], 'proj');
    // The trailing `;` comes from the shared `downloadCsv` (#2892): this export
    // used to build its own Blob with a hand-rolled anchor sequence, which is
    // where its duplicate cell-escaper lived. Both are valid MIME strings.
    expect(capturedBlobType).toBe('text/csv;charset=utf-8;');
  });

  it('triggers anchor click', () => {
    exportRisksToCSV([makeRisk()], 'proj');
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  // ── UTC/local day-boundary regression (#2479) ─────────────────────────────
  // CI runs in UTC, so the test above can't distinguish "local day" from "UTC
  // day" — they always agree there. Pin a non-UTC system timezone and a fixed
  // instant where the local calendar day and the UTC calendar day genuinely
  // differ, then assert the filename carries the *local* day.
  describe('filename — local vs UTC day boundary', () => {
    // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
    const ORIGINAL_TZ = process.env.TZ;

    beforeAll(() => {
      // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
      process.env.TZ = 'America/New_York';
    });

    afterAll(() => {
      // eslint-disable-next-line no-undef -- `process` is available in the vitest (node) runtime; test files only load browser globals in eslint.
      process.env.TZ = ORIGINAL_TZ;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('stamps the local calendar day, not the UTC day, near midnight', () => {
      // 2026-01-15T04:30:00Z is 2026-01-14 23:30 in America/New_York (EST,
      // UTC-5 — plain winter standard time, no DST transition nearby).
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T04:30:00Z'));

      const localDay = localTodayIso();
      const utcDay = new Date().toISOString().slice(0, 10);
      // Sanity-check the fixture premise: if these ever agree, the test proves
      // nothing about UTC vs. local — fail loudly instead of passing vacuously.
      expect(localDay).not.toBe(utcDay);
      expect(localDay).toBe('2026-01-14');
      expect(utcDay).toBe('2026-01-15');

      exportRisksToCSV([makeRisk()], 'my-project');
      expect(capturedFilename).toBe(`risks-my-project-${localDay}.csv`);
    });
  });
});
