import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted @font-face declarations (#2419) — imported BEFORE globals.css so the
// faces are registered before Tailwind's base layer sets `font-family`. Kept in its
// own file rather than prepended to globals.css: it is generated, and globals.css
// carries hand-aligned design tokens that must not be reformatted.
import './styles/fonts.css';
import './styles/globals.css';
import { App } from './App';
import { applyFeatureFlagsFromUrl } from './lib/featureFlags';
import { installChunkReloadHandler } from './lib/chunkReload';
import { getPendingWriteCount } from './hooks/useSyncStatus';
import { initWebVitals } from './lib/telemetry';

applyFeatureFlagsFromUrl();

// Deploy version skew (#4341): a missing hashed chunk reloads the page once.
installChunkReloadHandler({ pendingWriteCount: getPendingWriteCount });

// Opt-in, off-by-default client telemetry (issue #1901). No-op unless the
// operator configured a collector endpoint (see src/lib/telemetry.ts).
initWebVitals();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
