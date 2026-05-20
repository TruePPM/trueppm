import { SettingsPageTitle } from '../SettingsShell';

interface ProgramMember {
  initials: string;
  color: string;
  name: string;
  email: string;
  role: string;
  projects: number;
}

const ROLE_PALETTE: Record<string, { bg: string; text: string }> = {
  'Program Manager': { bg: 'bg-[#7C3AED]/10', text: 'text-[#7C3AED]' },
  PM:                { bg: 'bg-[#7C3AED]/10', text: 'text-[#7C3AED]' },
  Admin:             { bg: 'bg-brand-primary-light', text: 'text-brand-primary' },
  Scheduler:         { bg: 'bg-brand-accent-light', text: 'text-brand-accent-dark' },
  Member:            { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
  Viewer:            { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' },
};

const MEMBERS: ProgramMember[] = [
  { initials: 'AK', color: '#1C6B3A', name: 'Anika Krishnan',   email: 'anika@truescope.com',   role: 'Program Manager', projects: 4 },
  { initials: 'JT', color: '#C17A10', name: 'James Torres',     email: 'james@truescope.com',   role: 'Scheduler',       projects: 2 },
  { initials: 'SP', color: '#0EA5E9', name: 'Sofia Petrov',     email: 'sofia@truescope.com',   role: 'Member',          projects: 1 },
  { initials: 'MC', color: '#7C3AED', name: 'Marcus Chen',      email: 'marcus@truescope.com',  role: 'Member',          projects: 3 },
  { initials: 'LH', color: '#DC2626', name: 'Laila Hassan',     email: 'laila@truescope.com',   role: 'Member',          projects: 2 },
  { initials: 'RS', color: '#6B6965', name: 'Ravi Sharma',      email: 'ravi@truescope.com',    role: 'Viewer',          projects: 4 },
];

function RoleBadge({ role }: { role: string }) {
  const palette = ROLE_PALETTE[role] ?? { bg: 'bg-neutral-surface-sunken', text: 'text-neutral-text-secondary' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold ${palette.bg} ${palette.text}`}>
      {role}
    </span>
  );
}

/** Program > Access settings page. */
export function ProgramAccessPage() {
  return (
    <div>
      <SettingsPageTitle
        title="Access"
        count={`${MEMBERS.length} members`}
        subtitle="Who can see and manage this program. Program roles are separate from project roles."
        action={
          <button
            type="button"
            className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            + Add member
          </button>
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Table header */}
        <div
          className="grid items-center px-4 py-2 bg-neutral-surface-sunken border border-neutral-border rounded-t-lg text-[10px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mt-4"
          style={{ gridTemplateColumns: '1.8fr 1.2fr 110px 70px 130px 52px' }}
        >
          <span>Member</span>
          <span>Email</span>
          <span>Role</span>
          <span className="tppm-mono">Projects</span>
          <span>Change role</span>
          <span />
        </div>

        <div className="bg-neutral-surface-raised border-x border-b border-neutral-border rounded-b-lg overflow-hidden">
          {MEMBERS.map((m, i) => (
            <div
              key={m.email}
              className={['grid items-center px-4 py-2.5 text-[13px]', i < MEMBERS.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
              style={{ gridTemplateColumns: '1.8fr 1.2fr 110px 70px 130px 52px' }}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span
                  className="w-7 h-7 rounded-full inline-flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                  style={{ background: m.color }}
                  aria-hidden="true"
                >
                  {m.initials}
                </span>
                <span className="font-medium text-neutral-text-primary truncate">{m.name}</span>
              </span>
              <span className="text-[12px] text-neutral-text-secondary truncate">{m.email}</span>
              <RoleBadge role={m.role} />
              <span className="tppm-mono text-[12px] text-neutral-text-secondary">{m.projects}</span>
              <div className="relative">
                <select
                  defaultValue={m.role}
                  className="w-full h-7 pl-2 pr-7 rounded border border-neutral-border bg-neutral-surface-raised text-[12px] text-neutral-text-primary appearance-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                >
                  <option>Viewer</option>
                  <option>Member</option>
                  <option>Scheduler</option>
                  <option>Program Manager</option>
                </select>
                <svg className="pointer-events-none absolute right-2 top-2 text-neutral-text-secondary" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <button
                type="button"
                className="text-right text-neutral-text-secondary text-[18px] leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
                aria-label={`More options for ${m.name}`}
              >
                ···
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
