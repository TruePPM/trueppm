import { useProjectId } from '@/hooks/useProjectId';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_OWNER } from '@/lib/roles';
import {
  useProjectGuardrailPolicy,
  COMPOSITION_RULES,
  ALL_RULES,
  RULE_LABEL,
  type GuardrailRule,
  type GuardrailLevel,
} from '@/hooks/useProjectGuardrailPolicy';
import { SettingsPageTitle } from '../SettingsShell';

/**
 * Project > Sprint guardrails settings page (ADR-0101 §3).
 *
 * Surfaces the per-project guardrail policy as a rule-by-rule matrix:
 * Warn (default, override permitted) vs Block (Owner-escalated, no override).
 *
 * Sprint-sovereignty UI: only role≥OWNER may escalate a composition rule to
 * Block. The Block button is disabled with an inline reason for everyone
 * else. The server enforces the same gate — the UI mirror is a courtesy.
 * `subtasks_split` is advisory-only and not escalatable on either side.
 *
 * When the policy `source` is `external` (an Enterprise resolver supplied it),
 * the page shows a persistent banner naming who set it; if the team hasn't
 * acknowledged, any composition Block is *inert* until the team toggles
 * acknowledgement. The team-ack gate is enforced in OSS code so a custom
 * high-ordinal Enterprise role can't bypass sprint sovereignty.
 */
