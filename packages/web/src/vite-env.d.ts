/// <reference types="vite/client" />

declare const __BUILD_SHA__: string;
declare const __APP_VERSION__: string;

/** Installed by public/boot-guard.js before the module entry runs (#4408). */
interface Window {
  __trueppmBootGuard?: { booted: () => void };
}
