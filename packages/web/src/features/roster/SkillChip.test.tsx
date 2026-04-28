import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SkillChip, ProficiencyDots } from './SkillChip';

describe('SkillChip', () => {
  it('renders the skill name', () => {
    render(<SkillChip name="React" />);
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('renders with normal border classes when missing=false (default)', () => {
    const { container } = render(<SkillChip name="React" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.className).toContain('border-neutral-border');
    expect(chip.className).not.toContain('border-semantic-critical');
  });

  it('renders with warning/critical classes when missing=true', () => {
    const { container } = render(<SkillChip name="Python" missing={true} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.className).toContain('border-semantic-critical');
    expect(chip.className).not.toContain('border-neutral-border');
  });

  it('renders without proficiency dots when proficiency is omitted', () => {
    const { container } = render(<SkillChip name="React" />);
    // No dot spans — no aria-hidden proficiency dots
    const dots = container.querySelectorAll('[aria-hidden="true"]');
    expect(dots).toHaveLength(0);
  });

  it('sets title to name only when proficiency is omitted', () => {
    const { container } = render(<SkillChip name="React" />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.getAttribute('title')).toBe('React');
  });

  it('renders proficiency dots when proficiency is provided', () => {
    const { container } = render(<SkillChip name="TypeScript" proficiency={2} />);
    // ProficiencyDots renders a aria-hidden span
    const dotContainer = container.querySelector('[aria-hidden="true"]');
    expect(dotContainer).toBeInTheDocument();
    // 3 dot spans inside
    expect(dotContainer?.querySelectorAll('span')).toHaveLength(3);
  });

  it('sets title to "name — ProficiencyLabel" when proficiency is provided', () => {
    const { container } = render(<SkillChip name="TypeScript" proficiency={2} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.getAttribute('title')).toContain('TypeScript');
    expect(chip.getAttribute('title')).toContain('—');
  });
});

describe('ProficiencyDots', () => {
  it('renders 3 dots for level 1 — first filled, rest empty', () => {
    const { container } = render(<ProficiencyDots level={1} />);
    const dots = container.querySelectorAll('span > span');
    expect(dots).toHaveLength(3);
    expect(dots[0].className).toContain('bg-brand-primary');
    expect(dots[1].className).toContain('bg-neutral-border');
    expect(dots[2].className).toContain('bg-neutral-border');
  });

  it('renders 3 dots for level 2 — first two filled', () => {
    const { container } = render(<ProficiencyDots level={2} />);
    const dots = container.querySelectorAll('span > span');
    expect(dots[0].className).toContain('bg-brand-primary');
    expect(dots[1].className).toContain('bg-brand-primary');
    expect(dots[2].className).toContain('bg-neutral-border');
  });

  it('renders 3 dots for level 3 — all filled', () => {
    const { container } = render(<ProficiencyDots level={3} />);
    const dots = container.querySelectorAll('span > span');
    expect(dots[0].className).toContain('bg-brand-primary');
    expect(dots[1].className).toContain('bg-brand-primary');
    expect(dots[2].className).toContain('bg-brand-primary');
  });
});
