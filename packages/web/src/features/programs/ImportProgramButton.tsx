import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  seedImportErrors,
  seedReplaceConflict,
  useImportProgramSeed,
  useProgramImportStatus,
  type ImportProgramSeedInput,
  type SeedReplaceConflict,
} from '@/hooks/useProgramSeedIo';
import { SeedReplaceConfirmDialog } from '@/components/import/SeedReplaceConfirmDialog';

interface ImportProgramButtonProps {
  /** Visual variant — header (compact, secondary) or empty-state (large). */
  variant?: 'header' | 'hero';
}

const GENERIC_FAILURE = 'Import failed — please check the file and try again.';

/**
 * "Import from JSON" affordance on the programs index (#615, #2574, #2581).
 *
 * Opens a native file picker, uploads the chosen seed file, and navigates to the
 * imported program. Three server answers are distinct outcomes and are handled
 * as such:
 * - **`400`** — a line-level validation report, shown inline so the user can fix
 *   the file;
 * - **`409`** — a live program of theirs already holds this seed's slug. That is
 *   a question, not a failure, so it becomes a confirmation dialog and the file
 *   is re-submitted with the compare-and-swap token from the refusal;
 * - **`202`** — the program shell exists, its subtree is building. The job is
 *   polled to a terminal state so a background failure cannot land the user on a
 *   half-built program with no explanation (ADR-0726 §6).
 */
export function ImportProgramButton({ variant = 'header' }: ImportProgramButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const importSeed = useImportProgramSeed();
  const [errors, setErrors] = useState<string[]>([]);
  const [conflict, setConflict] = useState<SeedReplaceConflict | null>(null);
  // Held across the 409 so the confirmation can re-submit the very same bytes —
  // the file input has already been cleared to allow re-picking after a fix.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [job, setJob] = useState<{ programId: string; jobId: string } | null>(null);

  const jobQuery = useProgramImportStatus(job?.programId, job?.jobId);
  const jobStatus = jobQuery.data?.status;
  const jobError = jobQuery.data?.error_detail;

  useEffect(() => {
    if (!job) return;
    if (jobStatus === 'success') {
      void navigate(`/programs/${job.programId}/overview`);
    } else if (jobStatus === 'failed') {
      setJob(null);
      setErrors([jobError || GENERIC_FAILURE]);
    }
  }, [job, jobStatus, jobError, navigate]);

  const submit = (input: ImportProgramSeedInput) => {
    setErrors([]);
    importSeed.mutate(input, {
      onSuccess: (queued) => {
        setJob({ programId: queued.program_id, jobId: queued.import_request_id });
      },
      onError: (error) => {
        const replaces = seedReplaceConflict(error);
        if (replaces) {
          setConflict(replaces);
          return;
        }
        const detail = seedImportErrors(error);
        setErrors(detail.length > 0 ? detail : [GENERIC_FAILURE]);
      },
    });
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setPendingFile(file);
    submit({ file });
  };

  const confirmReplace = () => {
    if (!pendingFile || !conflict) return;
    const expectedProgramId = conflict.program_id;
    setConflict(null);
    submit({ file: pendingFile, replace: true, expectedProgramId });
  };

  const building = job !== null;
  const busy = importSeed.isPending || building;
  const label = importSeed.isPending ? 'Importing…' : building ? 'Building…' : 'Import from JSON';
  const className =
    variant === 'header'
      ? `h-9 rounded-control border border-neutral-border px-4 text-sm font-medium text-neutral-text-primary
         hover:bg-neutral-surface-raised
         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
         disabled:opacity-60`
      : `h-10 rounded-control border border-neutral-border px-5 text-sm font-medium text-neutral-text-primary
         hover:bg-neutral-surface-raised
         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
         disabled:opacity-60`;

  return (
    <div
      className={
        variant === 'hero' ? 'flex flex-col items-center' : 'inline-flex flex-col items-end'
      }
    >
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className={className}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        onChange={onPick}
        className="hidden"
        aria-label="Program seed JSON file"
        data-testid="program-seed-file-input"
      />
      {building && (
        <p role="status" className="mt-3 text-xs text-neutral-text-secondary">
          Building the imported program…
        </p>
      )}
      {errors.length > 0 && (
        <div
          role="alert"
          className="mt-3 max-w-md rounded-card border border-semantic-critical/40 bg-semantic-critical-bg p-3 text-left"
        >
          <p className="text-sm font-medium text-semantic-critical">Could not import this file:</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-neutral-text-secondary">
            {errors.slice(0, 8).map((message) => (
              <li key={message}>{message}</li>
            ))}
            {errors.length > 8 && <li>…and {errors.length - 8} more.</li>}
          </ul>
        </div>
      )}
      {conflict && (
        <SeedReplaceConfirmDialog
          conflict={conflict}
          onCancel={() => setConflict(null)}
          onConfirm={confirmReplace}
        />
      )}
    </div>
  );
}
