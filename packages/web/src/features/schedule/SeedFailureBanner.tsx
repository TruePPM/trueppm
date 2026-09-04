import { useCallback } from 'react';
import { toast } from '@/components/Toast/toast';
import { useApplyTemplate, useTemplateApplication } from '@/hooks/useProjectTemplates';
import { describeWriteRefusal } from '@/lib/writeRefusal';
import { ROLE_ADMIN } from '@/lib/roles';

interface SeedFailureBannerProps {
  projectId: string;
  applicationId: string;
  /** The caller's role on this project; `null` while loading. */
  currentRole: number | null;
  /**
   * A retry was accepted and the server minted a NEW application. The parent swaps
   * `seedApplicationId` to it — and must also clear the one-shot latches that
   * `ScheduleView` keeps for the first apply, or the retried one never invalidates
   * on success and never shows the skeleton past the 60s timer.
   */
  onRetried: (applicationId: string) => void;
  onDismiss: () => void;
}

/** Shown when `error_detail` is empty — the row exists, the reason does not. */
const NO_REASON = "The server didn't record a reason.";

/**
 * The failure counterpart of `SeedBanner` (#3348, ADR-0799 §1).
 *
 * `SeedBanner` renders only on `success` and `ScheduleSeedingState` only while the
 * apply is still writing, so a terminal `failed` fell through to the ordinary
 * blank-project canvas and said NOTHING: the user picked a template, landed on the
 * Schedule, and saw an empty project with no statement that the thing they asked
 * for had not happened. `error_detail` had been on the serializer since the feature
 * shipped with no reader anywhere in the web.
 *
 * **The project really is empty, and that is the headline fact.** `apply_template`
 * runs the claim and `materialize_structure` inside ONE `transaction.atomic()` —
 * every nested write is a savepoint, nothing defers to `on_commit`, and no
 * independent connection is opened — so any failure rolls the whole seed back.
 * There is no such thing as a partially-applied template, and `created_task_ids` is
 * never even populated on the failure path. Hence: no undo offer here (there is
 * nothing to undo), and the copy states the emptiness as reassurance rather than
 * leaving the user to wonder what half-landed.
 *
 * Note ADR-0789 §Durable Execution 8 asserts the opposite — that partial rows are
 * "kept, not rolled back" and that `created_task_ids` records them. It contradicts
 * §7 of the same section and the implementation; the correction is tracked
 * separately. Do not design against §8.
 *
 * Deliberately a SIBLING of `SeedBanner` rather than a branch inside it: that
 * component's whole contract is summarizing a finished, successful apply and
 * offering to throw it away (⌘Z undo, delete-untouched, the counts line), none of
 * which survives contact with a failure. Both poll the same query key, so the pair
 * shares one cache entry and adds no request — and `refetchInterval` already stops
 * on a terminal status, so nothing polls on behind this banner.
 *
 * Equally deliberately, the empty-state ladder BENEATH is untouched. "Continue with
 * an empty project" is not an affordance to build — it is the blank canvas already
 * there, and replacing the surface would force the user to dismiss a card to reach
 * the thing they were going to do anyway.
 *
 * Shaped after `SprintCloseFailedBanner`, the nearest precedent: `role="alert"` on
 * the container rather than an sr-only twin, so the recovery sentence is ANNOUNCED
 * rather than only painted and no sentence is restated three ways; retry before
 * dismiss in the DOM, so reaching the way out never means tabbing past the control
 * that throws it away; `focus:` rings, not `focus-visible:` (rule 4/214); and no
 * `semantic-critical/N` tint on the controls, because this background is already a
 * critical tint and a tinted control inside it composites twice (rule 336).
 */
