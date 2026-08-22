import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { carriesLine, usageLine, TemplateCardBody } from './TemplateCard';
import type { TemplateCounts } from '@/hooks/useProjectTemplates';

function counts(over: Partial<TemplateCounts> = {}): TemplateCounts {
  return {
    task_count: 12,
    phase_count: 6,
    gate_count: 4,
    milestone_count: 2,
    dependency_count: 14,
    methodology: 'HYBRID',
    carries: ['structure', 'dependencies'],
    ...over,
  };
}

describe('carriesLine', () => {
  it('reads off the server counts, in the handoff order', () => {
    expect(carriesLine(counts())).toBe('carries 6 phases · 4 gates · 14 deps');
  });

  it('singularizes each class independently', () => {
    expect(carriesLine(counts({ phase_count: 1, gate_count: 1, dependency_count: 1 }))).toBe(
      'carries 1 phase · 1 gate · 1 dep',
    );
  });

  it('omits a class with no members rather than printing a zero', () => {
    expect(carriesLine(counts({ gate_count: 0 }))).toBe('carries 6 phases · 14 deps');
  });

  it('is empty — not "carries" alone — when the shape carries none of the three', () => {
    expect(carriesLine(counts({ phase_count: 0, gate_count: 0, dependency_count: 0 }))).toBe('');
  });

  it('is empty for a row published before counts existed', () => {
    expect(carriesLine(undefined)).toBe('');
    expect(carriesLine(null)).toBe('');
  });
});

describe('usageLine', () => {
  it('states adoption once anyone has used it', () => {
    expect(usageLine({ version: 2, usageCount: 9 })).toBe('v2 · 9 projects');
    expect(usageLine({ version: 2, usageCount: 1 })).toBe('v2 · 1 project');
  });

  it('marks an unused bundled starter as bundled, so a local shape reads first', () => {
    expect(usageLine({ version: 1, usageCount: 0, sourceKind: 'community' })).toBe('bundled v1');
  });

  it('is the bare version for an unused workspace template', () => {
    expect(usageLine({ version: 3, usageCount: 0, sourceKind: 'workspace' })).toBe('v3');
  });
});

describe('TemplateCardBody', () => {
  it('states the complement — the reassurance is what a template never brings', () => {
    render(<TemplateCardBody label="Scrum product team" detail="For a feature team" carriesLine="carries 2 phases" />);
    expect(
      screen.getByText(/carries 2 phases — never owners, dates, or progress\./),
    ).toBeInTheDocument();
  });

  it('renders no interactive element of its own', () => {
    const { container } = render(
      <TemplateCardBody label="Scrum product team" detail="For a feature team" taskCount={4} />,
    );
    expect(container.querySelectorAll('button, a, input, [tabindex]')).toHaveLength(0);
  });
});

/**
 * The invariant is "there is only one card", not "this card is correct".
 *
 * A publish preview built by hand is right the day it is written and silently
 * wrong the first time the gallery card gains a chip — and no per-file test can
 * see that, because each file passes its own. So scan for a second definition.
 */
describe('single definition', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
  }

  // Excludes this file: a scan that flags its own fixtures reports a
  // duplicate that does not ship.
  const files = walk(SRC).filter(
    (f) => !f.endsWith('TemplateCard.tsx') && !/\.test\.tsx?$/.test(f),
  );

  it('scans a non-vacuous set of files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('has exactly one source of the carries sentence', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').includes('never owners, dates, or'),
    );
    expect(offenders).toEqual([]);
  });

  it('has exactly one source of the provenance chip map', () => {
    // The three tiers together, not any one token — an on-track tint appears on
    // a dozen unrelated surfaces and flagging those would say nothing.
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes("Workspace: 'bg-brand-primary") && src.includes("Yours: 'bg-semantic");
    });
    expect(offenders).toEqual([]);
  });
});
