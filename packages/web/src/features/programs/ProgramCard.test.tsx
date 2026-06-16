import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, it, expect } from 'vitest';
import { ProgramCard } from './ProgramCard';
import type { Program } from '@/api/types';

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    name: 'Phase 2 Modernization',
    description: 'Q3 rebuild',
    code: '',
    methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    health: 'AUTO',
    visibility: 'WORKSPACE',
    color: null,
    lead: null,
    lead_detail: null,
    created_by: 'u-1',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
    my_role: 400,
    my_role_label: 'Project Admin',
    project_count: 3,
    member_count: 5,
    is_sample: false,
    is_closed: false,
    closed_at: null,
    closed_by: null,
    ...overrides,
  };
}

function renderCard(program: Program) {
  return render(
    <MemoryRouter>
      <ul>
        <ProgramCard program={program} />
      </ul>
    </MemoryRouter>,
  );
}

describe('ProgramCard identity square (#698)', () => {
  it('renders the program code in the square tinted with the accent color', () => {
    renderCard(makeProgram({ code: 'PHX', color: '#7C3AED' }));
    const square = screen.getByText('PHX');
    // Accent applied as an inline style; contrast text resolves to white here.
    expect(square).toHaveStyle({ backgroundColor: '#7C3AED' });
    expect(square).toHaveStyle({ color: '#FFFFFF' });
  });

  it('shows a neutral square (NO health tint) when no code or color is set (#963)', () => {
    // Even a healthy program's unset square stays neutral — identity must never
    // carry a status signal (the deleted HEALTH_SQUARE conflation).
    renderCard(makeProgram({ code: '', color: null, health: 'ON_TRACK' }));
    // "Phase 2 Modernization" → first two words → "P2".
    const square = screen.getByText('P2');
    expect(square).toHaveClass('bg-neutral-surface-sunken');
    expect(square.className).not.toMatch(/semantic-(on-track|at-risk|critical)/);
    // No inline accent color when unset.
    expect(square.style.backgroundColor).toBe('');
  });
});
