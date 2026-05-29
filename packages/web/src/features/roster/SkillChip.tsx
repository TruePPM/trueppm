import type { Proficiency } from '@/types';
import { PROFICIENCY_LABEL } from '@/types';

interface SkillChipProps {
  name: string;
  proficiency?: Proficiency;
  /** When true, render with a warning color to indicate a missing skill. */
  missing?: boolean;
}

/** Small pill showing a skill name and optional proficiency dots. */
export function SkillChip({ name, proficiency, missing = false }: SkillChipProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border',
        missing
          ? 'border-semantic-critical/40 text-semantic-critical bg-semantic-critical-bg'
          : 'border-neutral-border text-neutral-text-secondary bg-neutral-surface-raised',
      ].join(' ')}
      title={proficiency ? `${name} — ${PROFICIENCY_LABEL[proficiency]}` : name}
    >
      {name}
      {proficiency && <ProficiencyDots level={proficiency} />}
    </span>
  );
}

/** Three dots: filled up to `level`, empty thereafter. */
export function ProficiencyDots({ level }: { level: Proficiency }) {
  return (
    <span aria-hidden="true" className="inline-flex gap-0.5">
      {([1, 2, 3] as const).map((n) => (
        <span
          key={n}
          className={[
            'w-1 h-1 rounded-full',
            n <= level ? 'bg-brand-primary' : 'bg-neutral-border',
          ].join(' ')}
        />
      ))}
    </span>
  );
}
