import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useLoadSampleProgram, useSamples, type SampleInfo } from '@/hooks/useProgramSeedIo';

/**
 * "3 projects · 88 tasks" — the scale of a sample, for the picker row.
 *
 * Answers the question someone actually has in front of a "Load demo data"
 * button: how much is this about to write? Returns null when the server could
 * not summarize the fixture, in which case the row falls back to the sample's
 * description rather than rendering a gap.
 */
function sampleScale(sample: SampleInfo): string | null {
  // `typeof`, not `!== null`: an older cached catalog response (or a test mock
  // written against the pre-#2490 shape) omits these keys entirely, and
  // `undefined !== null` would sail through and render "undefined projects".
  if (typeof sample.project_count !== 'number' || typeof sample.task_count !== 'number') {
    return null;
  }
  const projects = `${sample.project_count} ${sample.project_count === 1 ? 'project' : 'projects'}`;
  return `${projects} · ${sample.task_count} tasks`;
}

interface LoadSampleButtonProps {
  /** Visual variant — header (compact, dropdown overlays) or empty-state (large, centered). */
  variant?: 'header' | 'hero';
}

/**
 * "Load demo data" affordance for the Programs index (#375).
 *
 * Rendered both in the index header (always available, so a populated instance
 * can still load a demo) and in the zero-programs empty-state hero. When more
 * than one sample is bundled it opens a small picker so the user can choose
 * which demo to explore; with a single sample it loads it directly. One load
 * drops the user onto the new program.
 */
export function LoadSampleButton({ variant = 'hero' }: LoadSampleButtonProps) {
  const navigate = useNavigate();
  const { data: samples } = useSamples();
  const loadSample = useLoadSampleProgram();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = (key?: string) => {
    setFailed(false);
    setOpen(false);
    loadSample.mutate(key, {
      // PM/admin context stays on the program overview; carry the sample key so
      // the "Start exploring" callout renders on the landing page (issue 1054).
      onSuccess: (result) =>
        void navigate(`/programs/${result.program.id}/overview`, {
          state: { startExploringSample: result.sample_key },
        }),
      onError: () => setFailed(true),
    });
  };

  const multiple = (samples?.length ?? 0) > 1;
  const isHeader = variant === 'header';

  return (
    <div
      className={
        isHeader ? 'relative inline-flex flex-col items-end' : 'flex flex-col items-center'
      }
    >
      <button
        type="button"
        onClick={() => (multiple ? setOpen((v) => !v) : load())}
        disabled={loadSample.isPending}
        aria-haspopup={multiple ? 'menu' : undefined}
        aria-expanded={multiple ? open : undefined}
        className={
          isHeader
            ? `h-9 rounded-control border border-brand-primary px-4 text-sm font-medium text-brand-primary
               hover:bg-brand-primary-light
               focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
               disabled:opacity-60`
            : `h-10 rounded-control border border-brand-primary px-5 text-sm font-medium text-brand-primary
               hover:bg-brand-primary-light
               focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
               disabled:opacity-60`
        }
      >
        {loadSample.isPending ? 'Loading demo…' : 'Load demo data'}
        {multiple && !loadSample.isPending ? ' ▾' : ''}
      </button>

      {open && multiple && samples && (
        <ul
          role="menu"
          className={`${
            isHeader ? 'absolute right-0 top-full z-10' : ''
          } mt-2 w-80 overflow-hidden rounded-card border border-neutral-border bg-neutral-surface text-left shadow-pop`}
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
                  {sampleScale(s) ?? s.description}
                </span>
              </button>
            </li>
          ))}
          {/* The audit path, as a text link in the footer. Never a button: four
              filled Load actions are the point of this menu, and a fifth control
              competing with them would make the first-run action harder for the
              majority in order to serve the auditor. Opens in a new tab so the
              picker — and the program the user was about to create — survive the
              detour. */}
          <li role="none" className="border-t border-neutral-border bg-neutral-surface-raised">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5">
              <span className="text-xs text-neutral-text-secondary">Bundled JSON, Apache 2.0</span>
              <a
                role="menuitem"
                href="/settings/demo-data"
                target="_blank"
                rel="noopener"
                className="text-xs font-semibold text-brand-primary hover:underline
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
                  focus-visible:ring-offset-1 rounded-sm"
              >
                Inspect files ↗
              </a>
            </div>
          </li>
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
