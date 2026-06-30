import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Screen } from '../../components/Screen';

/** "My Work" task list — Priya's landing surface. Placeholder until the
 *  cross-project task feed + offline cache (#41) land. */
export function TasksScreen(): ReactNode {
  return (
    <Screen
      testID="screen-tasks"
      title="My Work"
      subtitle="Tasks assigned to you, across projects."
    >
      <Text>Task list arrives with the offline data layer (#41).</Text>
    </Screen>
  );
}
