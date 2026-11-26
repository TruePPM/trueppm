import { BotIcon, CogIcon, CpuIcon, HardHatIcon } from '@/components/Icons';

export type NonHumanKind = 'bot' | 'cpu' | 'cog' | 'hard-hat';

const ICON = { bot: BotIcon, cpu: CpuIcon, cog: CogIcon, 'hard-hat': HardHatIcon } as const;

/** The Pass 2 avatar sizes, so a tile lines up in a column of avatars. */
const SIZE = { 22: 'h-[22px] w-[22px]', 28: 'h-7 w-7', 36: 'h-9 w-9' } as const;

export interface NonHumanTileProps {
  kind: NonHumanKind;
  /** The actor's accessible name, e.g. "Agent: triage bot". Required. */
  label: string;
  size?: keyof typeof SIZE;
}

/**
 * Pass 3 non-human actor tile (#4802, rule 471): a SQUARE tile with a tool icon,
 * for an agent, service, job or modeled resource. Never initials in a circle and
 * never a face — shape and icon are what tell a reader no person did this.
 */
export function NonHumanTile({ kind, label, size = 28 }: NonHumanTileProps) {
  const Icon = ICON[kind];
  return (
    <span
      role="img"
      aria-label={label}
      data-kind={kind}
      className={`inline-flex shrink-0 items-center justify-center rounded border border-p1-hairline bg-p1-surface-3 text-p1-text-1 ${SIZE[size]}`}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
