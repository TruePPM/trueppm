import { useId } from 'react';

export const SCOPE_ACCESS = ['read', 'propose', 'write'] as const;
export type ScopeAccess = (typeof SCOPE_ACCESS)[number];

const ACCESS_LABEL: Record<ScopeAccess, string> = {
  read: 'Read',
  propose: 'Propose',
  write: 'Write',
};

export interface ScopeColumn {
  /** Replaces the column's default name, e.g. "Dry run" for `propose`. */
  label?: string;
  /**
   * Why nobody can have this access yet, e.g. "Ships in 0.6". The reason is
   * printed in the header, every box is disabled and unchecked, and no cell
   * says "Never" or "Yes", whatever `areas` holds.
   */
  disabledReason?: string;
}

export interface ScopeArea {
  id: string;
  label: string;
  /** One line under the area name: what it covers. */
  covers?: string;
  /** Per access: granted or not. `null` means this area never offers it. */
  access: Record<ScopeAccess, boolean | null>;
}

export interface ScopeMatrixProps {
  /** Accessible name of the table, e.g. "What this agent may do". */
  label: string;
  areas: ScopeArea[];
  /** Per-column name and availability. */
  columns?: Partial<Record<ScopeAccess, ScopeColumn>>;
  /** Omit for a read-only matrix. */
  onChange?: (areaId: string, access: ScopeAccess, granted: boolean) => void;
}

/**
 * Pass 3 scope matrix (#4802): area x read / propose / write. Editable cells are
 * checkboxes in a 44px label; read-only cells state glyph and word. A cell the
 * area never offers says so, rather than looking like an unticked grant.
 */
export function ScopeMatrix({ label, areas, columns = {}, onChange }: ScopeMatrixProps) {
  const id = useId();
  const name = (a: ScopeAccess) => columns[a]?.label ?? ACCESS_LABEL[a];
  return (
    <table aria-label={label} className="w-full border-collapse text-sm text-p1-text-1">
      <thead>
        <tr className="border-b border-p1-hairline">
          <th scope="col" className="py-2 text-left text-xs font-medium text-p1-text-2">
            Area
          </th>
          {SCOPE_ACCESS.map((a) => (
            <th
              key={a}
              id={`${id}-${a}`}
              scope="col"
              className="w-20 py-2 text-xs font-medium text-p1-text-2"
            >
              {name(a)}
              {columns[a]?.disabledReason && (
                <span className="block font-normal">
                  <span aria-hidden="true">◌ </span>
                  {columns[a].disabledReason}
                </span>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {areas.map((area) => (
          <tr key={area.id} className="border-b border-p1-hairline">
            <th scope="row" className="h-11 text-left font-normal">
              {area.label}
              {area.covers && <span className="block text-xs text-p1-text-2">{area.covers}</span>}
            </th>
            {SCOPE_ACCESS.map((a) => {
              const unavailable = Boolean(columns[a]?.disabledReason);
              const granted = unavailable ? false : area.access[a];
              return (
                <td key={a} className="text-center">
                  {granted === null ? (
                    <span className="text-xs text-p1-text-2">Never</span>
                  ) : onChange ? (
                    <label className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded has-[:disabled]:cursor-default has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-p1-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-p1-surface-1">
                      <input
                        type="checkbox"
                        checked={granted}
                        disabled={unavailable}
                        onChange={(e) => onChange(area.id, a, e.target.checked)}
                        aria-label={`${area.label}: ${name(a)}`}
                        aria-describedby={unavailable ? `${id}-${a}` : undefined}
                        className="h-4 w-4 accent-[oklch(var(--p1-brand))] focus:outline-none"
                      />
                    </label>
                  ) : (
                    <span className={granted ? 'text-xs' : 'text-xs text-p1-text-2'}>
                      <span aria-hidden="true">{granted ? '✓ ' : '– '}</span>
                      {granted ? 'Yes' : 'No'}
                    </span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
