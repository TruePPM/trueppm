/**
 * Reach summary for the `@program-stakeholders` alias (#2529, ADR-0697).
 *
 * Two arms, two verbs, never a sum. External contacts are *listed*; the exact
 * Viewer-role members across the program's projects are *notified*. The external
 * arm receives nothing today — no account, no in-app notification, no email — so
 * it is never described as reached, notified, or emailed, and the deferral is
 * stated without a version number (CLAUDE.md version-status tense rule).
 *
 * The #1658 handoff phrased this as union math ("3 external ∪ 6 Viewer members").
 * #1675 superseded that: externals resolve onto a separate `external_targets`
 * field precisely so an internal mention cannot silently email a client. Printing
 * a combined total here would re-assert that union in the UI. Do not add one.
 *
 * `viewerMemberCount` is `undefined` while `GET /programs/{id}/mention-reach/` is
 * loading. In that case the internal clause is omitted entirely rather than
 * rendered as 0 or a placeholder: on the one page whose job is truthful reach,
 * absence beats a wrong figure. `viewerCountRestricted` is the distinct case of a
 * non-Admin, who never gets the number at all (the read is Admin+ per ADR-0264 §3)
 * — silence there would read as "the alias reaches nobody", so the withholding is
 * stated rather than implied.
 *
 * The wrapper is `aria-live="polite"` but carries no `role="status"` — the page's
 * error state owns the only `alert` and its empty state owns the only `status`,
 * and both are asserted bare. `aria-live` announces the arrival without minting a
 * second landmark role. The page holds the strip until both reads settle so it
 * mounts in one commit rather than growing in two steps.
 *
 * `border-l-4` and not `border-l-2`: a 2px brand-primary left rule is this app's
 * selection/active idiom (the settings rail's active item uses exactly that, in
 * this same viewport). 4px is the informational-block form.
 */

const ALIAS = '@program-stakeholders';

interface StakeholderReachSummaryProps {
  externalCount: number;
  viewerMemberCount: number | undefined;
  viewerCountRestricted?: boolean;
}

export function StakeholderReachSummary({
  externalCount,
  viewerMemberCount,
  viewerCountRestricted = false,
}: StakeholderReachSummaryProps) {
  // At zero rows the table's own empty state carries the reach sentence; a strip
  // here would say the same thing twice, ~40px apart, in two different voices.
  if (externalCount === 0) return null;

  return (
    <div
      aria-live="polite"
      className="mt-4 max-w-[480px] border-l-4 border-brand-primary pl-3"
    >
      <p className="text-[12px] leading-relaxed text-neutral-text-secondary">
        <strong className="font-semibold text-neutral-text-primary">
          {externalCount} external contact{externalCount === 1 ? '' : 's'} — listed only.
        </strong>{' '}
        No email or notification is sent to them yet; email delivery is a future,
        operator-enabled capability.
      </p>
      {viewerCountRestricted && (
        <p className="mt-1 text-[12px] leading-relaxed text-neutral-text-secondary">
          Viewer-role reach is visible to program admins.
        </p>
      )}
      {!viewerCountRestricted && viewerMemberCount !== undefined && (
        <p className="mt-1 text-[12px] leading-relaxed text-neutral-text-secondary">
          {viewerMemberCount === 0 ? (
            <>
              No Viewer-role members in this program — <span className="tppm-mono">{ALIAS}</span>{' '}
              notifies no one in-app today.
            </>
          ) : (
            <>
              {viewerMemberCount} Viewer-role member{viewerMemberCount === 1 ? '' : 's'}{' '}
              {viewerMemberCount === 1 ? 'gets' : 'get'} an in-app notification when you mention{' '}
              <span className="tppm-mono">{ALIAS}</span>.
            </>
          )}
        </p>
      )}
    </div>
  );
}

interface StakeholderEmptyStateProps {
  viewerMemberCount: number | undefined;
  canManage: boolean;
}

/**
 * Table-body empty state, which must also state current reach (#2529 AC).
 *
 * Lives beside the strip so the reach copy has one home; the page keeps ownership
 * of the `role="status"` wrapper. When the count is unavailable this falls back to
 * the bare pre-change string — never a substituted number.
 */
export function StakeholderEmptyState({
  viewerMemberCount,
  canManage,
}: StakeholderEmptyStateProps) {
  return (
    <>
      {viewerMemberCount === undefined && 'No external stakeholders yet.'}
      {viewerMemberCount === 0 && (
        <>
          No external stakeholders yet, and no Viewer-role members —{' '}
          <span className="tppm-mono">{ALIAS}</span> reaches no one today.
        </>
      )}
      {viewerMemberCount !== undefined && viewerMemberCount > 0 && (
        <>
          No external stakeholders yet — <span className="tppm-mono">{ALIAS}</span> reaches{' '}
          {viewerMemberCount} Viewer-role member{viewerMemberCount === 1 ? '' : 's'} in this
          program.
        </>
      )}
      {canManage && ' Add one below.'}
    </>
  );
}
