import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MobileBacklogNotice } from './MobileBacklogNotice';

describe('MobileBacklogNotice (#4305)', () => {
  it('says the backlog is hidden, with a count, and offers a one-tap switch', async () => {
    const onSwitch = vi.fn();
    render(<MobileBacklogNotice count={3} onSwitchToQueue={onSwitch} />);
    expect(screen.getByRole('status')).toHaveTextContent('Backlog hidden on phone (3 items)');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to Queue' }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('uses the singular for one item', () => {
    render(<MobileBacklogNotice count={1} onSwitchToQueue={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('(1 item)');
  });

  it('renders nothing when there is no backlog to hide', () => {
    const { container } = render(<MobileBacklogNotice count={0} onSwitchToQueue={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
