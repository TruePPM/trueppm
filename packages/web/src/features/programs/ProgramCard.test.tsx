import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgramCard } from './ProgramCard';
import type { Program } from '@/api/types';

// Hoisted fns — `expect(postMock)` trips @typescript-eslint/unbound-method.
const postMock = vi.fn();
const deleteMock = vi.fn();
vi.mock('@/api/client', () => ({
  apiClient: {
    post: (...a: unknown[]) => postMock(...a) as Promise<unknown>,
    delete: (...a: unknown[]) => deleteMock(...a) as Promise<unknown>,
  },
}));

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'p-1',
    server_version: 1,
    is_pinned: false,
    name: 'Phase 2 Modernization',
    description: 'Q3 rebuild',
    code: '',
    calendar: null,
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
    estimation_scale: null,
    effective_estimation_scale: 'fibonacci',
    inherited_estimation_scale: 'fibonacci',
    sprint_picker_ready_only_default: null,
    effective_sprint_picker_ready_only_default: true,
    inherited_sprint_picker_ready_only_default: true,
    attachments_enabled: null,
    allowed_attachment_types: null,
    effective_attachments_enabled: true,
    effective_allowed_attachment_types: ['application/pdf'],
    inherited_attachments_enabled: true,
    inherited_allowed_attachment_types: ['application/pdf'],
    mcp_enabled: null,
    effective_mcp_enabled: true,
    inherited_mcp_enabled: true,
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
    my_role_label: 'Program Admin',
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ul>
          <ProgramCard program={program} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
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

describe('ProgramCard pin toggle (#1682, server-persisted #2390)', () => {
  beforeEach(() => {
    postMock.mockReset().mockResolvedValue({ data: {} });
    deleteMock.mockReset().mockResolvedValue({ data: {} });
  });

  it('renders a pin toggle that is a Link SIBLING (not nested in the anchor)', () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization' }));
    const toggle = screen.getByRole('button', { name: 'Pin Phase 2 Modernization' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // A button nested inside an <a> is invalid — the toggle must be a sibling.
    expect(toggle.closest('a')).toBeNull();
  });

  it('POSTs the pin rather than writing to localStorage (#2390)', async () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Phase 2 Modernization' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/programs/p-1/pin/');
    });
    // The pin is server state now; nothing is persisted per-browser.
    expect(localStorage.getItem('trueppm.rail.pinnedPrograms')).toBeNull();
  });

  it('DELETEs when unpinning an already-pinned program', async () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization', is_pinned: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Phase 2 Modernization' }));
    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith('/programs/p-1/pin/');
    });
  });

  it('reflects the pressed state from the server field, in NEUTRAL ink', () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization', is_pinned: true }));
    const toggle = screen.getByRole('button', { name: 'Unpin Phase 2 Modernization' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // Deliberately NOT a health hue (#2390): `--brand-primary` and
    // `--semantic-on-track` are the same token value, so a brand-filled pin would
    // read as "On track" right next to the card's own health dot. State is
    // carried by fill + ink weight + aria-pressed, never hue.
    const glyph = toggle.querySelector('svg');
    expect(glyph).not.toHaveClass('text-semantic-at-risk');
    expect(glyph).not.toHaveClass('text-semantic-on-track');
    expect(glyph).toHaveClass('text-neutral-text-primary');
  });

  // Scanning two dozen cards, an 18px corner glyph disappears. The border is the
  // group cue; the glyph is only the control (design §4.3). Safe as a hue here in
  // a way the glyph is not: health on this card is a dot plus a word, and nothing
  // else uses a tinted border.
  it('marks a pinned card with an accent border — the glyph is too small to group by', () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization', is_pinned: true }));
    expect(screen.getByRole('link')).toHaveClass('border-brand-primary/40');
  });

  it('leaves an unpinned card on the plain border', () => {
    renderCard(makeProgram({ id: 'p-1', name: 'Phase 2 Modernization', is_pinned: false }));
    const link = screen.getByRole('link');
    expect(link).toHaveClass('border-neutral-border');
    expect(link).not.toHaveClass('border-brand-primary/40');
  });
});
