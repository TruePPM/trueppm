// Bare RN babel config. NativeWind's JSX transform runs as a preset; the
// reanimated plugin MUST be listed last (it rewrites worklets and depends on
// every other transform having already run). NativeWind shares packages/web's
// Tailwind design tokens — see tailwind.config.js.
module.exports = {
  presets: [
    'module:@react-native/babel-preset',
    'nativewind/babel',
  ],
  plugins: [
    // Keep this entry last. Reanimated's babel plugin must run after all others.
    'react-native-reanimated/plugin',
  ],
};
