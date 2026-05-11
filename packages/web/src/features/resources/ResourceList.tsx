import type { OrgResource } from '@/hooks/useResources';

interface Props {
  resources: OrgResource[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ResourceList({ resources, selectedId, onSelect }: Props) {
  if (resources.length === 0) {
    return (
      <p className="px-3 py-4 text-xs text-neutral-text-disabled">No resources found.</p>
    );
  }

  return (
    <ul aria-label="Resources" className="divide-y divide-neutral-border">
      {resources.map((r) => (
        <ResourceRow
          key={r.id}
          resource={r}
          isSelected={r.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  resource: OrgResource;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function ResourceRow({ resource, isSelected, onSelect }: RowProps) {
  const skillCount = resource.skills.length;

  return (
    <li>
      <button
        type="button"
        aria-pressed={isSelected}
        aria-label={`${resource.name}${resource.jobRole ? `, ${resource.jobRole}` : ''}, ${skillCount} skill${skillCount !== 1 ? 's' : ''}${resource.isDeleted ? ', deactivated' : ''}`}
        onClick={() => onSelect(resource.id)}
        className={[
          'w-full text-left px-3 py-2.5 flex items-start gap-3 transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset',
          isSelected
            ? 'bg-white/10 border-l-2 border-brand-primary'
            : 'border-l-2 border-transparent hover:bg-white/5',
          resource.isDeleted ? 'opacity-60' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/* Avatar placeholder */}
        <span
          aria-hidden="true"
          className="shrink-0 w-7 h-7 rounded-full bg-brand-primary/20 flex items-center justify-center text-xs font-semibold text-brand-primary mt-0.5"
        >
          {resource.name.charAt(0).toUpperCase()}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-neutral-text-primary truncate">
              {resource.name}
            </span>
            {resource.isDeleted && (
              <span className="shrink-0 text-xs px-1.5 py-0.5 rounded border border-neutral-border text-neutral-text-disabled">
                Deactivated
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-text-secondary truncate mt-0.5">
            {[resource.jobRole, resource.email].filter(Boolean).join(' · ')}
          </p>
          {skillCount > 0 && (
            <p className="text-xs text-neutral-text-disabled mt-0.5">
              {skillCount} skill{skillCount !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export function ResourceListSkeleton() {
  return (
    <ul aria-label="Loading resources" className="divide-y divide-neutral-border">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="px-3 py-2.5 flex items-start gap-3">
          <div className="w-7 h-7 rounded-full bg-neutral-border animate-pulse shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-32 rounded bg-neutral-border animate-pulse" aria-hidden="true" />
            <div className="h-3 w-48 rounded bg-neutral-border animate-pulse" aria-hidden="true" />
          </div>
        </li>
      ))}
    </ul>
  );
}
