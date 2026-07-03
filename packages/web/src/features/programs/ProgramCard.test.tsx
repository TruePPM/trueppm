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
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    iteration_label: null,
    inherited_iteration_label: 'Sprint',
    public_sharing: null,
    allow_guests: null,
    effective_public_sharing: false,
    effective_allow_guests: true,
    inherited_public_sharing: false,
    inherited_allow_guests: true,
    mc_history_enabled: null,
    mc_history_retention_cap: null,
    mc_history_attribution_audience: null,
    effective_mc_history_enabled: true,
    effective_mc_history_retention_cap: 100,
    effective_mc_history_attribution_audience: 'ADMIN_OWNER',
    inherited_mc_history_enabled: true,
    inherited_mc_history_retention_cap: 100,
    inherited_mc_history_attribution_audience: 'ADMIN_OWNER',
    task_duration_change_percent_policy: null,
    effective_task_duration_change_percent_policy: 'keep',
    inherited_task_duration_change_percent_policy: 'keep',
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    risk_slip_propagation: 'warn',
    risk_escalation_days: 3,
    health: 'AUTO',
    target_date: null,
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

  it('lifts on hover via a motion-safe transform, never a shadow (rule 181/1)', () => {
    renderCard(makeProgram());
    const link = screen.getByRole('link');
    expect(link.className).toContain('motion-safe:hover:-translate-y-px');
    expect(link.className).toContain('ease-brand');
    // the depth cue is the border emphasis, not a drop shadow (rule 1)
    expect(link.className).toContain('hover:border-brand-primary/40');
    expect(link.className).not.toMatch(/(^|\s)shadow-/);
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

describe('ProgramCard health + target date (#560)', () => {
  it('renders a health dot + label for a concrete (non-AUTO) health', () => {
    renderCard(makeProgram({ health: 'AT_RISK' }));
    const dot = screen.getByText('At risk').previousElementSibling;
    expect(dot).toHaveClass('rounded-full', 'bg-semantic-at-risk');
    // The single-<Link> aria-label REPLACES the inner text for SR — health must
    // be folded into it (rule 6).
    expect(screen.getByRole('link').getAttribute('aria-label')).toMatch(/health: At risk/);
  });

  it('omits the health indicator when health is AUTO (defer to the rollup)', () => {
    renderCard(makeProgram({ health: 'AUTO' }));
    expect(screen.queryByText('At risk')).not.toBeInTheDocument();
    expect(screen.queryByText('On track')).not.toBeInTheDocument();
    expect(screen.getByRole('link').getAttribute('aria-label')).not.toMatch(/health:/);
  });

  it('renders the target date and folds it into the accessible name', () => {
    renderCard(makeProgram({ target_date: '2026-09-30' }));
    expect(screen.getByText(/Target/)).toBeInTheDocument();
    expect(screen.getByRole('link').getAttribute('aria-label')).toMatch(/target/i);
  });

  it('omits the target date when unset', () => {
    renderCard(makeProgram({ target_date: null }));
    expect(screen.queryByText(/Target/)).not.toBeInTheDocument();
  });
});
