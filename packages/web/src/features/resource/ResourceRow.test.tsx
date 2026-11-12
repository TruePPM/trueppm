import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ResourceRow } from './ResourceRow';
import type { UtilizationResource } from './resourceUtils';

const resource = {
  resource_id: 'r1',
  resource_name: 'Sam Reyes',
  hours_per_day: 8,
  max_units: '1',
  calendar_differs_from_project: false,
  days: {},
} as unknown as UtilizationResource;

function nameCell(rowIndex: number): HTMLElement {
  const { container } = render(
    <ResourceRow resource={resource} days={[]} rowIndex={rowIndex} onOpenDrawer={() => {}} />,
  );
  return container.querySelector('[title="Sam Reyes"]') as HTMLElement;
}

describe('ResourceRow sticky name column', () => {
  it('paints the odd-row tint via a token class, with no inline hex/var fallback', () => {
    const cell = nameCell(1);
    expect(cell.className).toContain('bg-neutral-surface-sunken');
    expect(cell.getAttribute('style') ?? '').not.toMatch(/#|var\(/);
  });

  it('uses the plain surface on even rows', () => {
    const cell = nameCell(0);
    expect(cell.className).toContain('bg-neutral-surface');
    expect(cell.className).not.toContain('bg-neutral-surface-sunken');
  });
});
