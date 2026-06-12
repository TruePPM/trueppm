import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { generateRisksCSV, exportRisksToCSV } from './riskExport';
import type { Risk } from '@/api/types';

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
  while (i <= line.length) {
    if (line[i] === '"') {
      i++; // opening quote
      let cell = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { cell += line[i++]; }
      }
      cells.push(cell);
      if (line[i] === ',') i++;
    } else {
      const end = line.indexOf(',', i);
      if (end === -1) { cells.push(line.slice(i)); break; }
      cells.push(line.slice(i, end));
      i = end + 1;
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
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { writable: true, configurable: true, value: undefined });
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, configurable: true, value: undefined });
    vi.restoreAllMocks();
  });

  it('filename uses project slug and today ISO date', () => {
    const today = new Date().toISOString().slice(0, 10);
    exportRisksToCSV([makeRisk()], 'my-project');
    expect(capturedFilename).toBe(`risks-my-project-${today}.csv`);
  });

  it('blob content-type is text/csv;charset=utf-8', () => {
    exportRisksToCSV([makeRisk()], 'proj');
    expect(capturedBlobType).toBe('text/csv;charset=utf-8');
  });

  it('triggers anchor click', () => {
    exportRisksToCSV([makeRisk()], 'proj');
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});
