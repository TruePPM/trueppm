/**
 * Project Settings → Signal privacy (ADR-0104 §H, #553/#854).
 *
 * The ladder is the primary editor; a read-only matrix lens is the "who sees what"
 * view. Editable by the Scrum Master (facet) or a project Admin; everyone else sees
 * the posture read-only. Methodology-gated to agile/hybrid by the nav.
 */

import { useMemo, useState } from 'react';
import type { AxiosError } from 'axios';
import { SettingsPageTitle } from '../SettingsShell';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { SignalLadder } from './SignalLadder';
import { SignalMatrixLens } from './SignalMatrixLens';
import { RaiseCeilingDialog } from './RaiseCeilingDialog';
import { CeilingProposalCard } from './CeilingProposalCard';
import { CeilingDecisionHistory } from './CeilingDecisionHistory';
import {
  SIGNALS,
  audienceRank,
  useSignalPrivacy,
  useSignalPrivacyMutations,
  type SignalAudience,
  type SignalKey,
} from './useSignalPrivacy';

/** Pull the backend's `{detail}` off a failed vote/withdraw (409 conflict), if present. */
function conflictDetail(error: unknown): string | null {
  const detail = (error as AxiosError<{ detail?: string }>)?.response?.data?.detail;
  return typeof detail === 'string' ? detail : null;
}

type View = 'ladder' | 'matrix';

