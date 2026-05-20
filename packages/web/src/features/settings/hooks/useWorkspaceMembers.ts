/**
 * Stub hook — returns fixture workspace members until
 * GET /api/v1/workspace/members/ is implemented.
 */
export interface WorkspaceMember {
  id: string;
  name: string;
  initials: string;
  color: string;
  email: string;
  role: string;
  groups: string[];
  projectCount: number;
  lastActive: string;
  status: 'active' | 'guest' | 'deactivated';
  sso: boolean;
  twoFa: boolean;
}

export interface PendingInvite {
  email: string;
  role: string;
  sentBy: string;
  sentAt: string;
}

export function useWorkspaceMembers() {
  const members: WorkspaceMember[] = [
    { id: '1', name: 'Anika Krishnan',  initials: 'AK', color: '#1C6B3A', email: 'anika.k@truescope.io', role: 'Admin',  groups: ['Propulsion', 'Leadership'], projectCount: 5, lastActive: '2m ago',      status: 'active',      sso: true,  twoFa: true  },
    { id: '2', name: 'Jordan Mehta',    initials: 'JM', color: '#C17A10', email: 'j.mehta@truescope.io',  role: 'PM',     groups: ['Stage'],                  projectCount: 3, lastActive: '12m ago',     status: 'active',      sso: true,  twoFa: true  },
    { id: '3', name: 'Sam Reyes',       initials: 'SR', color: '#7C3AED', email: 'sam@truescope.io',       role: 'Lead',   groups: ['Avionics'],               projectCount: 2, lastActive: '26m ago',     status: 'active',      sso: true,  twoFa: false },
    { id: '4', name: 'Erin Lai',        initials: 'EL', color: '#0EA5E9', email: 'elai@truescope.io',      role: 'Lead',   groups: ['Ground Ops'],             projectCount: 2, lastActive: '1h ago',      status: 'active',      sso: true,  twoFa: true  },
    { id: '5', name: 'Maya Kearns',     initials: 'MK', color: '#DC2626', email: 'maya.k@truescope.io',    role: 'Member', groups: ['Power'],                  projectCount: 1, lastActive: '3h ago',      status: 'active',      sso: true,  twoFa: true  },
    { id: '6', name: 'Devraj Tan',      initials: 'DT', color: '#0F766E', email: 'dtan@truescope.io',      role: 'Member', groups: ['Fluids'],                 projectCount: 2, lastActive: 'Yesterday',   status: 'active',      sso: true,  twoFa: true  },
    { id: '7', name: 'Riya Kapoor',     initials: 'RK', color: '#92400E', email: 'rk@truescope.io',        role: 'PM',     groups: ['Ops', 'Leadership'],      projectCount: 4, lastActive: 'Yesterday',   status: 'active',      sso: true,  twoFa: true  },
    { id: '8', name: 'Theo Vasquez',    initials: 'TV', color: '#475569', email: 'theo@truescope.io',      role: 'Member', groups: ['Ops'],                    projectCount: 2, lastActive: '3d ago',      status: 'active',      sso: false, twoFa: false },
    { id: '9', name: 'Park Choi',       initials: 'PC', color: '#7C3AED', email: 'pchoi@vendor.x',         role: 'Viewer', groups: ['Vendor: ValveCo'],        projectCount: 1, lastActive: '1w ago',      status: 'guest',       sso: false, twoFa: false },
    { id: '10', name: 'Lin Mae',        initials: 'LM', color: '#1C6B3A', email: 'linmae@truescope.io',    role: 'Member', groups: ['Avionics'],               projectCount: 1, lastActive: '2w ago',      status: 'deactivated', sso: true,  twoFa: true  },
  ];

  const pendingInvites: PendingInvite[] = [
    { email: 'ola.svenson@truescope.io', role: 'Lead',   sentBy: 'AK', sentAt: '2 days ago' },
    { email: 'j.lim@vendor.helios.com',  role: 'Viewer', sentBy: 'AK', sentAt: '5 days ago' },
    { email: 'compliance@faa.gov',       role: 'Viewer', sentBy: 'RK', sentAt: 'today'      },
  ];

  return { members, pendingInvites, isLoading: false };
}
