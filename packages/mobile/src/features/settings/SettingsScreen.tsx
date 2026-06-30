import type { ReactNode } from 'react';
import { Text } from 'react-native';

import { Screen } from '../../components/Screen';

/** Settings — account, sync status, sign-out. Placeholder until auth + sync
 *  status surfaces land. */
export function SettingsScreen(): ReactNode {
  return (
    <Screen
      testID="screen-settings"
      title="Settings"
      subtitle="Account, sync, and app preferences."
    >
      <Text>Account and sync settings arrive with the auth + sync layers.</Text>
    </Screen>
  );
}
