/// <reference types="vite/client" />

/**
 * Ambient declaration for the optional enterprise overlay package (ADR-0029).
 * The package is absent in community builds; main.tsx imports it dynamically
 * inside a try/catch so the absence is handled at runtime. This declaration
 * stops TypeScript from erroring on the module name without requiring the
 * package to be installed.
 */
declare module '@trueppm/enterprise-web' {
  // The enterprise package registers widgets on import as a side effect;
  // no exports are consumed by OSS code.
}
