import type { ReactNode } from 'react';
import { StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// NativeWind global stylesheet (Tailwind layers compiled against the shared
// design tokens). Imported once for side effects; styling parity lives in
// tailwind.config.js + src/theme/tokens.ts.
import './theme/global.css';
import { RootTabs } from './navigation/RootTabs';

/**
 * App root. SCAFFOLD ONLY — this boots a five-tab navigation shell over
 * placeholder screens. `src/db`, `src/sync`, `src/api` and `src/auth` are typed
 * boundaries with no implementation behind them, and there are no native
 * projects, so nothing here can be built or installed. README.md states exactly
 * what is implemented and what is only a type; read it before quoting this
 * package's state.
 *
 * Provider order matters: GestureHandlerRootView is outermost (native
 * gesture system), then SafeAreaProvider (insets), then NavigationContainer.
 * The bare scaffold boots straight to the tab shell; auth gating is layered in
 * by the auth feature (ADR-0026 implementation order, step 4).
 */
export function App(): ReactNode {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="dark-content" />
        <NavigationContainer>
          <RootTabs />
        </NavigationContainer>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
