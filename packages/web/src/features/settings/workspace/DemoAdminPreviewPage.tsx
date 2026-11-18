/**
 * Read-only demo: a static preview of the admin screens (#3973).
 *
 * The hosted demo signs every visitor in as a Member (ADR-1197 D5 — the seed creates no
 * elevated account, by design, because a public instance must not publish an
 * admin-level credential). That makes invites, role management and workspace settings
 * invisible to an evaluator. This page closes that gap *without* a second account and
 * without calling the API.
 *
 * **Why writes cannot happen from here.** The page makes no request at all: every row
 * is a literal below, every control is a non-interactive illustration (`disabled` /
 * `aria-disabled`, no handlers), and the route renders nothing unless the deployment
 * itself reports `demo_read_only`. The roles matrix is the real, already-static
 * reference page. The server-side fence (ADR-1197 D2) still refuses every unsafe
 * method regardless, so even a hand-crafted request from this page's origin cannot
 * write.
 *
 * Sample people are fictional and are labeled as such — a preview of an access-review
 * surface must never read as real roster data.
 */
import { Navigate } from 'react-router';
import { useDemoMode } from '@/hooks/useDemoMode';
import { SettingsPageTitle } from '../SettingsShell';
import { WorkspaceRolesPage } from './WorkspaceRolesPage';

const SAMPLE_MEMBERS = [
  { name: 'Dana Whitfield', email: 'dana@example.com', role: 'Owner' },
  { name: 'Priya Raman', email: 'priya@example.com', role: 'Admin' },
  { name: 'Tomas Berg', email: 'tomas@example.com', role: 'Scheduler' },
  { name: 'Lena Okafor', email: 'lena@example.com', role: 'Member' },
  { name: 'Sam Ortiz', email: 'sam@example.com', role: 'Viewer' },
] as const;

const SAMPLE_INVITES = [
  { email: 'new.hire@example.com', role: 'Member', sent: 'Sent 2 days ago' },
  { email: 'auditor@example.com', role: 'Viewer', sent: 'Sent 6 days ago' },
] as const;

const SAMPLE_SETTINGS = [
  { label: 'Workspace name', value: 'Acme Delivery Office' },
  { label: 'Default calendar', value: 'Mon-Fri, 8h' },
  { label: 'Default methodology', value: 'Hybrid' },
  { label: 'Allowed email domains', value: 'example.com' },
] as const;

const SECTION = 'rounded-card border border-neutral-border bg-neutral-surface-raised';
const TH = 'px-4 py-2 text-left text-[12px] font-semibold text-neutral-text-secondary';
const TD = 'px-4 py-2 text-[13px] text-neutral-text-primary';
const DISABLED_BTN =
  'h-8 px-3 rounded-control border border-neutral-border bg-neutral-surface-sunken text-[12px] font-semibold text-neutral-text-disabled cursor-not-allowed';

export function DemoAdminPreviewPage() {
  // Read whole (a withdrawal, rule 379): `useDemoMode` already folds a failed read into
  // "not a demo", so there is no error surface to render here.
  const demo = useDemoMode();
  // A withdrawal, like the demo bar: unsettled and "not a demo" both render nothing,
  // and a normal install is sent home — the real screens live at /settings.
  if (demo.isLoading) return null;
  if (!demo.isDemoReadOnly) return <Navigate to="/" replace />;

  return (
    <main aria-labelledby="demo-admin-preview-title" data-testid="demo-admin-preview">
      <div
        role="note"
        data-testid="demo-admin-preview-banner"
        className="border-b border-brand-primary/30 bg-brand-primary/10 px-6 py-3 text-[13px] text-brand-primary"
      >
        <strong>Static preview.</strong> This is what a workspace admin sees. The people below
        are fictional sample data, controls that change data are not active, and nothing on this page is
        saved. You are signed in as a Member, so the real admin screens are not available to
        you.
      </div>

      <h1 id="demo-admin-preview-title" className="px-6 pt-5 text-[20px] font-semibold">
        Admin screens preview
      </h1>

      <section aria-label="Members and invites" className="px-6 pt-4">
        <SettingsPageTitle
          title="Members and invites"
          subtitle="Who has access to this workspace, and what they can do."
          action={
            <button type="button" disabled aria-disabled="true" className={DISABLED_BTN}>
              Invite member
            </button>
          }
        />
        <div className={SECTION}>
          <table className="w-full" aria-label="Sample workspace members">
            <thead>
              <tr>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Email</th>
                <th scope="col" className={TH}>Role</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_MEMBERS.map((m) => (
                <tr key={m.email} className="border-t border-neutral-border">
                  <td className={TD}>{m.name}</td>
                  <td className={TD}>{m.email}</td>
                  <td className={TD}>{m.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="pt-4 pb-2 text-[13px] font-semibold">Pending invites</h3>
        <ul className={`${SECTION} divide-y divide-neutral-border`}>
          {SAMPLE_INVITES.map((i) => (
            <li key={i.email} className={`${TD} flex items-center justify-between`}>
              <span>
                {i.email} <span className="text-neutral-text-secondary">as {i.role}</span>
              </span>
              <span className="text-[12px] text-neutral-text-secondary">{i.sent}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Workspace settings" className="px-6 pt-8">
        <SettingsPageTitle
          title="Workspace settings"
          subtitle="Defaults every new project inherits."
        />
        <dl className={`${SECTION} divide-y divide-neutral-border`}>
          {SAMPLE_SETTINGS.map((s) => (
            <div key={s.label} className={`${TD} flex items-center justify-between`}>
              <dt className="text-neutral-text-secondary">{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="Roles and permissions" className="pt-8">
        <WorkspaceRolesPage />
      </section>
    </main>
  );
}
