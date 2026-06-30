import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Screen } from '../../components/Screen';

/** Time entry — Priya's core offline flow (log from the train). Placeholder
 *  until the time-entry write path + offline outbox (#41) land. */
export function TimeScreen(): ReactNode {
  return (
    <Screen
      testID="screen-time"
      title="Time"
      subtitle="Log time against your tasks — works offline."
    >
      <Text>Time entry arrives with the offline write/outbox layer (#41).</Text>
    </Screen>
  );
}
