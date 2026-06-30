// Bare RN Metro config wrapped with NativeWind's transformer (resolves the
// global stylesheet against the shared Tailwind tokens) and Reanimated-friendly
// defaults from @react-native/metro-config. WatermelonDB's transformer is added
// by the sync follow-up (#41) when src/db is populated.
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withNativeWind } = require('nativewind/metro');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = mergeConfig(getDefaultConfig(__dirname), {});

module.exports = withNativeWind(config, { input: './src/theme/global.css' });
