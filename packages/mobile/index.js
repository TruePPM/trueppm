// Bare React Native entry point. Registers the root component with the native
// AppRegistry. Gesture-handler must be imported before anything else so its
// native side initializes ahead of the navigation tree (React Navigation
// requirement). App is a named export (repo-wide named-export convention).
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';

import { App } from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
