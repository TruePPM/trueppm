/**
 * CustomFieldMarks — board-card custom-field rendering (#2144, ADR-0528, web-rule 271).
 * Verifies the design contract: type-aware marks, per-density caps, empty-hiding, and
 * the compact ⊕N peek. See docs/design/board-card-custom-fields.md.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CustomFieldMarks, CustomFieldCompactPeek, populatedCardFields } from './CustomFieldMarks';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import type { CustomFieldValue } from '@/types';

function field(
  over: Partial<ProjectCustomField> & { id: string; fieldType: ProjectCustomField['fieldType'] },
): ProjectCustomField {
  return {
    name: over.id,
    required: false,
    options: [],
    order: 0,
    showOnCard: true,
    serverVersion: 1,
    ...over,
  };
}

const ENV = field({
  id: 'env',
  name: 'Env',
  fieldType: 'SINGLE_SELECT',
  order: 0,
  options: [
    { value: 'prod', label: 'Prod', color: '#2F6FD1' },
    { value: 'staging', label: 'Staging', color: '#D97706' },
  ],
});
const SEV = field({ id: 'sev', name: 'Sev', fieldType: 'TEXT', order: 1 });
const COST = field({ id: 'cost', name: 'Cost', fieldType: 'NUMBER', order: 2 });
const GOLIVE = field({ id: 'golive', name: 'Go-live', fieldType: 'DATE', order: 3 });
const SIGNED = field({ id: 'signed', name: 'Signed off', fieldType: 'BOOLEAN', order: 4 });
const REVIEWER = field({ id: 'rev', name: 'Reviewer', fieldType: 'USER', order: 5 });
const AREA = field({
  id: 'area',
  name: 'Area',
  fieldType: 'MULTI_SELECT',
  order: 6,
  options: [
    { value: 'be', label: 'Backend' },
    { value: 'fe', label: 'Frontend' },
    { value: 'data', label: 'Data' },
  ],
});

const ALL = [ENV, SEV, COST, GOLIVE, SIGNED, REVIEWER, AREA];

const VALUES: Record<string, CustomFieldValue> = {
  env: 'staging',
  sev: 'High',
  cost: 1240,
  golive: '2026-08-12',
  signed: true,
  rev: { id: 'u1', name: 'Aisha Bello', initials: 'AB' },
  area: ['be', 'fe', 'data'],
};

describe('populatedCardFields', () => {
  it('omits unset, false-boolean, empty-multi, and empty-text values', () => {
    const result = populatedCardFields(ALL, {
      env: 'staging',
      signed: false, // set-false → not shown
      area: [], // empty multi → not shown
      sev: '', // empty text → not shown
      // cost/golive/rev unset → not shown
    });
    expect(result.map((r) => r.field.id)).toEqual(['env']);
  });

  it('returns nothing when the values map is undefined', () => {
    expect(populatedCardFields(ALL, undefined)).toEqual([]);
  });
});

describe('CustomFieldMarks — comfortable density', () => {
  it('caps inline marks at 3 and folds the rest behind a "+N more" peek', () => {
    render(<CustomFieldMarks fields={ALL} values={VALUES} density="comfortable" />);
    // 7 populated fields → 3 inline + "+4 more".
    expect(screen.getByText('+4 more')).toBeInTheDocument();
    // The first three (by order) are inline: Env, Sev, Cost.
    expect(screen.getByLabelText('Env: Staging')).toBeInTheDocument();
    expect(screen.getByLabelText('Sev: High')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost: 1,240')).toBeInTheDocument();
  });

  it('renders nothing when no field is populated (no empty band)', () => {
    const { container } = render(
      <CustomFieldMarks fields={ALL} values={{}} density="comfortable" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the definitions list is empty (master switch off)', () => {
    const { container } = render(
      <CustomFieldMarks fields={[]} values={VALUES} density="comfortable" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CustomFieldMarks — detailed density', () => {
  it('renders every populated field inline with no "+N more" peek', () => {
    render(<CustomFieldMarks fields={ALL} values={VALUES} density="detailed" />);
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Env: Staging')).toBeInTheDocument();
    expect(screen.getByLabelText('Reviewer: Aisha Bello')).toBeInTheDocument();
    expect(screen.getByLabelText('Area: Backend, Frontend, Data')).toBeInTheDocument();
  });

  it('renders a set boolean as a neutral yes (never green), and a number formatted', () => {
    render(<CustomFieldMarks fields={[SIGNED, COST]} values={VALUES} density="detailed" />);
    expect(screen.getByLabelText('Signed off: yes')).toBeInTheDocument();
    expect(screen.getByText('1,240')).toBeInTheDocument();
  });

  it('shows a select option label beside its color dot (color is never the sole channel)', () => {
    render(<CustomFieldMarks fields={[ENV]} values={{ env: 'prod' }} density="detailed" />);
    expect(screen.getByText('Prod')).toBeInTheDocument();
    expect(screen.getByLabelText('Env: Prod')).toBeInTheDocument();
  });
});

describe('CustomFieldCompactPeek', () => {
  it('renders a single ⊕N trigger with the populated count', () => {
    render(<CustomFieldCompactPeek fields={ALL} values={VALUES} />);
    const trigger = screen.getByRole('button', { name: '7 custom fields' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('7');
  });

  it('renders nothing when no field is populated', () => {
    const { container } = render(<CustomFieldCompactPeek fields={ALL} values={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
