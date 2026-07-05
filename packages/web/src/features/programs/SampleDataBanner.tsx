import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useRemoveSampleProgram } from '@/hooks/useProgramSeedIo';

interface SampleDataBannerProps {
  programId: string;
  /** Whether the current user may remove the sample (program owner). */
  canRemove: boolean;
}

/**
 * "This is sample data" banner shown on a sample program (#375).
 *
 * Offers a one-click teardown to owners. Confirms before deleting since the
 * action removes the whole demo program.
 */
export function SampleDataBanner({ programId, canRemove }: SampleDataBannerProps) {
  const navigate = useNavigate();
  const removeSample = useRemoveSampleProgram();
  const [confirming, setConfirming] = useState(false);

  const onRemove = () => {
    removeSample.mutate(programId, {
      onSuccess: () => {
        void navigate('/programs');
      },
    });
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-brand-primary/30 bg-brand-primary-light px-4 py-3"
    >
      <p className="text-sm text-neutral-text-primary">
        <span className="font-semibold">This is sample data.</span> It includes 60 days of history —
        forecast trend, sprint velocity, and baseline variance render out of the box. Explore freely
        — remove it when you&rsquo;re ready to start your own work.
      </p>
      {canRemove &&
        (confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-text-secondary">
              This removes the entire demo program, including any changes you made. Your own
              projects are not affected.
            </span>
            <button
              type="button"
              onClick={onRemove}
              disabled={removeSample.isPending}
              className="h-8 rounded-control bg-semantic-critical px-3 text-xs font-medium text-white hover:bg-semantic-critical/90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-semantic-critical"
            >
              {removeSample.isPending ? 'Removing…' : 'Remove'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-8 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="h-8 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-raised"
          >
            Remove sample data
          </button>
        ))}
      {removeSample.isError && (
        <p role="alert" className="w-full text-xs text-semantic-critical">
          Could not remove the sample — please try again.
        </p>
      )}
    </div>
  );
}
