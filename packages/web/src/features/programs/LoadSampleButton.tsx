import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLoadSampleProgram, useSamples } from '@/hooks/useProgramSeedIo';

/**
 * "Load demo data" affordance for the empty Programs index (#375).
 *
 * When more than one sample is bundled it opens a small picker so the user can
 * choose which demo to explore; with a single sample it loads it directly. One
 * load drops the user onto the new program.
 */
export function LoadSampleButton() {
  const navigate = useNavigate();
  const { data: samples } = useSamples();
  const loadSample = useLoadSampleProgram();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (key?: string) => {
    setFailed(false);
    setOpen(false);
    loadSample.mutate(key, {
      onSuccess: (program) => void navigate(`/programs/${program.id}/overview`),
      onError: () => setFailed(true),
    });
  };

  const multiple = (samples?.length ?? 0) > 1;

  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        onClick={() => (multiple ? setOpen((v) => !v) : load())}
        disabled={loadSample.isPending}
        aria-haspopup={multiple ? 'menu' : undefined}
        aria-expanded={multiple ? open : undefined}
        className="h-10 rounded border border-brand-primary px-5 text-sm font-medium text-brand-primary
          hover:bg-brand-primary-light
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-60"
      >
        {loadSample.isPending ? 'Loading demo…' : 'Load demo data'}
        {multiple && !loadSample.isPending ? ' ▾' : ''}
      </button>

      {open && multiple && samples && (
        <ul
          role="menu"
          className="mt-2 w-80 overflow-hidden rounded border border-neutral-border bg-neutral-surface text-left shadow-lg"
        >
          {samples.map((s) => (
            <li key={s.key} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => load(s.key)}
                className="block w-full px-4 py-3 text-left hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
              >
                <span className="block text-sm font-medium text-neutral-text-primary">
                  {s.title}
                </span>
                <span className="mt-0.5 block text-xs text-neutral-text-secondary">
                  {s.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {failed && (
        <p role="alert" className="mt-2 text-xs text-semantic-critical">
          Could not load the demo — please try again.
        </p>
      )}
    </div>
  );
}
