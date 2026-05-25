/**
 * Static fixture data for the program backlog.
 *
 * ADR-0069's API (#737) is not built yet, so the query hooks in `./hooks`
 * read from these fixtures. The shapes match the future API responses exactly
 * — when `#endpoints` lands, the hooks swap their `queryFn` to call the API
 * and these fixtures are deleted. Nothing in the components reaches in here.
 *
 * The data set mirrors the design canvas (`Program Backlog.html`): the ARTEMIS
 * program with 9 items (7 PROPOSED, 2 PULLED, 0 ARCHIVED) and 4 member
 * projects, so the toolbar reads "All 9 · Proposed 7 · Pulled 2 · Archived 0".
 */

import type { BacklogItem, BacklogMember, MemberProject } from './types';

export const FIXTURE_PROGRAM_ID = 'artemis';
export const FIXTURE_PROGRAM_NAME = 'Artemis Program';

export const BACKLOG_MEMBERS: BacklogMember[] = [
  { id: 'u-rk', name: 'Riya Kapoor', initials: 'RK' },
  { id: 'u-jm', name: 'Jonah Mercer', initials: 'JM' },
  { id: 'u-sr', name: 'Sam Reyes', initials: 'SR' },
  { id: 'u-dl', name: 'Diego Luna', initials: 'DL' },
];

export const MEMBER_PROJECTS: MemberProject[] = [
  { id: 'p-1', name: 'Artemis IV Lift', code: 'ARTM-1', color: '#1C6B3A', backlogCount: 12 },
  { id: 'p-2', name: 'Stage Build', code: 'ARTM-2', color: '#E8A020', backlogCount: 7 },
  { id: 'p-3', name: 'Avionics', code: 'ARTM-3', color: '#3B6CB0', backlogCount: 9 },
  { id: 'p-4', name: 'Ground Ops', code: 'ARTM-4', color: '#8B5CF6', backlogCount: 4 },
];

const NOW = '2026-05-25T10:00:00Z';

export const BACKLOG_ITEMS: BacklogItem[] = [
  {
    id: 'BI-001',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Crew safety review — second pass',
    description:
      'Re-run the crew safety review against the revised abort modes. Capture findings as discrete follow-ups before the next gate.',
    itemType: 'epic',
    status: 'PROPOSED',
    tags: ['safety', 'phase-2'],
    priorityRank: 1,
    assigneeId: 'u-rk',
    createdAt: '2026-05-10T09:00:00Z',
    updatedAt: '2026-05-20T09:00:00Z',
  },
  {
    id: 'BI-002',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Range licensing · Polaris coordination',
    description: 'Coordinate range licensing windows with the Polaris program.',
    itemType: 'story',
    status: 'PROPOSED',
    tags: ['external', 'blocking'],
    priorityRank: 2,
    assigneeId: 'u-jm',
    createdAt: '2026-05-11T09:00:00Z',
    updatedAt: '2026-05-19T09:00:00Z',
  },
  {
    id: 'BI-003',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Telemetry channel B (redundant link)',
    description:
      'Add a second, isolated telemetry link so a single radio fault no longer blacks out ground monitoring.',
    itemType: 'story',
    status: 'PROPOSED',
    tags: ['architecture'],
    priorityRank: 3,
    assigneeId: 'u-rk',
    createdAt: '2026-05-12T09:00:00Z',
    updatedAt: '2026-05-18T09:00:00Z',
  },
  {
    id: 'BI-004',
    programId: FIXTURE_PROGRAM_ID,
    title: 'FAT prep — instrumentation harness',
    description: 'Stand up the factory-acceptance-test harness ahead of the avionics delivery.',
    itemType: 'spike',
    status: 'PROPOSED',
    tags: ['avionics'],
    priorityRank: 4,
    assigneeId: 'u-sr',
    createdAt: '2026-05-13T09:00:00Z',
    updatedAt: '2026-05-17T09:00:00Z',
  },
  {
    id: 'BI-005',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Decommission legacy ground console',
    itemType: 'chore',
    status: 'PROPOSED',
    tags: ['ground', 'tech-debt'],
    priorityRank: 5,
    createdAt: '2026-05-14T09:00:00Z',
    updatedAt: '2026-05-16T09:00:00Z',
  },
  {
    id: 'BI-006',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Intermittent valve telemetry dropout',
    description:
      'Diagnose the dropout seen on the stage-2 propellant valve during the last hot-fire.',
    itemType: 'bug',
    status: 'PROPOSED',
    tags: ['stage-2'],
    priorityRank: 6,
    assigneeId: 'u-dl',
    createdAt: '2026-05-15T09:00:00Z',
    updatedAt: '2026-05-15T12:00:00Z',
  },
  {
    id: 'BI-007',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Weather-hold automation for launch director',
    itemType: 'story',
    status: 'PROPOSED',
    tags: ['ground'],
    priorityRank: 7,
    createdAt: '2026-05-16T09:00:00Z',
    updatedAt: '2026-05-16T09:00:00Z',
  },
  {
    id: 'BI-008',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Pad water-deluge capacity study',
    description: 'Model whether the existing deluge system covers the uprated thrust profile.',
    itemType: 'spike',
    status: 'PULLED',
    tags: ['ground', 'safety'],
    priorityRank: 8,
    assigneeId: 'u-sr',
    createdAt: '2026-05-08T09:00:00Z',
    updatedAt: NOW,
    pulledTo: {
      projectId: 'p-4',
      projectName: 'Ground Ops',
      taskId: 't-pad-deluge',
      at: NOW,
    },
  },
  {
    id: 'BI-009',
    programId: FIXTURE_PROGRAM_ID,
    title: 'Avionics bench power supply upgrade',
    itemType: 'chore',
    status: 'PULLED',
    tags: ['avionics'],
    priorityRank: 9,
    assigneeId: 'u-rk',
    createdAt: '2026-05-07T09:00:00Z',
    updatedAt: '2026-05-23T09:00:00Z',
    pulledTo: {
      projectId: 'p-3',
      projectName: 'Avionics',
      taskId: 't-bench-psu',
      at: '2026-05-23T09:00:00Z',
    },
  },
];