export function SeedFailureBanner({
  projectId,
  applicationId,
  currentRole,
  onRetried,
  onDismiss,
}: SeedFailureBannerProps) {
  const { data: application } = useTemplateApplication(applicationId);
  const applyMutation = useApplyTemplate();

  const templateId = application?.template ?? null;
  const canManage = currentRole !== null && currentRole >= ROLE_ADMIN;
  // Both must hold. A deleted template makes retry structurally impossible whatever
  // the role, and below Admin the endpoint would 403 — a control that would refuse
  // must never read as actionable (rule 373(c)), so it is OMITTED, not disabled.
  const canRetry = canManage && templateId !== null;

  const handleRetry = useCallback(() => {
    if (templateId === null) return;
    applyMutation.mutate(
      { templateId, projectId },
      {
        // No success toast: the seeding skeleton replacing this banner IS the
        // confirmation, and a toast on top of it would be redundant noise.
        onSuccess: (data) => onRetried(data.application),
        // The retry's OWN refusal is a different error from the one on screen — the
        // role can have been lost since load, the template deleted between render
        // and click (this component's guard reads a cached row), the project
        // archived meanwhile. Saying "Try again" on a 403 or a 404 points at the one
        // act guaranteed not to help, so both the sentence and whether retry advice
        // is honest come from `describeWriteRefusal` (rule 372).
        onError: (error) => {
          const refusal = describeWriteRefusal(error, "Couldn't start the apply.");
          if (!refusal) return;
          toast.error(refusal.retryable ? `${refusal.message} Try again.` : refusal.message);
        },
      },
    );
  }, [applyMutation, templateId, projectId, onRetried]);

  // Gate on the terminal value EXPLICITLY (rule 301): an unmapped future status must
  // fall through to the ordinary empty state, never into a red failure banner.
  if (!application || application.status !== 'failed') return null;

  const templateName = application.template_name;
  // Defensive despite `error_detail: string` on the type — several suites stub this
  // resource partially, and a banner is the wrong place to discover that.
  const detail = application.error_detail?.trim() ?? '';
  const reasonText = detail ? `Reason: ${detail}` : NO_REASON;

  // A deleted template outranks the role: telling somebody to ask an admin to do an
  // impossible thing is worse than saying nothing about it.
  let recovery: string;
  if (templateId === null) {
    recovery =
      "This template no longer exists, so it can't be applied again. Start building this project below.";
  } else if (canManage) {
    recovery = 'Try again, or just start building this project below.';
  } else {
    recovery =
      'Ask a project admin to apply it again, or just start building this project below.';
  }

  return (
    <section
      // `role="alert"` (assertive) on the container, not on an sr-only twin: this is
      // the terminal failure of an act the user explicitly requested, so it must
      // interrupt — and announcing the container means the RECOVERY sentence is
      // heard too. A screen-reader user who hears what broke but not the way out has
      // been told the worse half. The text is static (terminal status, polling has
      // stopped), so it cannot re-announce on a tick (rule 220).
      role="alert"
      data-testid="seed-failure-banner"
      className="flex flex-shrink-0 flex-wrap items-start gap-3 border-b border-semantic-critical/40 bg-semantic-critical-bg px-4 py-2"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs text-neutral-text-primary">
          <span className="font-medium text-semantic-critical">
            Couldn&rsquo;t apply &ldquo;{templateName}&rdquo;.
          </span>{' '}
          {/* The most reassuring fact available, and the one that was unsaid: a
              failed apply is a total rollback, so there is no debris to hunt for. */}
          <span className="text-neutral-text-secondary">
            Nothing was written. This project is exactly as empty as it was before.
          </span>
        </p>
        {/* Verbatim and unclamped, matching every other server-error surface in the
            tree (ImportProgramButton, CsvImportWizard, ScheduleReconcileStrip,
            exportJobDisplay). A truncated diagnostic is undiagnosable, and the
            server already caps `error_detail` at 2000 characters. */}
        <p
          data-testid="seed-failure-banner-reason"
          className="mt-0.5 break-words text-xs text-neutral-text-secondary"
        >
          {reasonText}
        </p>
        {/* Names the empty canvas underneath as a CHOICE. Without this line it reads
            as a leftover the failure dumped the user on. */}
        <p
          data-testid="seed-failure-banner-recovery"
          className="mt-0.5 text-xs text-neutral-text-secondary"
        >
          {recovery}
        </p>
      </div>

      {/* Retry FIRST, dismiss second — in the DOM as well as visually. The dismiss
          here is not the sibling's cheap one: this banner is the only reader of
          `error_detail` in the whole web, and the `?templateApplication=` id was
          stripped one-shot on consume (rule 374(b)), so a reload cannot bring the
          reason back. A first tab stop that destroys the surface's payload is the
          wrong first tab stop. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {canRetry && (
          // No two-click confirm: `SeedBanner`'s `confirmingDelete` idiom guards
          // DESTRUCTIVE acts, and retrying is additive — it is precisely what the
          // user already asked for. A confirmation here would be ceremony.
          // Opaque `bg-neutral-surface`, never a critical tint: the banner behind it
          // is already tinted, and a second tint composites below 4.5:1 (rule 336).
          <button
            type="button"
            onClick={handleRetry}
            disabled={applyMutation.isPending}
            data-testid="seed-failure-banner-retry"
            className="h-7 rounded px-2.5 text-xs font-medium
              border border-semantic-critical/40 bg-neutral-surface text-semantic-critical
              hover:bg-neutral-surface-raised disabled:opacity-60
              focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            {applyMutation.isPending ? 'Applying…' : 'Try again'}
          </button>
        )}
        {/* 28px box, 44px target. This banner renders on phones — it is mounted above
            `ScheduleMainArea`'s `isMobile` return — so rule 5's floor applies, and
            rule 330(a) says grow the TARGET rather than inset the box, so the glyph
            stays the size its siblings are. The overhang is safe: this cluster is the
            row's last child and the text block beside it is `min-w-0 flex-1`. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss seed failure banner"
          data-testid="seed-failure-banner-dismiss"
          className="relative h-7 w-7 grid place-items-center rounded text-neutral-text-secondary
            before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11
            before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']
            hover:bg-neutral-surface-raised
            focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </section>
  );
}
