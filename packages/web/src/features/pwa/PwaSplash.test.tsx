import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PwaSplash, SessionRestoreHold } from './PwaSplash';

describe('PwaSplash', () => {
  it('announces the session restore and stamps the app version', () => {
    render(<PwaSplash />);
    const splash = screen.getByRole('status', { name: 'Restoring your session' });
    expect(splash).toHaveTextContent('TruePPM');
    expect(splash).toHaveTextContent('Scheduling that tells the truth');
    expect(splash).toHaveTextContent(/v\S+ · restoring session/);
  });
});

describe('SessionRestoreHold', () => {
  it('renders the branded splash when installed (standalone)', () => {
    render(<SessionRestoreHold standalone />);
    expect(screen.getByTestId('pwa-splash')).toBeInTheDocument();
  });

  it('renders nothing in a browser tab, as before the PWA existed', () => {
    const { container } = render(<SessionRestoreHold standalone={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
