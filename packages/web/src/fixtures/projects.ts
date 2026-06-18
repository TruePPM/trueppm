import type { Project } from '@/types';

export const FIXTURE_PROJECTS: Project[] = [
  { id: '1', name: 'Alpha Platform Upgrade', colorDot: '#3E8C6D', healthState: 'on-track', methodology: 'HYBRID', programId: null, openTaskCount: 12 },
  { id: '2', name: 'Beta Data Migration', colorDot: '#E8A020', healthState: 'at-risk', methodology: 'WATERFALL', programId: null, openTaskCount: 27 },
  { id: '3', name: 'Gamma Compliance Programme', colorDot: '#B91C1C', healthState: 'critical', methodology: 'WATERFALL', programId: null, openTaskCount: 41 },
  { id: '4', name: 'Delta Infrastructure', colorDot: '#6B6965', healthState: 'unknown', methodology: 'HYBRID', programId: null, openTaskCount: null },
  { id: '5', name: 'Epsilon Mobile Roll-out', colorDot: '#316F57', healthState: 'on-track', methodology: 'AGILE', programId: null, openTaskCount: 3 },
];
