/**
 * URL state for the project Activity tab's sub-view split (#2481, ADR-0677).
 *
 * The tab hosts two lenses on "what happened here": the ADR-0201 changelog
 * (`Changes`) and the agent-action log (`Agents`). Kept pure and separate from
 * `changelogUrl.ts` because the two sub-views own disjoint params — the changelog
 * chips (`type` / `change` / `user`) mean nothing to an agent action, and the
 * agent filters (`refused`) mean nothing to a changelog entry.
 *
 * `Changes` is the parameterless default, so every Activity deep-link written
 * before this feature resolves byte-identically.
 */

export type ActivitySubView = 'changes' | 'agents';

/** URL param naming the sub-view. Absent = `changes`. */
export const VIEW_PARAM = 'view';
/** URL param for the "Refusals only" chip. Present and `1` = on. */
export const REFUSED_PARAM = 'refused';
/** URL param for the agent-activity time window. Absent = the `7d` default. */
export const AGENT_RANGE_PARAM = 'arange';

export type AgentRange = '24h' | '7d' | '30d' | 'all';

export const AGENT_RANGES: readonly { key: AgentRange; label: string; ms: number | null }[] = [
  { key: '24h', label: 'Last 24h', ms: 24 * 3_600_000 },
  { key: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { key: 'all', label: 'All time', ms: null },
];

const AGENT_RANGE_SET = new Set<string>(AGENT_RANGES.map((r) => r.key));

/** The default window. Matches the program panel so the two surfaces agree. */
export const DEFAULT_AGENT_RANGE: AgentRange = '7d';

/** Parse the active sub-view, defaulting to `changes` for any unknown token. */
export function subViewFromParams(params: URLSearchParams): ActivitySubView {
  return params.get(VIEW_PARAM) === 'agents' ? 'agents' : 'changes';
}

export function refusalsOnlyFromParams(params: URLSearchParams): boolean {
  return params.get(REFUSED_PARAM) === '1';
}

export function agentRangeFromParams(params: URLSearchParams): AgentRange {
  const raw = params.get(AGENT_RANGE_PARAM) ?? '';
  return AGENT_RANGE_SET.has(raw) ? (raw as AgentRange) : DEFAULT_AGENT_RANGE;
}

/**
 * Build the search params for the Agents sub-view. Defaults are omitted so a
 * shared link carries only what the sender actually chose.
 *
 * This deliberately does NOT preserve the changelog's own params: switching to
 * Agents drops `type`/`change`/`user`/`range`, because carrying filters that the
 * visible sub-view cannot apply would leave the user with invisible narrowing.
 */
export function agentParams({
  refusalsOnly,
  range,
}: {
  refusalsOnly: boolean;
  range: AgentRange;
}): URLSearchParams {
  const params = new URLSearchParams();
  params.set(VIEW_PARAM, 'agents');
  if (refusalsOnly) params.set(REFUSED_PARAM, '1');
  if (range !== DEFAULT_AGENT_RANGE) params.set(AGENT_RANGE_PARAM, range);
  return params;
}
