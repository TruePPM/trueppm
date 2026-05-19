/**
 * Stub hook — returns fixture workspace settings until
 * GET /api/v1/workspace/ is implemented.
 */
export interface WorkspaceSettings {
  name: string;
  subdomain: string;
  timezone: string;
  fiscalYearStart: string;
  workWeek: boolean[]; // 7 elements, Mon-Sun
  defaultProjectView: string;
  allowGuests: boolean;
  publicSharing: boolean;
}

export function useWorkspaceSettings() {
  const data: WorkspaceSettings = {
    name: 'TrueScope Aerospace',
    subdomain: 'truescope',
    timezone: 'America/Los_Angeles',
    fiscalYearStart: 'April 1',
    workWeek: [true, true, true, true, true, false, false],
    defaultProjectView: 'Board',
    allowGuests: true,
    publicSharing: false,
  };
  return { data, isLoading: false };
}
