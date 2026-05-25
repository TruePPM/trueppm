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

  it('falls back to name initials + health tint when no code or color is set', () => {
    renderCard(makeProgram({ code: '', color: null, health: 'ON_TRACK' }));
    // "Phase 2 Modernization" → first two words → "P2".
    const square = screen.getByText('P2');
    expect(square).toHaveClass('text-semantic-on-track');
    // No inline accent color when unset.
    expect(square.style.backgroundColor).toBe('');
  });
});
