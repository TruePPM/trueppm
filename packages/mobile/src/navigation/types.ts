/**
 * Bottom-tab navigation spec (ADR-0026 §2). The five primary surfaces match the
 * web information architecture, ordered for one-handed reach on a phone with
 * the contributor's two most-frequent flows (Tasks, Time — Priya's core loop)
 * leftmost.
 *
 * Per-tab stack param lists are declared here as the typed contract feature
 * work fills in; the scaffold renders a single placeholder screen per tab.
 */
import type { NavigatorScreenParams } from '@react-navigation/native';

/** Tasks tab stack — "My Work" list → task detail. */
export type TasksStackParamList = {
  TasksList: undefined;
  TaskDetail: { taskId: string };
};

/** Time tab stack — weekly timesheet / quick-log (Priya's core flow). */
export type TimeStackParamList = {
  TimeEntry: undefined;
};

/** Projects tab stack — project list → project detail. */
export type ProjectsStackParamList = {
  ProjectsList: undefined;
  ProjectDetail: { projectId: string };
};

/** Schedule tab stack — read-only canvas Schedule view on phone. */
export type ScheduleStackParamList = {
  ScheduleView: { projectId?: string };
};

/** Settings tab stack — account, sync status, sign-out. */
export type SettingsStackParamList = {
  SettingsHome: undefined;
};

/** Root bottom-tab navigator. Each tab hosts its own native-stack navigator. */
export type RootTabParamList = {
  Tasks: NavigatorScreenParams<TasksStackParamList>;
  Time: NavigatorScreenParams<TimeStackParamList>;
  Projects: NavigatorScreenParams<ProjectsStackParamList>;
  Schedule: NavigatorScreenParams<ScheduleStackParamList>;
  Settings: NavigatorScreenParams<SettingsStackParamList>;
};

/** Stable test IDs shared between the tab bar and the Detox smoke flow. */
export const TAB_TEST_IDS: Record<keyof RootTabParamList, string> = {
  Tasks: 'tab-tasks',
  Time: 'tab-time',
  Projects: 'tab-projects',
  Schedule: 'tab-schedule',
  Settings: 'tab-settings',
};
