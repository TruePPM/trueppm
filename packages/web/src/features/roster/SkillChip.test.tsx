import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PROFICIENCY_LABEL, type Proficiency } from '@/types';
import { SkillChip, ProficiencyDots, skillChipLabel } from './SkillChip';

/**
 * The chip is a bare `<span>`, so it has no accessible name of its own — it
 * *contributes* to the name of whatever names itself from its contents. In the
 * resource picker that container is the `role="option"` row, which is the exact
 * surface #3200 is about (comparing two candidates who both match on a skill),
 * so every proficiency assertion below is made through a real option row rather
 * than by reading `textContent`. `toHaveAccessibleName` runs the same
 * name-from-content algorithm the browser does, including the leading-whitespace
 * trim that makes a naive ` — Expert` completion come back as `React— Expert`.
 */
function renderInOption(name: string, proficiency?: Proficiency) {
  render(
    <div role="option" aria-selected={false}>
      <SkillChip name={name} proficiency={proficiency} />
    </div>,
  );
  return screen.getByRole('option');
}

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

  it('sets title to "name, ProficiencyLabel" when proficiency is provided', () => {
    const { container } = render(<SkillChip name="TypeScript" proficiency={2} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip.getAttribute('title')).toBe('TypeScript, Intermediate');
  });
});

/**
 * Rule 328(b) — #3200. Each of these fails against the pre-fix chip, whose
 * accessible name was the bare skill name for every level.
 */
describe('SkillChip — proficiency is stated in the accessible name', () => {
  it('states Beginner (level 1)', () => {
    expect(renderInOption('HVAC', 1)).toHaveAccessibleName('HVAC, Beginner');
  });

  it('states Intermediate (level 2)', () => {
    expect(renderInOption('HVAC', 2)).toHaveAccessibleName('HVAC, Intermediate');
  });

  it('states Expert (level 3)', () => {
    expect(renderInOption('HVAC', 3)).toHaveAccessibleName('HVAC, Expert');
  });

  it('states the bare skill name when the resource has no proficiency for it', () => {
    // The picker's "Missing: X" chips take this branch. Nothing is appended —
    // an empty completion would read as a level the resource does not have.
    expect(renderInOption('Missing: Django')).toHaveAccessibleName('Missing: Django');
  });

  it('does not say a level the resource does not have', () => {
    // The three exact assertions above already rule out a constant, but state the
    // property directly: a chip that always said "Expert" would satisfy a
    // `toHaveAccessibleName(/Expert/)` on the level-3 case and nothing else here.
    const option = renderInOption('HVAC', 1);
    expect(option).toHaveAccessibleName('HVAC, Beginner');
    expect(option).not.toHaveAccessibleName('HVAC, Intermediate');
    expect(option).not.toHaveAccessibleName('HVAC, Expert');
  });

  it('computes a name identical to skillChipLabel for every level', () => {
    // The identity rule 328 asks for: the `title` and the accessible name are two
    // spellings of one fact only if they derive from one string. This is what the
    // em dash broke — the completion arrived trimmed as `HVAC— Expert`.
    for (const level of [1, 2, 3] as const) {
      const { unmount } = render(
        <div role="option" aria-selected={false}>
          <SkillChip name="HVAC" proficiency={level} />
        </div>,
      );
      const option = screen.getByRole('option');
      expect(option).toHaveAccessibleName(skillChipLabel('HVAC', level));
      expect(option).toHaveAccessibleName(`HVAC, ${PROFICIENCY_LABEL[level]}`);
      unmount();
    }
  });

  it('carries the completion as content, never as an aria-label on the chip', () => {
    // An `aria-label` here would REPLACE the name rather than extend it, so the
    // chip would announce "Expert" and drop the skill it exists to name. Pin the
    // mechanism, not just the resulting string.
    const { container } = render(<SkillChip name="HVAC" proficiency={3} />);
    const chip = container.firstChild as HTMLElement;
    expect(chip).not.toHaveAttribute('aria-label');
    expect(chip.querySelector('.sr-only')).toHaveTextContent('Expert');
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