export function ProjectGuardrailsPage() {
  const projectId = useProjectId();
  const itl = useIterationLabel(projectId);
  const { role } = useCurrentUserRole(projectId ?? undefined);
  const { policy, isLoading, error, update } = useProjectGuardrailPolicy(projectId);

  const canEscalate = (role ?? -1) >= ROLE_OWNER;

  function setRuleLevel(rule: GuardrailRule, level: GuardrailLevel) {
    update.mutate({ levels: { [rule]: level } });
  }

  function toggleAck() {
    if (!policy) return;
    update.mutate({ acknowledgedByTeam: !policy.acknowledgedByTeam });
  }

  if (isLoading) {
    return (
      <div>
        <SettingsPageTitle
          title={`${itl.singular} guardrails`}
          subtitle={`Decide which ${itl.lower}/phase mistakes warn the team and which the team's Owner blocks outright.`}
        />
        <div className="px-6 pb-8 text-[13px] text-neutral-text-secondary">Loading…</div>
      </div>
    );
  }

  if (error || !policy) {
    return (
      <div>
        <SettingsPageTitle
          title={`${itl.singular} guardrails`}
          subtitle={`Decide which ${itl.lower}/phase mistakes warn the team and which the team's Owner blocks outright.`}
        />
        <div className="px-6 pb-8 text-[13px] text-semantic-critical" role="alert">
          Failed to load guardrail policy. Try refreshing the page.
        </div>
      </div>
    );
  }

  // An EXTERNAL composition Block is inert until ack — surface it explicitly
  // so the team understands why a block they see configured isn't enforcing.
  const inertExternalCompBlock =
    policy.source === 'external' &&
    !policy.acknowledgedByTeam &&
    COMPOSITION_RULES.some((r) => policy.levels[r] === 'block');

  return (
    <div>
      <SettingsPageTitle
        title={`${itl.singular} guardrails`}
        subtitle={`Decide which ${itl.lower}/phase mistakes warn the team and which the team's Owner blocks outright. Subtask-split warnings are always advisory.`}
      />

      <div className="px-6 pb-8 max-w-[920px] space-y-4">
        {/* External-policy banner. Persistent (per ADR — names who set it) and
            renders before the matrix so the team sees the source first. */}
        {policy.source === 'external' && (
          <div
            role="status"
            aria-live="polite"
            className={[
              'rounded-lg border p-4 flex items-start gap-4',
              policy.acknowledgedByTeam
                ? 'border-neutral-border bg-neutral-surface-raised'
                : 'border-semantic-at-risk/40 bg-sem-at-risk-bg',
            ].join(' ')}
          >
            <div className="flex-1">
              <h2 className="text-[13px] font-semibold text-neutral-text-primary">
                Policy set by {policy.sourceLabel || 'an external administrator'}
              </h2>
              <p className="text-[12px] text-neutral-text-secondary leading-snug mt-0.5">
                {policy.acknowledgedByTeam
                  ? 'This team has acknowledged the policy. Any blocks below are enforced.'
                  : 'Blocks below are inert until the team acknowledges. Warnings still fire.'}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleAck}
              className="shrink-0 min-h-[44px] sm:min-h-0 sm:h-9 px-3 rounded text-xs font-medium
                border border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-sunken
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              {policy.acknowledgedByTeam ? 'Withdraw acknowledgement' : 'Acknowledge'}
            </button>
          </div>
        )}

        {inertExternalCompBlock && (
          <p className="text-[12px] text-neutral-text-secondary italic">
            Composition rules currently configured as Block are shown below as
            Warn — they activate once the policy is acknowledged.
          </p>
        )}

        {/* Rule matrix. Each row exposes Warn / Block as a two-button choice;
            the advisory-only rule shows a fixed Warn pill (no Block path). */}
        <div className="bg-neutral-surface-raised border border-neutral-border rounded-lg overflow-hidden">
          <div className="grid px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55
              text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary"
            style={{ gridTemplateColumns: '2fr 220px' }}>
            <span>Rule</span>
            <span className="text-right">Enforcement</span>
          </div>

          {ALL_RULES.map((rule) => {
            const isComposition = COMPOSITION_RULES.includes(rule);
            const effective = policy.effectiveLevels[rule] ?? 'warn';
            // For advisory rules show a fixed Warn pill — no escalation path.
            const isAdvisoryOnly = !isComposition;

            return (
              <div
                key={rule}
                className="grid px-4 py-3 border-b border-neutral-border/55 last:border-b-0 items-start gap-3"
                style={{ gridTemplateColumns: '2fr 220px' }}
              >
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-neutral-text-primary">
                    {RULE_LABEL[rule].title}
                  </div>
                  <p className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">
                    {RULE_LABEL[rule].outcome}
                  </p>
                </div>
                <div className="flex items-center justify-end gap-1.5">
                  {isAdvisoryOnly ? (
                    <span
                      className="inline-flex items-center px-2.5 py-1 rounded text-[11px] font-medium
                        border border-neutral-border text-neutral-text-secondary bg-neutral-surface"
                      title="Advisory — cannot be escalated to a hard block"
                    >
                      Warn (advisory)
                    </span>
                  ) : (
                    <>
                      <LevelPill
                        label="Warn"
                        active={effective === 'warn'}
                        disabled={update.isPending}
                        onClick={() => setRuleLevel(rule, 'warn')}
                        tone="neutral"
                        aria-label={`${RULE_LABEL[rule].title}: warn (allow with override)`}
                      />
                      <LevelPill
                        label="Block"
                        active={effective === 'block'}
                        disabled={!canEscalate || update.isPending}
                        onClick={() => setRuleLevel(rule, 'block')}
                        tone="critical"
                        aria-label={
                          canEscalate
                            ? `${RULE_LABEL[rule].title}: block (no override)`
                            : `${RULE_LABEL[rule].title}: block (no override) — only the project Owner can escalate this rule`
                        }
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {!canEscalate && (
          <p className="text-[12px] text-neutral-text-secondary italic">
            Only a project Owner can change a sprint-composition rule from
            Warn to Block. Any project member can lower a Block back to Warn.
          </p>
        )}
      </div>
    </div>
  );
}

interface LevelPillProps {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  tone: 'neutral' | 'critical';
  'aria-label': string;
}

function LevelPill({ label, active, disabled, onClick, tone, ...aria }: LevelPillProps) {
  const activeClass =
    tone === 'critical'
      ? 'border-semantic-critical text-semantic-critical bg-sem-critical-bg'
      : 'border-brand-primary text-brand-primary bg-brand-primary-light';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={aria['aria-label']}
      className={[
        // Touch viewport: 44px tall (WCAG 2.5.5 AA); desktop collapses to 32px.
        'inline-flex items-center justify-center min-h-[44px] sm:min-h-0 sm:h-8 min-w-[68px]',
        'px-2.5 rounded text-[11px] font-medium border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        active
          ? activeClass
          : 'border-neutral-border text-neutral-text-secondary hover:bg-neutral-surface-sunken',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
