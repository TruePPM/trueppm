import type { AgentActionVerdict, AgentScope, AgentScopeLevel } from '@/api/types';
import { BanIcon, HalfCircleIcon, RadioDotIcon } from '@/components/Icons';

/** Level labels. `propose` reads "Dry run" in 0.5 (#1813): a verdict in the log, never a queue. */
export const LEVEL_LABEL: Record<AgentScopeLevel, string> = {
  none: 'No access',
  read: 'Read',
  propose: 'Dry run',
  write: 'Write',
};

const RANK: Record<AgentScopeLevel, number> = { none: 0, read: 1, propose: 2, write: 3 };

/** Whether `level` includes `wanted` on the ladder none < read < propose < write. */
export function includes(level: AgentScopeLevel | undefined, wanted: AgentScopeLevel): boolean {
  return RANK[level ?? 'none'] >= RANK[wanted];
}

/**
 * The scope in words, for a list row: "Reads schedule & tasks, dependencies; dry
 * run on schedule & tasks". Areas come from the server so labels never drift.
 */
export function scopeInWords(scope: AgentScope, areas: { key: string; label: string }[]): string {
  const reads = areas.filter((a) => includes(scope[a.key], 'read')).map((a) => a.label);
  const dry = areas.filter((a) => includes(scope[a.key], 'propose')).map((a) => a.label);
  if (reads.length === 0) return 'No access';
  const lower = (xs: string[]) => xs.map((x) => x.toLowerCase()).join(', ');
  const parts = [reads.length === areas.length ? 'Reads everything' : `Reads ${lower(reads)}`];
  if (dry.length > 0) parts.push(`dry run on ${lower(dry)}`);
  return parts.join('; ');
}

const MARK = 'inline-block h-3.5 w-3.5 align-[-0.125em]';

/**
 * Verdict chip: glyph + word, never color alone (WCAG 1.4.1). "Refused" is a
 * **neutral outline** chip with ⊘ and the word — a refusal is the system working,
 * not a failure, so it is never red (Pass 2 rule: red is critical or blocked only).
 * The guard that fired is named next to it when one is known.
 */
export function VerdictChip({
  verdict,
  constraint,
}: {
  verdict: AgentActionVerdict;
  constraint?: string;
}) {
  const base = 'inline-flex items-center gap-1 rounded-chip border px-2 py-0.5 text-xs font-medium';
  if (verdict === 'refused') {
    return (
      <span className={`${base} border-neutral-border text-neutral-text-primary`}>
        <BanIcon className={MARK} aria-hidden="true" />
        Refused
        {constraint ? (
          <span className="font-normal text-neutral-text-secondary">
            {' · '}
            {CONSTRAINT_LABEL[constraint] ?? constraint}
          </span>
        ) : null}
      </span>
    );
  }
  if (verdict === 'requires_approval') {
    return (
      <span className={`${base} border-neutral-border text-semantic-at-risk`}>
        <HalfCircleIcon className={MARK} aria-hidden="true" />
        Requires approval
      </span>
    );
  }
  return (
    <span
      className={`${base} border-transparent bg-neutral-surface-sunken text-neutral-text-primary`}
    >
      <RadioDotIcon className={MARK} aria-hidden="true" />
      Allowed
    </span>
  );
}

/** Human names for the guard that fired (RefusalConstraint). */
export const CONSTRAINT_LABEL: Record<string, string> = {
  agent_paused: 'paused',
  capability_scope: 'outside scope',
  token_identity: 'token not valid',
  graph_validation: 'would create a loop',
  sprint_sovereignty: 'sprint is committed',
  rollup_lock: 'rollup locked',
  engine_referee: 'engine refused',
};
