import { SettingsPageTitle } from '../SettingsShell';
import { MembersTab } from '../members/MembersTab';
import { FieldHelp } from '@/components/FieldHelp';

/**
 * Project > Access settings page — wraps the real MembersTab, which renders
 * the members list and the OWNER-gated invite form internally.
 */
export function ProjectAccessPage() {
  return (
    <div>
      <SettingsPageTitle
        title="Access"
        subtitle="Who can see and edit this project. Per-project role overrides workspace role."
        action={
          <FieldHelp
            label="Project access"
            body="Every member holds one of five project roles — Owner, Admin, Scheduler, Member, or Viewer — that sets what they can see and change. A per-project role overrides the person's workspace role. Owners invite new members by email. See the docs for the full permission matrix."
            docHref="administration/rbac"
          />
        }
      />

      <MembersTab />
    </div>
  );
}
