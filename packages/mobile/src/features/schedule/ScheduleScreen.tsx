import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Screen } from '../../components/Screen';

/** Read-only Schedule (Gantt) view on phone. Placeholder until the canvas
 *  renderer (React Native Skia, ADR-0026 step 7) lands. */
export function ScheduleScreen(): ReactNode {
  return (
    <Screen testID="screen-schedule" title="Schedule" subtitle="Read-only critical-path view.">
      <Text>The canvas Schedule view arrives with the React Native Skia renderer.</Text>
    </Screen>
  );
}
