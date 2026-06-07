import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLoadSampleProgram } from '@/hooks/useProgramSeedIo';

/**
 * "Load demo data" affordance for the empty Programs index (#375).
 *
 * One click loads the Atlas hybrid-large sample program and drops the user onto
 * it, so a fresh install can feel TruePPM's depth (CPM, the agile/waterfall
 * bridge, risks, resources) without creating any data.
 */
export function LoadSampleButton() {
  const navigate = useNavigate();
  const loadSample = useLoadSampleProgram();
  const [failed, setFailed] = useState(false);

  const onClick = () => {
    setFailed(false);
    loadSample.mutate(undefined, {
      onSuccess: (program) => {
        void navigate(`/programs/${program.id}/overview`);
      },
      onError: () => setFailed(true),
    });
  };

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={onClick}
        disabled={loadSample.isPending}
        className="h-10 rounded border border-brand-primary px-5 text-sm font-medium text-brand-primary
          hover:bg-brand-primary-light
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-60"
      >
        {loadSample.isPending ? 'Loading demo…' : 'Load demo data'}
      </button>
      {failed && (
        <p role="alert" className="mt-2 text-xs text-semantic-critical">
          Could not load the demo — please try again.
        </p>
      )}
    </div>
  );
}
