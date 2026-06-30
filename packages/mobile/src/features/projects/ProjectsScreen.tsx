import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Screen } from '../../components/Screen';

/** Project list — Sarah's entry point. Placeholder until the project feed +
 *  offline cache (#41) land. */
export function ProjectsScreen(): ReactNode {
  return (
    <Screen
      testID="screen-projects"
      title="Projects"
      subtitle="Programs and projects you can access."
    >
      <Text>Project list arrives with the offline data layer (#41).</Text>
    </Screen>
  );
}
