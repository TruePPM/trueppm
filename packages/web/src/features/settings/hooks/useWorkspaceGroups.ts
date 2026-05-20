/**
 * Stub hook — returns fixture workspace groups until
 * GET /api/v1/workspace/groups/ is implemented.
 */
export interface WorkspaceGroup {
  id: string;
  name: string;
  memberCount: number;
  projects: string[];
  lead: string;
  description: string;
}

export function useWorkspaceGroups() {
  const groups: WorkspaceGroup[] = [
    { id: 'propulsion',  name: 'Propulsion',  memberCount: 14, projects: ['Artemis IV', 'Vega Stage'],                lead: 'AK', description: 'Engine, valves, plumbing, thrust-vector control' },
    { id: 'stage',       name: 'Stage',        memberCount: 11, projects: ['Vega Stage'],                              lead: 'JM', description: 'Tank, structure, separation, recovery' },
    { id: 'avionics',    name: 'Avionics',     memberCount: 9,  projects: ['Orion', 'Artemis IV'],                     lead: 'SR', description: 'Flight computer, FW, comms, power dist.' },
    { id: 'groundops',   name: 'Ground Ops',   memberCount: 18, projects: ['Atlas Pad 39C', 'Polaris'],                lead: 'EL', description: 'Pad, GSE, range safety, ops procedures' },
    { id: 'power',       name: 'Power',        memberCount: 6,  projects: ['Helios', 'Polaris'],                       lead: 'MK', description: 'Solar arrays, batteries, regulation' },
    { id: 'fluids',      name: 'Fluids',       memberCount: 8,  projects: ['Neptune'],                                 lead: 'DT', description: 'Cryogenics, tank farm, transfer ops' },
    { id: 'ops',         name: 'Ops',          memberCount: 12, projects: ['Polaris'],                                 lead: 'RK', description: 'Launch ops, range, safety, ground crew' },
    { id: 'leadership',  name: 'Leadership',   memberCount: 4,  projects: ['all'],                                     lead: 'AK', description: 'Program leads — read access to every project' },
  ];

  return { groups, isLoading: false };
}
