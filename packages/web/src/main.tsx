import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';

// Attempt to load the enterprise overlay. This import resolves only when the
// @trueppm/enterprise-web npm package is installed (enterprise deployments).
// In community builds the dynamic import fails silently — no enterprise
// widgets are registered and the OSS shell runs unchanged (ADR-0029).
try {
  await import('@trueppm/enterprise-web');
} catch {
  // Community edition — no enterprise widgets registered.
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
