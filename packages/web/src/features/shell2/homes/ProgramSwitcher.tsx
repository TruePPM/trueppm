import { useId } from 'react';
import type { Program } from '@/api/types';

/**
 * Picks which program a home shows. It changes the VIEW only: nothing is stored,
 * so the server-resolved home (`landing.home_program`) is untouched (#4771).
 */
export function ProgramSwitcher({
  programs,
  value,
  onChange,
}: {
  programs: ReadonlyArray<Program>;
  value: string | null;
  onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-p1-text-2">
        Program
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 rounded-md border border-p1-hairline-strong bg-p1-surface-1 px-2 text-sm text-p1-text-1 focus:outline-none focus:ring-2 focus:ring-p1-focus"
      >
        {value === null && (
          <option value="" disabled>
            Choose a program
          </option>
        )}
        {programs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
