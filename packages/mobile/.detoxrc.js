/**
 * Detox configuration (scaffolded — NOT wired into CI in this MR).
 *
 * The PR-gated smoke flow is e2e/flows/app-launch.e2e.ts; the five ADR-0026
 * nightly flows are scaffolded alongside it and land green incrementally as
 * #41 (sync) and the feature screens arrive.
 *
 * The nightly `mobile:e2e:*` CI jobs are deferred: they need an
 * Android-emulator-capable (KVM) self-hosted runner and a macOS runner, plus a
 * `workflow:` carve-out for scheduled pipelines — none of which exist on the
 * current shared runners (cf. issues #29 / #30; ADR-0026 §Risks).
 *
 * Android (Pixel-6-class AVD) is the 0.4 baseline and required nightly; iOS sim
 * is best-effort in 0.4 (allow_failure) and required at 1.0 GA.
 */
/** @type {Detox.DetoxConfig} */
module.exports = {
  testRunner: {
    args: {
      $0: 'jest',
      config: 'e2e/jest.config.js',
    },
    jest: {
      setupTimeout: 120000,
    },
  },
  apps: {
    'android.debug': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      build:
        'cd android && ./gradlew :app:assembleDebug :app:assembleAndroidTest -DtestBuildType=debug && cd ..',
    },
    'android.release': {
      type: 'android.apk',
      binaryPath: 'android/app/build/outputs/apk/release/app-release.apk',
      build:
        'cd android && ./gradlew :app:assembleRelease :app:assembleAndroidTest -DtestBuildType=release && cd ..',
    },
    'ios.debug': {
      type: 'ios.app',
      binaryPath: 'ios/build/Build/Products/Debug-iphonesimulator/TruePPM.app',
      build:
        'xcodebuild -workspace ios/TruePPM.xcworkspace -scheme TruePPM -configuration Debug -sdk iphonesimulator -derivedDataPath ios/build',
    },
  },
  devices: {
    emulator: {
      type: 'android.emulator',
      device: { avdName: 'Pixel_6_API_34' },
    },
    simulator: {
      type: 'ios.simulator',
      device: { type: 'iPhone 15' },
    },
  },
  configurations: {
    'android.emu.debug': { device: 'emulator', app: 'android.debug' },
    'android.emu.release': { device: 'emulator', app: 'android.release' },
    'ios.sim.debug': { device: 'simulator', app: 'ios.debug' },
  },
};
