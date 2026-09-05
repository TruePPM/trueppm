import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { palette } from '../theme/tokens';

interface ScreenProps {
  /** Test handle for the screen root. Maps to Android `resource-id` /
   *  iOS `accessibilityIdentifier`; TalkBack and VoiceOver do NOT announce it. */
  testID: string;
  /** Screen title rendered in the header band. */
  title: string;
  /** Optional one-line description of the placeholder surface. */
  subtitle?: string;
  children?: ReactNode;
}

/**
 * Shared placeholder screen primitive for the scaffold. Wraps content in a
 * safe-area view (notch / gesture-bar aware) and renders a token-styled header.
 * Feature work replaces the placeholder body per surface; the header + testID
 * contract stays stable so screens stay addressable as features land.
 */
export function Screen({ testID, title, subtitle, children }: ScreenProps): ReactNode {
  return (
    <SafeAreaView testID={testID} style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        {/* accessibilityRole="header" gives TalkBack/VoiceOver heading
            navigation a target on every screen that uses this primitive. */}
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <View style={styles.body}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    backgroundColor: palette.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: palette.textPrimary,
  },
  subtitle: {
    marginTop: 4,
    fontSize: 14,
    color: palette.textSecondary,
  },
  body: {
    flex: 1,
    padding: 16,
  },
});
