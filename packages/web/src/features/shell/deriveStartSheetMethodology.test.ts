import { describe, expect, it } from 'vitest';
import { deriveStartSheetMethodology } from './deriveStartSheetMethodology';
import type { ProjectTemplate } from '@/hooks/useProjectTemplates';

function makeTemplate(over: Partial<ProjectTemplate> = {}): ProjectTemplate {
  return {
    id: 't1',
    name: 'Skeleton',
    description: '',
    source_kind: 'workspace',
    provenance: 'Workspace',
    carries: ['structure'],
    methodology: 'HYBRID',
    task_count: 3,
    version: 1,
    program: null,
    published_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

describe('deriveStartSheetMethodology (#2728, ADR-0791)', () => {
  it('Template way: derives from the chosen template, not the program/workspace chain', () => {
    const result = deriveStartSheetMethodology({
      way: 'template',
      template: makeTemplate({ methodology: 'WATERFALL' }),
      programEffectiveMethodology: 'AGILE',
      workspaceMethodology: 'AGILE',
    });
    expect(result.methodology).toBe('WATERFALL');
    expect(result.caption).toMatch(/waterfall/i);
  });

  it('Template way with nothing chosen yet: falls through to the program/workspace chain', () => {
    const result = deriveStartSheetMethodology({
      way: 'template',
      template: null,
      programEffectiveMethodology: 'AGILE',
      workspaceMethodology: 'HYBRID',
    });
    expect(result.methodology).toBe('AGILE');
  });

  it('Blank way: prefers the selected program’s effective methodology over the workspace default', () => {
    const result = deriveStartSheetMethodology({
      way: 'blank',
      template: null,
      programEffectiveMethodology: 'AGILE',
      workspaceMethodology: 'WATERFALL',
    });
    expect(result.methodology).toBe('AGILE');
  });

  it('Blank way with no program: falls back to the workspace default (ADR-0107 chain)', () => {
    const result = deriveStartSheetMethodology({
      way: 'blank',
      template: null,
      programEffectiveMethodology: null,
      workspaceMethodology: 'WATERFALL',
    });
    expect(result.methodology).toBe('WATERFALL');
  });

  it('Import way: same derivation as Blank — the way itself carries no shape', () => {
    const result = deriveStartSheetMethodology({
      way: 'import',
      template: null,
      programEffectiveMethodology: null,
      workspaceMethodology: 'AGILE',
    });
    expect(result.methodology).toBe('AGILE');
  });

  it('falls back to Hybrid when nothing up the chain has resolved yet', () => {
    const result = deriveStartSheetMethodology({
      way: 'blank',
      template: null,
      programEffectiveMethodology: null,
      workspaceMethodology: undefined,
    });
    expect(result.methodology).toBe('HYBRID');
  });

  it('caption names both the methodology and the views it carries', () => {
    const result = deriveStartSheetMethodology({
      way: 'blank',
      template: null,
      programEffectiveMethodology: null,
      workspaceMethodology: 'AGILE',
    });
    expect(result.caption).toBe('Agile — Board, velocity, and burndown');
  });
});
