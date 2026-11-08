import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageTitle, SectionHeading } from './PageTitle';
import { TYPE } from './typeScale';

const bp = vi.hoisted(() => ({ value: 'lg' as 'sm' | 'md' | 'lg' }));
vi.mock('@/hooks/useBreakpoint', () => ({ useBreakpoint: () => bp.value }));

describe('PageTitle (rule 439)', () => {
  beforeEach(() => {
    bp.value = 'lg';
  });

  it('renders the one H1 on the 20/28 page-title step', () => {
    render(<PageTitle>Risks</PageTitle>);
    const h1 = screen.getByRole('heading', { level: 1, name: 'Risks' });
    expect(h1.className).toContain(TYPE.pageTitle);
    expect(h1).toHaveAttribute('title', 'Risks');
  });

  it('shows no back control at desktop widths — the breadcrumb owns ancestry', () => {
    render(<PageTitle back={{ label: 'Atlas', onBack: vi.fn() }}>Risks</PageTitle>);
    expect(screen.queryByRole('button', { name: 'Atlas' })).not.toBeInTheDocument();
  });

  it('on a phone the back label above the title is a button', async () => {
    bp.value = 'sm';
    const onBack = vi.fn();
    render(<PageTitle back={{ label: 'Atlas', onBack }}>Risks</PageTitle>);
    const back = screen.getByRole('button', { name: 'Atlas' });
    expect(back).toHaveClass('h-11');
    await userEvent.setup().click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps the H1 for the outline but hides it when the context header is the title', () => {
    bp.value = 'sm';
    render(
      <PageTitle visuallyHidden back={{ label: 'Atlas', onBack: vi.fn() }} description="x">
        Schedule
      </PageTitle>,
    );
    const h1 = screen.getByRole('heading', { level: 1, name: 'Schedule' });
    expect(h1.parentElement).toHaveClass('sr-only');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('section headings are H2 on the 15/22 step', () => {
    render(<SectionHeading>Upcoming</SectionHeading>);
    expect(screen.getByRole('heading', { level: 2, name: 'Upcoming' }).className).toContain(
      TYPE.section,
    );
  });
});

describe('TYPE scale', () => {
  it('holds the eight Pass 2 steps', () => {
    expect(Object.keys(TYPE)).toEqual([
      'lead',
      'greeting',
      'pageTitle',
      'tile',
      'section',
      'body',
      'meta',
      'mono',
    ]);
    expect(TYPE.lead).toContain('text-[44px] leading-[52px]');
    expect(TYPE.greeting).toContain('text-[32px] leading-[40px]');
    expect(TYPE.tile).toContain('tabular-nums');
    expect(TYPE.mono).toContain('font-mono');
  });
});
