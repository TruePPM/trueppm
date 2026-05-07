import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import { App } from './App';
import { applyFeatureFlagsFromUrl } from './lib/featureFlags';

applyFeatureFlagsFromUrl();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
