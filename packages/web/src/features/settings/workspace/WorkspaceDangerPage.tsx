import { SettingsPageTitle } from '../SettingsShell';
import { StubPageBanner } from '../components/StubPageBanner';

/** Workspace > Archive / Delete danger zone page. */
export function WorkspaceDangerPage() {
  return (
    <div>
      <StubPageBanner pageIssue={530} />
      <SettingsPageTitle
        title="Archive / Delete"
        subtitle="Irreversible workspace-wide actions. Each requires typed confirmation."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-4">
        {[
          {
            title: 'Export all data',
            description: 'Download a full archive (JSON + attachments) of all workspace data. The export takes up to 30 minutes and is sent to your email.',
            action: 'Export all data',
            destructive: false,
          },
          {
            title: 'Transfer ownership',
            description: 'Transfer workspace ownership to another Admin. You will be demoted to Admin role after transfer.',
            action: 'Transfer ownership…',
            destructive: false,
          },
          {
            title: 'Delete workspace',
            description: 'Permanently delete this workspace and all its data. This cannot be undone. All members will lose access immediately.',
            action: 'Delete workspace…',
            destructive: true,
          },
        ].map((item) => (
          <div
            key={item.title}
            className={[
              'rounded-lg border p-4',
              item.destructive
                ? 'border-semantic-critical bg-semantic-critical-bg'
                : 'border-neutral-border bg-neutral-surface-raised',
            ].join(' ')}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  className={[
                    'text-[14px] font-semibold',
                    item.destructive ? 'text-semantic-critical' : 'text-neutral-text-primary',
                  ].join(' ')}
                >
                  {item.title}
                </h2>
                <p className="text-[13px] text-neutral-text-secondary mt-1 leading-snug">{item.description}</p>
              </div>
              <button
                type="button"
                className={[
                  'shrink-0 px-3 py-1.5 rounded border text-[13px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
                  item.destructive
                    ? 'border-semantic-critical text-semantic-critical hover:bg-semantic-critical/5 focus-visible:ring-semantic-critical'
                    : 'border-neutral-border text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:ring-brand-primary',
                ].join(' ')}
              >
                {item.action}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
