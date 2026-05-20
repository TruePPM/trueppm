import { SettingsPageTitle } from '../SettingsShell';
import { MembersTab } from '../members/MembersTab';

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
      />

      <MembersTab />
    </div>
  );
}
