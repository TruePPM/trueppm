import { SettingsPageTitle } from '../SettingsShell';
import { useWorkspaceGroups } from '../hooks/useWorkspaceGroups';

const MEMBER_COLORS = ['#1C6B3A', '#C17A10', '#7C3AED', '#0EA5E9', '#DC2626', '#0F766E'];

function GroupCard({ group }: { group: { id: string; name: string; memberCount: number; projects: string[]; lead: string; description: string } }) {
  const abbrev = group.name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="rounded-lg border border-neutral-border bg-neutral-surface-raised p-3.5">
      <div className="flex items-start gap-2.5">
        {/* Group icon */}
        <span className="w-8 h-8 rounded-md bg-brand-primary-light text-brand-primary inline-flex items-center justify-center text-[13px] font-bold shrink-0">
          {abbrev}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-neutral-text-primary">{group.name}</div>
          <div className="text-[12px] text-neutral-text-secondary mt-0.5 leading-snug">{group.description}</div>
        </div>
        <span className="tppm-mono text-[11px] px-2 py-0.5 rounded bg-neutral-surface-sunken text-neutral-text-secondary font-semibold shrink-0">
          {group.memberCount} members
        </span>
      </div>

      {/* Member stack */}
      <div className="mt-3 flex items-center gap-3">
        <div className="flex">
          {Array.from({ length: Math.min(6, group.memberCount) }).map((_, i) => (
            <span
              key={i}
              className="rounded-full border-2 border-neutral-surface-raised inline-flex items-center justify-center text-white font-semibold"
              style={{
                width: 22, height: 22,
                marginLeft: i === 0 ? 0 : -6,
                background: MEMBER_COLORS[i % MEMBER_COLORS.length],
                fontSize: 9,
              }}
              aria-hidden="true"
            />
          ))}
          {group.memberCount > 6 && (
            <span
              className="rounded-full border-2 border-neutral-surface-raised bg-neutral-surface-sunken inline-flex items-center justify-center text-neutral-text-secondary font-bold"
              style={{ width: 22, height: 22, marginLeft: -6, fontSize: 9 }}
              aria-hidden="true"
            >
              +{group.memberCount - 6}
            </span>
          )}
        </div>

        <div className="w-px h-4 bg-neutral-border shrink-0" aria-hidden="true" />

        <span className="text-[11px] text-neutral-text-secondary flex items-center gap-1">
          Lead:{' '}
          <span
            className="w-[18px] h-[18px] rounded-full bg-brand-primary inline-flex items-center justify-center text-white font-bold"
            style={{ fontSize: 9 }}
            aria-hidden="true"
          >
            {group.lead}
          </span>
        </span>

        <div className="flex-1" />
        <span className="text-[11px] text-neutral-text-secondary">
          Access to{' '}
          <strong className="text-neutral-text-primary font-semibold">
            {group.projects[0] === 'all' ? 'all projects' : `${group.projects.length} project${group.projects.length !== 1 ? 's' : ''}`}
          </strong>
        </span>
      </div>

      {/* Project tags */}
      <div className="mt-2.5 flex flex-wrap gap-1">
        {group.projects.slice(0, 4).map((p) => (
          <span
            key={p}
            className="text-[11px] px-2 py-0.5 rounded border border-neutral-border/55 bg-neutral-surface-sunken text-neutral-text-secondary"
          >
            {p === 'all' ? 'All projects' : p}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Workspace > Groups & teams page. */
export function WorkspaceGroupsPage() {
  const { groups, isLoading } = useWorkspaceGroups();

  return (
    <div>
      <SettingsPageTitle
        title="Groups & teams"
        count={`${groups.length} groups`}
        subtitle="Groups bundle members. Use them to grant project access in bulk and to roll up resource capacity."
        action={
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded border border-neutral-border text-[13px] font-medium text-neutral-text-primary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
            >
              Sync from directory
            </button>
            <button
              type="button"
              className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              + Create group
            </button>
          </div>
        }
      />

      <div className="px-6 py-5">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3.5">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-32 rounded-lg bg-neutral-surface-raised border border-neutral-border animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3.5">
            {groups.map((g) => (
              <GroupCard key={g.id} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
