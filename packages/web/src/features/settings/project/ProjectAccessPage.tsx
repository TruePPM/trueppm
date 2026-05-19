import { SettingsPageTitle } from '../SettingsShell';
import { MembersTab } from '../members/MembersTab';
import { InviteForm } from '../members/InviteForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_OWNER } from '@/lib/roles';

/** Project > Access settings page — wraps the real MembersTab and InviteForm. */
export function ProjectAccessPage() {
  const projectId = useProjectId();
  const { role: myRole } = useCurrentUserRole(projectId);
  const isOwner = myRole === ROLE_OWNER;

  return (
    <div>
      <SettingsPageTitle
        title="Access"
        subtitle="Who can see and edit this project. Per-project role overrides workspace role."
        action={
          isOwner && projectId ? (
            <InviteForm projectId={projectId} />
          ) : undefined
        }
      />

      <MembersTab />
    </div>
  );
}
