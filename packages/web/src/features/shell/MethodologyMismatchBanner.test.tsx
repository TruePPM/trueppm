import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '@/test/utils';
import { MethodologyMismatchBanner } from './MethodologyMismatchBanner';

// The destination is the whole point of the action — asserting only that the
// button EXISTS is what let the retired `#methodology` anchor survive a repoint
// (the same trap `methodology-hidden-sprints-view.spec.ts:246` records).
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

const MESSAGE = 'This project is configured as Waterfall, but 3 sprints already are committed here.';

afterEach(() => vi.clearAllMocks());

describe('MethodologyMismatchBanner (#2619)', () => {
  it('renders the call-site message inside a polite live region', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(MESSAGE);
  });

  it('is a status, never an alert — a standing condition must not interrupt', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('routes "Review methodology" to Settings → How this team works', async () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review methodology' }));
    expect(navigateMock).toHaveBeenCalledWith('/projects/proj-1/settings#how-this-team-works');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('is inert without a projectId (%s) rather than routing to a broken path', async (_l, id) => {
    renderWithRouter(<MethodologyMismatchBanner projectId={id} message={MESSAGE} />);
    await userEvent.click(screen.getByRole('button', { name: 'Review methodology' }));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('offers no dismiss control — the banner is a standing truth, not an event', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    // Exactly one action, so a reader cannot mistake the banner for something
    // they can clear.
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('appends the call-site className so each surface owns its own margin', () => {
    renderWithRouter(
      <MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} className="mx-6 mt-2" />,
    );
    const banner = screen.getByRole('status');
    expect(banner.className).toContain('mx-6');
    expect(banner.className).toContain('mt-2');
    // The shared chrome survives the append.
    expect(banner.className).toContain('bg-semantic-at-risk-bg');
  });

  it('ships no outer margin of its own when the call site passes none', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    expect(screen.getByRole('status').className).not.toMatch(/\bmx-\d/);
  });

  it('keeps a 44px touch target below md, and drops it above (rule: touch targets)', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    const button = screen.getByRole('button', { name: 'Review methodology' });
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('md:min-h-0');
  });

  it('carries the rule-4 focus ring', () => {
    renderWithRouter(<MethodologyMismatchBanner projectId="proj-1" message={MESSAGE} />);
    expect(screen.getByRole('button', { name: 'Review methodology' }).className).toContain(
      'focus-visible:ring-2',
    );
  });
});
