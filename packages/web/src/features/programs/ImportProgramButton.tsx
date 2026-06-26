import { useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { seedImportErrors, useImportProgramSeed } from '@/hooks/useProgramSeedIo';

interface ImportProgramButtonProps {
  /** Visual variant — header (compact, secondary) or empty-state (large). */
  variant?: 'header' | 'hero';
}

/**
 * "Import from JSON" affordance on the programs index (#615).
 *
 * Opens a native file picker, uploads the chosen seed file, and navigates to
 * the imported program on success. Validation failures (400 with a line-level
 * error report) are shown inline so the user can fix the file.
 */
export function ImportProgramButton({ variant = 'header' }: ImportProgramButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const importSeed = useImportProgramSeed();
  const [errors, setErrors] = useState<string[]>([]);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    setErrors([]);
    importSeed.mutate(file, {
      onSuccess: (program) => {
        void navigate(`/programs/${program.id}/overview`);
      },
      onError: (error) => {
        const detail = seedImportErrors(error);
        setErrors(
          detail.length > 0 ? detail : ['Import failed — please check the file and try again.'],
        );
      },
    });
  };

  const label = importSeed.isPending ? 'Importing…' : 'Import from JSON';
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
        disabled={importSeed.isPending}
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
    </div>
  );
}