export function ProjectSignalPrivacyPage() {
  const projectId = useProjectId();
  const { user } = useCurrentUser();
  const { data: policy, isLoading, isError } = useSignalPrivacy(projectId);
  const { setAudience, raiseCeiling, ratchetDown, voteOnProposal, withdrawProposal } =
    useSignalPrivacyMutations(projectId);

  const [view, setView] = useState<View>('ladder');
  const [raiseFor, setRaiseFor] = useState<SignalKey | null>(null);
  const [confirmRatchet, setConfirmRatchet] = useState(false);

  const allTeamOnly = useMemo(
    () =>
      policy
        ? SIGNALS.every(({ key }) => policy.signals[key].audience === 'team')
        : true,
    [policy],
  );

  if (!projectId) return null;

  const saving =
    setAudience.isPending || raiseCeiling.isPending || ratchetDown.isPending;
  const saveError = setAudience.isError || raiseCeiling.isError || ratchetDown.isError;
  // Vote/withdraw conflicts (e.g. the proposal resolved or expired under us) carry an
  // actionable backend `detail`; surface it in place of the generic message.
  const voteError =
    (voteOnProposal.isError && conflictDetail(voteOnProposal.error)) ||
    (withdrawProposal.isError && conflictDetail(withdrawProposal.error)) ||
    (voteOnProposal.isError || withdrawProposal.isError
      ? "Couldn't record that — please try again."
      : null);

  function pendingSignal(): SignalKey | null {
    if (setAudience.isPending) return setAudience.variables?.signal ?? null;
    if (raiseCeiling.isPending) return raiseCeiling.variables?.signal ?? null;
    return null;
  }

  return (
    <div>
      <SettingsPageTitle
        title="Signal privacy"
        subtitle="Control how far each team signal can travel. Your team owns the ceiling; the Scrum Master moves the dial below it."
      />

      <div className="max-w-2xl px-6 pb-8">
        {/* Header actions */}
        {policy && (
          <div className="mb-4 flex items-center justify-between gap-3">
            {policy.can_set_audience ? (
              confirmRatchet ? (
                <span className="flex items-center gap-2 text-[12px]">
                  <span className="text-neutral-text-secondary">
                    Set velocity, throughput, and pulse all back to team-only?
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      ratchetDown.mutate();
                      setConfirmRatchet(false);
                    }}
                    className="h-7 rounded bg-brand-primary px-3 font-medium text-neutral-text-inverse"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRatchet(false)}
                    className="h-7 rounded border border-neutral-border px-3 text-neutral-text-secondary"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRatchet(true)}
                  disabled={allTeamOnly || saving}
                  title={allTeamOnly ? 'Already all team-only' : undefined}
                  className="h-8 rounded bg-brand-primary px-3 text-[12px] font-medium text-neutral-text-inverse disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
                >
                  Make everything team-only
                </button>
              )
            ) : (
              <span />
            )}

            <span
              role="tablist"
              aria-label="View"
              className="inline-flex rounded border border-neutral-border bg-neutral-surface-raised p-0.5"
            >
              {(['ladder', 'matrix'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={[
                    'h-6 rounded px-2 text-[11px] font-medium',
                    view === v
                      ? 'bg-sage-500 text-navy-900'
                      : 'text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                >
                  {v === 'ladder' ? 'Ladder' : 'Who sees what'}
                </button>
              ))}
            </span>
          </div>
        )}

        {!policy?.can_set_audience && policy && (
          <p className="mb-3 text-[12px] text-neutral-text-secondary">
            Only the Scrum Master can change signal privacy. Raising a ceiling is a team decision
            made in the retro.
          </p>
        )}

        {saveError && (
          <p role="alert" className="mb-3 text-[13px] text-semantic-critical">
            Couldn&apos;t update — please try again.
          </p>
        )}

        {voteError && (
          <p role="alert" className="mb-3 text-[13px] text-semantic-critical">
            {voteError}
          </p>
        )}

        {raiseFor && policy && (
          <RaiseCeilingDialog
            signalTitle={SIGNALS.find((s) => s.key === raiseFor)!.title}
            currentCeiling={policy.signals[raiseFor].ceiling}
            onConfirm={(ceiling: SignalAudience) => {
              raiseCeiling.mutate({ signal: raiseFor, ceiling });
              setRaiseFor(null);
            }}
            onCancel={() => setRaiseFor(null)}
          />
        )}

        {isLoading && (
          <div className="space-y-px" aria-hidden="true">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-24 rounded bg-neutral-surface-raised motion-safe:animate-pulse" />
            ))}
          </div>
        )}

        {isError && (
          <p role="alert" className="py-4 text-[13px] text-semantic-critical">
            Failed to load signal privacy — please refresh.
          </p>
        )}

        {policy && view === 'ladder' && (
          <>
            <ul className="divide-y divide-neutral-border rounded-card border border-neutral-border">
              {SIGNALS.map(({ key, title, description }) => {
                const proposal = policy.open_proposals?.[key];
                return (
                <SignalLadder
                  key={key}
                  title={title}
                  description={description}
                  pair={policy.signals[key]}
                  canSet={policy.can_set_audience}
                  canRaiseCeiling={policy.can_raise_ceiling}
                  pending={pendingSignal() === key}
                  hasOpenProposal={!!proposal}
                  proposalSlot={
                    proposal ? (
                      <CeilingProposalCard
                        proposal={proposal}
                        signalTitle={title}
                        currentUserId={user?.id}
                        canWithdraw={
                          proposal.proposed_by === user?.id || policy.can_set_audience
                        }
                        voting={
                          voteOnProposal.isPending &&
                          voteOnProposal.variables?.proposalId === proposal.id
                        }
                        withdrawing={
                          withdrawProposal.isPending &&
                          withdrawProposal.variables?.proposalId === proposal.id
                        }
                        onVote={(choice) =>
                          voteOnProposal.mutate({ proposalId: proposal.id, choice })
                        }
                        onWithdraw={() =>
                          withdrawProposal.mutate({ proposalId: proposal.id })
                        }
                      />
                    ) : null
                  }
                  onSetAudience={(audience) => setAudience.mutate({ signal: key, audience })}
                  onRaiseCeiling={() => setRaiseFor(key)}
                  onLowerCeiling={() => {
                    // Lowering the ceiling one rung is immediate (more private is
                    // always safe); the service clamps the audience down with it.
                    const pair = policy.signals[key];
                    const next = audienceRank(pair.ceiling) - 1;
                    if (next >= 0) {
                      raiseCeiling.mutate({
                        signal: key,
                        ceiling: (['team', 'team_sm', 'team_sm_pm', 'program_shared'] as const)[
                          next
                        ],
                      });
                    }
                  }}
                />
                );
              })}
            </ul>
            {policy.can_raise_ceiling && (
              <p className="mt-3 text-[12px] text-neutral-text-secondary">
                Raising a ceiling is a team decision — it&apos;s recorded and announced to the team.
              </p>
            )}
            <CeilingDecisionHistory projectId={projectId} />
          </>
        )}

        {policy && view === 'matrix' && <SignalMatrixLens signals={policy.signals} />}
      </div>
    </div>
  );
}
