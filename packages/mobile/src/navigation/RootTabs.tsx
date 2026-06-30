import type { ReactNode } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { ProjectsScreen } from '../features/projects/ProjectsScreen';
import { ScheduleScreen } from '../features/schedule/ScheduleScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { TasksScreen } from '../features/tasks/TasksScreen';
import { TimeScreen } from '../features/time/TimeScreen';
import { palette } from '../theme/tokens';
import type {
  ProjectsStackParamList,
  RootTabParamList,
  ScheduleStackParamList,
  SettingsStackParamList,
  TasksStackParamList,
  TimeStackParamList,
} from './types';
import { TAB_TEST_IDS } from './types';

// One native-stack per tab. The scaffold registers each tab's root screen; the
// detail routes declared in the param lists are wired by feature work.
const TasksStack = createNativeStackNavigator<TasksStackParamList>();
const TimeStack = createNativeStackNavigator<TimeStackParamList>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParamList>();
const ScheduleStack = createNativeStackNavigator<ScheduleStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function TasksNavigator(): ReactNode {
  return (
    <TasksStack.Navigator screenOptions={{ headerShown: false }}>
      <TasksStack.Screen name="TasksList" component={TasksScreen} />
    </TasksStack.Navigator>
  );
}

function TimeNavigator(): ReactNode {
  return (
    <TimeStack.Navigator screenOptions={{ headerShown: false }}>
      <TimeStack.Screen name="TimeEntry" component={TimeScreen} />
    </TimeStack.Navigator>
  );
}

function ProjectsNavigator(): ReactNode {
  return (
    <ProjectsStack.Navigator screenOptions={{ headerShown: false }}>
      <ProjectsStack.Screen name="ProjectsList" component={ProjectsScreen} />
    </ProjectsStack.Navigator>
  );
}

function ScheduleNavigator(): ReactNode {
  return (
    <ScheduleStack.Navigator screenOptions={{ headerShown: false }}>
      <ScheduleStack.Screen name="ScheduleView" component={ScheduleScreen} />
    </ScheduleStack.Navigator>
  );
}

function SettingsNavigator(): ReactNode {
  return (
    <SettingsStack.Navigator screenOptions={{ headerShown: false }}>
      <SettingsStack.Screen name="SettingsHome" component={SettingsScreen} />
    </SettingsStack.Navigator>
  );
}

const Tab = createBottomTabNavigator<RootTabParamList>();

/**
 * Root bottom-tab shell. Tasks is the initial route (the contributor's most
 * frequent surface). Each tab button carries a stable `tabBarButtonTestID` the
 * Detox launch smoke (e2e/flows/app-launch.e2e.ts) targets.
 */
export function RootTabs(): ReactNode {
  return (
    <Tab.Navigator
      initialRouteName="Tasks"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: palette.sage,
        tabBarInactiveTintColor: palette.textTertiary,
      }}
    >
      <Tab.Screen
        name="Tasks"
        component={TasksNavigator}
        options={{ tabBarLabel: 'My Work', tabBarButtonTestID: TAB_TEST_IDS.Tasks }}
      />
      <Tab.Screen
        name="Time"
        component={TimeNavigator}
        options={{ tabBarLabel: 'Time', tabBarButtonTestID: TAB_TEST_IDS.Time }}
      />
      <Tab.Screen
        name="Projects"
        component={ProjectsNavigator}
        options={{ tabBarLabel: 'Projects', tabBarButtonTestID: TAB_TEST_IDS.Projects }}
      />
      <Tab.Screen
        name="Schedule"
        component={ScheduleNavigator}
        options={{ tabBarLabel: 'Schedule', tabBarButtonTestID: TAB_TEST_IDS.Schedule }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsNavigator}
        options={{ tabBarLabel: 'Settings', tabBarButtonTestID: TAB_TEST_IDS.Settings }}
      />
    </Tab.Navigator>
  );
}
