import type { Project } from '@/types';

export const FIXTURE_PROJECTS: Project[] = [
  { id: '1', name: 'Alpha Platform Upgrade', colorDot: '#1C6B3A', healthState: 'on-track', methodology: 'HYBRID' },
  { id: '2', name: 'Beta Data Migration', colorDot: '#E8A020', healthState: 'at-risk', methodology: 'WATERFALL' },
  { id: '3', name: 'Gamma Compliance Programme', colorDot: '#B91C1C', healthState: 'critical', methodology: 'WATERFALL' },
  { id: '4', name: 'Delta Infrastructure', colorDot: '#6B6965', healthState: 'unknown', methodology: 'HYBRID' },
  { id: '5', name: 'Epsilon Mobile Roll-out', colorDot: '#145229', healthState: 'on-track', methodology: 'AGILE' },
];
